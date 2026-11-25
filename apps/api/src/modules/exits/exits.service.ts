import { Prisma } from '@prisma/client'
import { assertMasters, masterLabels } from '../masters/masters.service'
import { prisma } from '../../infrastructure/database/prisma'
import { eventBus } from '../../infrastructure/events/eventBus'
import { notify, userIdsWithRole, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { revokeUserAccess } from '../../infrastructure/auth/revoke'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { dateOnly, monthRange, businessToday } from '../../shared/utils/businessDate'
import { computeEmployeePayslip } from '../payroll/payroll.service'
import { generatePayslipPdf } from '../payroll/payslip.pdf'
import { CONTRACT_TRANSITIONS, ContractStatus } from '../employees/contracts.types'
import { leaveRepository } from '../leave/leave.repository'
import { closeApproval } from '../approvals/approvals.service'
import { hasFeature } from '../company/plans.catalog'
import { renderSettlementHtml } from './exits.pdf'
import { computeGratuity, statutoryFor } from '../tax/statutory'
import { DEPARTMENTS } from './exits.schema'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
// The payroll engine returns payslip lines as { create: [...] } for Postgres and as a plain array on MongoDB (lines are embedded)
const payslipLines = (p: any): any[] => (Array.isArray(p.lines) ? p.lines : p.lines.create)
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000)
const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`

// ponytail: one divisor for every per-day rate (basic ÷ 30); gratuity uses its own statutory divisor
const DAYS_PER_MONTH = 30
const STAFF = ['hr_admin', 'payroll_admin']
// requested: the employee handed in a resignation and HR has not answered; the rest are the settlement steps
const OPEN = ['requested', 'initiated', 'computed', 'approved']
type Dept = (typeof DEPARTMENTS)[number]
type Clearance = { IT: string; FINANCE: string; ADMIN: string; MANAGER?: string }

export interface SettlementLine {
  section: 'salary' | 'reimbursement' | 'encashment' | 'notice' | 'recovery' | 'gratuity'
  kind: 'earning' | 'deduction'
  code: string
  name: string
  amount: number
  quantity?: number
  formula?: string
  sourceRefType?: string
  sourceRefId?: string
}

const exitInclude = {
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, userId: true, managerId: true, active: true } },
  clearances: { orderBy: { department: 'asc' } },
} as const

async function audit(user: AccessUser, action: string, exitId: string, newValue?: Prisma.InputJsonValue) {
  await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action, entityType: 'employee_exit', entityId: exitId, newValue } })
}

const isStaff = (user: AccessUser) => user.roleIds.some((r) => STAFF.includes(r))

// Staff, or a user assigned one of this exit's sign-offs. Anyone else gets a 404.
async function loadVisible(id: string, user: AccessUser) {
  const exit = await prisma.employeeExit.findFirst({ where: { id, tenantId: user.tenantId }, include: exitInclude })
  if (!exit) throw new AppError('Exit not found', 404)
  if (!isStaff(user) && !exit.clearances.some((c) => c.responsibleUserId === user.userId)) throw new AppError('Exit not found', 404)
  return exit
}

// The settlement's amounts are pay: only Payroll admins see them (HR and sign-off owners see the status)
function hidePay<T extends Record<string, any>>(exit: T, user: AccessUser): T {
  if (user.roleIds.includes('payroll_admin')) return exit
  return { ...exit, lines: null, warnings: null, totalEarnings: null, totalDeductions: null, netPayable: null }
}

async function transition(id: string, tenantId: string, from: string[], data: Prisma.EmployeeExitUncheckedUpdateManyInput) {
  const res = await prisma.employeeExit.updateMany({ where: { id, tenantId, status: { in: from } }, data })
  if (res.count === 0) throw new AppError(`This exit is no longer ${from.join(' or ')}`, 409)
}

// One user per sign-off, all different, active, and never the person leaving. MANAGER defaults to the direct manager.
async function assigneesFor(tenantId: string, employee: { userId: string; manager?: { userId: string } | null }, clearance: Clearance): Promise<Record<Dept, string>> {
  const assignees = { ...clearance, MANAGER: clearance.MANAGER ?? employee.manager?.userId }
  if (!assignees.MANAGER) throw new AppError('The employee has no manager on record: assign the MANAGER clearance to a user', 400)
  const ids = DEPARTMENTS.map((d) => assignees[d]!)
  if (new Set(ids).size !== ids.length) throw new AppError('Each clearance must be signed off by a different user', 400)
  if (ids.includes(employee.userId)) throw new AppError('The exiting employee cannot sign off their own clearance', 400)
  const users = await prisma.user.count({ where: { id: { in: ids }, tenantId, active: true } })
  if (users !== ids.length) throw new AppError('Every clearance user must be an active user of this organisation', 400)
  return assignees as Record<Dept, string>
}

// Notice period comes from the contract in force on the last working day; short notice is recovered when the employee ended it and bought out when the employer did
async function noticeFor(tenantId: string, employeeId: string, noticeDate: Date, lastWorkingDate: Date, exitType: string, shortfallAction?: 'recover' | 'buyout' | 'waive') {
  const contract = await prisma.employeeContract.findFirst({
    where: { employeeId, active: true, status: 'running', effectiveFrom: { lte: lastWorkingDate } },
    orderBy: { effectiveFrom: 'desc' },
  })
  const noticePeriodDays = contract?.noticePeriodDays ?? 0
  const noticeServedDays = daysBetween(noticeDate, lastWorkingDate)
  const shortfallDays = Math.max(0, noticePeriodDays - noticeServedDays)
  await assertMasters(tenantId, { exit_type: exitType })
  const endedBy = ((await masterLabels(tenantId, 'exit_type')).get(exitType)?.meta as any)?.endedBy ?? (exitType === 'resignation' ? 'employee' : 'employer')
  return { contractId: contract?.id ?? null, noticePeriodDays, noticeServedDays, shortfallDays, shortfallAction: shortfallAction ?? (endedBy === 'employee' ? 'recover' : 'buyout') }
}

// Tell each sign-off owner (and the manager, when someone else holds that sign-off) that an exit is waiting
async function tellClearanceOwners(tenantId: string, exitId: string, employee: { firstName: string; lastName: string; manager?: { userId: string } | null }, assignees: Record<Dept, string>, lastWorkingDate: Date, byUserId: string) {
  const name = fullName(employee)
  const label: Record<Dept, string> = { IT: 'IT (assets and accounts)', FINANCE: 'Finance (advances and dues)', ADMIN: 'Admin (ID card and facilities)', MANAGER: 'Manager (handover)' }
  for (const d of DEPARTMENTS) {
    if (assignees[d] === byUserId) continue
    await notify({ tenantId, userIds: [assignees[d]], type: 'exit.clearance_assigned', title: `Sign-off needed: ${name} is leaving`, body: `Your ${label[d]} sign-off is waiting. Last working day ${ymd(lastWorkingDate)}.`, link: `/exits/${exitId}`, entityType: 'employee_exit', entityId: exitId })
  }
  const mgr = employee.manager?.userId
  if (mgr && !Object.values(assignees).includes(mgr) && mgr !== byUserId) {
    await notify({ tenantId, userIds: [mgr], type: 'exit.initiated', title: `${name} is leaving`, body: `Last working day ${ymd(lastWorkingDate)}. HR has started their exit.`, link: '/exits', entityType: 'employee_exit', entityId: exitId })
  }
}

// An employee's last working day: leave they asked for after it, or pending now, is called off (the days go back to their balance)
async function callOffLeave(tenantId: string, employeeId: string, after: Date, everyPending = false) {
  const rows = await prisma.leaveRequest.findMany({
    where: { employeeId, employee: { tenantId }, OR: [everyPending ? { status: 'pending' } : { status: 'pending', startDate: { gt: after } }, { status: 'approved', startDate: { gt: after } }] },
  })
  for (const r of rows) {
    const was = r.status
    await leaveRepository.updateRequestStatus(r.id, 'cancelled')
    await closeApproval(tenantId, 'leave', r.id)
    await leaveRepository.updateBalance(employeeId, r.leaveTypeId, was === 'pending' ? { pendingDays: -r.totalDays } : { usedDays: -r.totalDays })
    await prisma.auditLog.create({ data: { tenantId, userId: null as any, action: 'LEAVE_CANCELLED_EXIT', entityType: 'leave_request', entityId: r.id, newValue: { employeeId, was } } })
  }
  return rows.length
}

// The recovery note for a negative settlement lives in the audit log (no new column): latest entry wins
async function latestRecovery(exitId: string, tenantId: string) {
  const r = await prisma.auditLog.findFirst({ where: { tenantId, entityType: 'employee_exit', entityId: exitId, action: 'FNF_RECOVERY_RECORDED' }, orderBy: { createdAt: 'desc' } })
  return r ? { note: (r.newValue as any)?.note as string, recoveredAmount: (r.newValue as any)?.recoveredAmount as number | null, waived: !!(r.newValue as any)?.waived, by: r.userId, at: r.createdAt } : null
}
const negative = (exit: { netPayable: unknown }) => exit.netPayable != null && Number(exit.netPayable) < 0
async function assertRecoveryRecorded(exit: { id: string; netPayable: unknown }, tenantId: string, doing: string) {
  if (negative(exit) && !(await latestRecovery(exit.id, tenantId))) {
    throw new AppError(`This settlement is negative: the employee owes money. Record how it is recovered (or that it is waived) before you ${doing}.`, 409, 'RECOVERY_REQUIRED')
  }
}

export const exitsService = {
  async initiate(user: AccessUser, body: {
    employeeId: string; exitType: string; reason: string; noticeDate: string; lastWorkingDate: string; backdated?: boolean
    shortfallAction?: 'recover' | 'buyout' | 'waive'; clearance: Clearance
  }) {
    const { tenantId } = user
    const employee = await prisma.employee.findFirst({
      where: { id: body.employeeId, tenantId, active: true },
      include: { manager: { select: { userId: true } } },
    })
    if (!employee) throw new AppError('Employee not found', 404)

    const noticeDate = dateOnly(body.noticeDate)
    const lastWorkingDate = dateOnly(body.lastWorkingDate)
    if (lastWorkingDate < noticeDate) throw new AppError('Last working day cannot be before the notice date', 400)
    if (lastWorkingDate < employee.hireDate) throw new AppError('Last working day cannot be before the hire date', 400)
    // A last day that has already passed means the person has already left: HR confirms that on purpose
    if (lastWorkingDate < (await businessToday(tenantId)) && !body.backdated) {
      throw new AppError('This last working day is in the past, so the exit is backdated. Tick "The person has already left" to confirm.', 400, 'BACKDATED_EXIT')
    }

    const open = await prisma.employeeExit.findFirst({ where: { tenantId, employeeId: employee.id, status: { in: OPEN } } })
    if (open) throw new AppError(open.status === 'requested' ? 'This employee has handed in a resignation that is waiting for you. Accept or decline it.' : 'This employee already has an exit in progress', 409)

    const assignees = await assigneesFor(tenantId, employee, body.clearance)
    const n = await noticeFor(tenantId, employee.id, noticeDate, lastWorkingDate, body.exitType, body.shortfallAction)

    const exit = await prisma.employeeExit.create({
      data: {
        tenantId, employeeId: employee.id, contractId: n.contractId, exitType: body.exitType, reason: body.reason,
        noticeDate, lastWorkingDate, noticePeriodDays: n.noticePeriodDays, noticeServedDays: n.noticeServedDays, shortfallDays: n.shortfallDays, shortfallAction: n.shortfallAction, initiatedBy: user.userId,
        clearances: { create: DEPARTMENTS.map((department) => ({ department, responsibleUserId: assignees[department] })) },
      },
      include: exitInclude,
    })
    await prisma.employee.update({ where: { id: employee.id }, data: { exitDate: lastWorkingDate, exitReason: body.reason } })

    await audit(user, 'EXIT_INITIATED', exit.id, { exitType: body.exitType, lastWorkingDate: body.lastWorkingDate, noticePeriodDays: n.noticePeriodDays, shortfallDays: n.shortfallDays, shortfallAction: n.shortfallAction, ...(body.backdated && { backdated: true }) })
    await eventBus.publish(tenantId, 'exit.initiated', {
      exitId: exit.id, employeeId: employee.id, exitType: body.exitType, lastWorkingDate: body.lastWorkingDate, initiatedBy: user.userId,
    })
    await tellClearanceOwners(tenantId, exit.id, employee, assignees, lastWorkingDate, user.userId)
    return exit
  },

  // The employee hands in their own resignation: HR accepts it (and sets the sign-offs) or declines it with a reason
  async resign(user: AccessUser, body: { reason: string; lastWorkingDate?: string }) {
    const { tenantId } = user
    if (!user.employeeId) throw new AppError('Only employees can hand in a resignation', 403)
    const employee = await prisma.employee.findFirst({ where: { id: user.employeeId, tenantId, active: true } })
    if (!employee) throw new AppError('Employee not found', 404)
    const open = await prisma.employeeExit.findFirst({ where: { tenantId, employeeId: employee.id, status: { in: OPEN } } })
    if (open) throw new AppError(open.status === 'requested' ? 'Your resignation is already with HR' : 'An exit is already in progress for you', 409)
    const noticeDate = await businessToday(tenantId)
    // Proposed last day: the contract's notice period from today, or the date the employee suggests (HR can change it when accepting)
    const contract = await prisma.employeeContract.findFirst({ where: { employeeId: employee.id, active: true, status: 'running', effectiveFrom: { lte: noticeDate } }, orderBy: { effectiveFrom: 'desc' } })
    const proposed = body.lastWorkingDate ? dateOnly(body.lastWorkingDate) : new Date(noticeDate.getTime() + (contract?.noticePeriodDays ?? 0) * 86_400_000)
    if (proposed < noticeDate) throw new AppError('The last working day cannot be in the past', 400)
    if (proposed < employee.hireDate) throw new AppError('The last working day cannot be before your hire date', 400)
    const n = await noticeFor(tenantId, employee.id, noticeDate, proposed, 'resignation')
    const exit = await prisma.employeeExit.create({
      data: { tenantId, employeeId: employee.id, contractId: n.contractId, exitType: 'resignation', reason: body.reason, noticeDate, lastWorkingDate: proposed, noticePeriodDays: n.noticePeriodDays, noticeServedDays: n.noticeServedDays, shortfallDays: n.shortfallDays, shortfallAction: n.shortfallAction, status: 'requested', initiatedBy: user.userId },
      include: exitInclude,
    })
    await audit(user, 'EXIT_REQUESTED', exit.id, { lastWorkingDate: ymd(proposed), noticePeriodDays: n.noticePeriodDays })
    const hr = await userIdsWithRole(tenantId, 'hr_admin')
    await notify({ tenantId, userIds: hr, type: 'exit.requested', title: `${fullName(employee)} handed in a resignation`, body: `Proposed last working day ${ymd(proposed)}. Accept or decline it.`, link: `/exits/${exit.id}`, entityType: 'employee_exit', entityId: exit.id })
    return exit
  },

  // HR accepts a resignation: it becomes a normal exit with the four sign-offs
  async accept(id: string, user: AccessUser, body: { noticeDate?: string; lastWorkingDate?: string; shortfallAction?: 'recover' | 'buyout' | 'waive'; backdated?: boolean; clearance: Clearance }) {
    const { tenantId } = user
    const exit = await loadVisible(id, user)
    if (exit.status !== 'requested') throw new AppError('This resignation was already answered', 409)
    const employee = await prisma.employee.findFirst({ where: { id: exit.employeeId, tenantId, active: true }, include: { manager: { select: { userId: true } } } })
    if (!employee) throw new AppError('Employee not found', 404)
    const noticeDate = body.noticeDate ? dateOnly(body.noticeDate) : exit.noticeDate
    const lastWorkingDate = body.lastWorkingDate ? dateOnly(body.lastWorkingDate) : exit.lastWorkingDate
    if (lastWorkingDate < noticeDate) throw new AppError('Last working day cannot be before the notice date', 400)
    if (lastWorkingDate < (await businessToday(tenantId)) && !body.backdated) throw new AppError('This last working day is in the past, so the exit is backdated. Tick "The person has already left" to confirm.', 400, 'BACKDATED_EXIT')
    const assignees = await assigneesFor(tenantId, employee, body.clearance)
    const n = await noticeFor(tenantId, employee.id, noticeDate, lastWorkingDate, exit.exitType, body.shortfallAction)
    await transition(id, tenantId, ['requested'], { status: 'initiated', noticeDate, lastWorkingDate, contractId: n.contractId, noticePeriodDays: n.noticePeriodDays, noticeServedDays: n.noticeServedDays, shortfallDays: n.shortfallDays, shortfallAction: n.shortfallAction })
    for (const department of DEPARTMENTS) await prisma.exitClearance.create({ data: { exitId: id, department, responsibleUserId: assignees[department] } })
    await prisma.employee.update({ where: { id: employee.id }, data: { exitDate: lastWorkingDate, exitReason: exit.reason } })
    await audit(user, 'EXIT_REQUEST_ACCEPTED', id, { lastWorkingDate: ymd(lastWorkingDate), ...(body.backdated && { backdated: true }) })
    await eventBus.publish(tenantId, 'exit.initiated', { exitId: id, employeeId: employee.id, exitType: exit.exitType, lastWorkingDate: ymd(lastWorkingDate), initiatedBy: user.userId })
    await notify({ tenantId, userIds: [employee.userId], type: 'exit.request_decided', title: 'Your resignation was accepted', body: `Your last working day is ${ymd(lastWorkingDate)}. You can follow the steps under My exit.`, link: '/exits', entityType: 'employee_exit', entityId: id })
    await tellClearanceOwners(tenantId, id, employee, assignees, lastWorkingDate, user.userId)
    return loadVisible(id, user)
  },

  async decline(id: string, user: AccessUser, reason: string) {
    const exit = await loadVisible(id, user)
    await transition(id, user.tenantId, ['requested'], { status: 'declined', cancelledBy: user.userId, cancelledAt: new Date(), cancelReason: reason })
    await audit(user, 'EXIT_REQUEST_DECLINED', id, { reason })
    await notify({ tenantId: user.tenantId, userIds: [exit.employee.userId], type: 'exit.request_decided', title: 'About your resignation', body: reason, link: '/exits', entityType: 'employee_exit', entityId: id })
    return loadVisible(id, user)
  },

  // What an employee sees of their own exit: the steps and who has signed off, never pay
  async mine(user: AccessUser) {
    if (!user.employeeId) return { exit: null, canResign: false }
    const [exit, emp] = await Promise.all([
      prisma.employeeExit.findFirst({ where: { tenantId: user.tenantId, employeeId: user.employeeId, status: { not: 'cancelled' } }, orderBy: { createdAt: 'desc' }, include: { clearances: { orderBy: { department: 'asc' } } } }),
      prisma.employee.findFirst({ where: { id: user.employeeId, tenantId: user.tenantId, active: true }, select: { id: true } }),
    ])
    const view = exit && {
      id: exit.id, status: exit.status, exitType: exit.exitType, reason: exit.reason, noticeDate: exit.noticeDate, lastWorkingDate: exit.lastWorkingDate,
      noticePeriodDays: exit.noticePeriodDays, noticeServedDays: exit.noticeServedDays, declinedReason: exit.status === 'declined' ? exit.cancelReason : null,
      clearances: exit.clearances.map((c) => ({ department: c.department, status: c.status, clearedAt: c.clearedAt })),
    }
    return { exit: view, canResign: !!emp && (!exit || ['declined', 'paid'].includes(exit.status)) }
  },

  // Who HR can assign a clearance to: every active user of the tenant (finance staff may have no employee record)
  assignableUsers(user: AccessUser) {
    return prisma.user.findMany({
      where: { tenantId: user.tenantId, active: true },
      select: { id: true, fullName: true, email: true, userRoles: { select: { role: { select: { name: true } } } } },
      orderBy: { fullName: 'asc' },
    })
  },

  async list(user: AccessUser) {
    return (await prisma.employeeExit.findMany({ where: { tenantId: user.tenantId }, include: exitInclude, orderBy: { createdAt: 'desc' } })).map((x) => hidePay(x, user))
  },

  // HR and payroll download the list; only payroll sees the amounts
  async exportCsv(user: AccessUser) {
    const rows = await prisma.employeeExit.findMany({ where: { tenantId: user.tenantId }, include: exitInclude, orderBy: { createdAt: 'desc' } })
    const pay = user.roleIds.includes('payroll_admin')
    const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const head = ['Employee', 'Code', 'Type', 'Reason', 'Notice date', 'Last working day', 'Status', 'Sign-offs done', ...(pay ? ['Currency', 'Net payable'] : [])]
    const lines = rows.map((x) => [fullName(x.employee), x.employee.employeeCode, x.exitType, x.reason, ymd(x.noticeDate), ymd(x.lastWorkingDate), x.status, `${x.clearances.filter((c) => c.status === 'cleared').length}/${x.clearances.length}`, ...(pay ? [x.currency ?? '', x.netPayable == null ? '' : Number(x.netPayable)] : [])].map(cell).join(','))
    return [head.map(cell).join(','), ...lines].join('\r\n') + '\r\n'
  },

  // The status is visible to HR, but a negative settlement only says that it needs a recovery note (the amount stays with payroll)
  async get(id: string, user: AccessUser) {
    const x = await loadVisible(id, user)
    const recovery = isStaff(user) ? await latestRecovery(id, user.tenantId) : null
    const view: any = hidePay(x, user)
    view.needsRecovery = negative(x) && !recovery
    view.recovery = recovery && { note: recovery.note, waived: recovery.waived, at: recovery.at, ...(user.roleIds.includes('payroll_admin') && { recoveredAmount: recovery.recoveredAmount }) }
    return view
  },

  myClearances(user: AccessUser) {
    return prisma.exitClearance.findMany({
      where: { responsibleUserId: user.userId, status: 'pending', exit: { tenantId: user.tenantId, status: 'initiated' } },
      include: { exit: { include: { employee: exitInclude.employee } } },
    })
  },

  async signClearance(id: string, department: string, user: AccessUser, note?: string) {
    const exit = await loadVisible(id, user)
    const item = exit.clearances.find((c) => c.department === department)!
    if (item.responsibleUserId !== user.userId) throw new AppError(`Only the user assigned to the ${department} clearance can sign it off`, 403)
    if (exit.status !== 'initiated') throw new AppError(`Clearance is closed: the exit is ${exit.status}`, 400)

    const res = await prisma.exitClearance.updateMany({ where: { id: item.id, status: 'pending' }, data: { status: 'cleared', clearedAt: new Date(), note: note ?? null } })
    if (res.count === 0) throw new AppError(`${department} clearance is already signed off`, 400)

    await audit(user, 'EXIT_CLEARANCE_SIGNED', id, { department })
    await eventBus.publish(user.tenantId, 'exit.clearance.signed', { exitId: id, department, signedBy: user.userId })
    const pending = await prisma.exitClearance.count({ where: { exitId: id, status: 'pending' } })
    if (pending === 0) {
      await eventBus.publish(user.tenantId, 'exit.clearance.completed', { exitId: id, employeeId: exit.employeeId })
      // It is now payroll's turn: the settlement can be computed
      const payroll = await userIdsWithRole(user.tenantId, 'payroll_admin')
      await notify({ tenantId: user.tenantId, userIds: payroll, type: 'exit.ready_to_compute', title: `Settlement ready: ${fullName(exit.employee)}`, body: 'Every sign-off is done. The full and final settlement can be computed.', link: `/exits/${id}`, entityType: 'employee_exit', entityId: id })
    }
    return loadVisible(id, user)
  },

  // HR computes; recomputing is allowed until finance approves
  async compute(id: string, user: AccessUser, recoveries: { description: string; amount: number }[] = []) {
    const { tenantId } = user
    const exit = await loadVisible(id, user)
    if (!['initiated', 'computed'].includes(exit.status)) throw new AppError(`Cannot compute: the exit is ${exit.status}`, 400)
    const pending = exit.clearances.filter((c) => c.status !== 'cleared').map((c) => c.department)
    if (pending.length) throw new AppError(`F&F is blocked until every clearance is signed off (pending: ${pending.join(', ')})`, 400)

    const emp = await prisma.employee.findFirst({
      where: { id: exit.employeeId, tenantId },
      include: { user: { select: { fullName: true } }, resourceCalendar: { include: { days: true } } },
    })
    if (!emp) throw new AppError('Employee not found', 404)
    emp.exitDate = exit.lastWorkingDate
    // Tax and gratuity depend on the person's tax country: use the company's country when theirs is not set, and stop if neither is
    if (!emp.taxJurisdiction) {
      const company = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { primaryCountry: true } })
      if (!company?.primaryCountry) throw new AppError("Set this person's tax country on their profile (Job tab) before computing: gratuity and tax depend on it. The company has no country set either.", 400, 'TAX_COUNTRY_MISSING')
      emp.taxJurisdiction = company.primaryCountry
    }

    // Last month, prorated to the last working day by the payroll engine
    const lwd = exit.lastWorkingDate
    const { start, end } = monthRange(lwd.getUTCFullYear(), lwd.getUTCMonth() + 1)
    const inputCodes = (await prisma.payrollInputType.findMany({ where: { tenantId, active: true }, select: { code: true } })).map((t) => t.code)
    const out = await computeEmployeePayslip(emp, { id: exit.id, payPeriodStart: start, payPeriodEnd: end }, [], inputCodes)
    if (out.skip) throw new AppError(`Cannot compute the final salary: ${out.skip}`, 400)
    const warnings = [...out.warnings]

    // A regular payroll payslip for the same month either already paid it, or must be dealt with first so the final month is paid in one place
    const regular = await prisma.payslip.findFirst({
      where: { employeeId: emp.id, payrollCycle: { tenantId, payPeriodStart: { lte: end }, payPeriodEnd: { gte: start } } },
      include: { payrollCycle: { select: { status: true, payPeriodStart: true } } },
    })
    const salaryPaid = !!regular && ['disbursed', 'locked'].includes(regular.payrollCycle.status)
    if (regular && !salaryPaid) {
      const month = ymd(regular.payrollCycle.payPeriodStart).slice(0, 7)
      throw new AppError(`The ${month} payroll run (${regular.payrollCycle.status}) already has a payslip for this person, and the final month must be paid in one place only. In Payroll, either finish and pay the ${month} run (then compute here again: the salary is not repeated), or remove this person from that run and run it again, then compute here again.`, 409, 'PAYROLL_RUN_OPEN')
    }
    if (salaryPaid) warnings.push(`Salary for ${ymd(start).slice(0, 7)} was already paid in the regular payroll cycle — not repeated here`)

    const lines: SettlementLine[] = []
    for (const l of payslipLines(out.payslip)) {
      if (l.category === 'REIMB') {
        lines.push({ section: 'reimbursement', kind: 'earning', code: l.code, name: l.name, amount: l.amount, sourceRefType: l.sourceRefType, sourceRefId: l.sourceRefId })
      } else if (!salaryPaid && ['BASIC', 'ALW', 'DED', 'TAX'].includes(l.category)) {
        const kind = ['BASIC', 'ALW'].includes(l.category) ? 'earning' : 'deduction'
        lines.push({ section: 'salary', kind, code: l.code, name: l.name, amount: l.amount, formula: l.formulaUsed ?? undefined })
      }
    }

    const basicMonthly = round2(out.basicMonthly ?? 0)
    const basicPerDay = round2(basicMonthly / DAYS_PER_MONTH)
    const perDay = `basic ${basicMonthly} ÷ ${DAYS_PER_MONTH} = ${basicPerDay}/day`

    const balances = await prisma.leaveBalance.findMany({
      where: { employeeId: emp.id, leaveType: { tenantId, encashable: true } },
      include: { leaveType: { select: { id: true, code: true, name: true } } },
    })
    for (const b of balances) {
      const days = round2(b.balanceDays - b.usedDays - b.pendingDays - b.encashedDays)
      if (days <= 0) continue
      lines.push({
        section: 'encashment', kind: 'earning', code: `ENCASH_${b.leaveType.code}`, name: `Leave encashment — ${b.leaveType.name}`,
        amount: round2(days * basicPerDay), quantity: days, formula: `${days} day(s) × ${perDay}`, sourceRefType: 'leave_type', sourceRefId: b.leaveType.id,
      })
    }

    if (exit.shortfallDays > 0) {
      const formula = `${exit.shortfallDays} day(s) short of ${exit.noticePeriodDays}-day notice × ${perDay}`
      const amount = round2(exit.shortfallDays * basicPerDay)
      if (exit.shortfallAction === 'recover') lines.push({ section: 'notice', kind: 'deduction', code: 'NOTICE_RECOVERY', name: 'Notice period shortfall recovery', amount, quantity: exit.shortfallDays, formula })
      else if (exit.shortfallAction === 'buyout') lines.push({ section: 'notice', kind: 'earning', code: 'NOTICE_PAY', name: 'Pay in lieu of notice (buyout)', amount, quantity: exit.shortfallDays, formula })
      else warnings.push(`Notice shortfall of ${exit.shortfallDays} day(s) waived`)
    }

    recoveries.forEach((r, i) => lines.push({ section: 'recovery', kind: 'deduction', code: `RECOVERY_${i + 1}`, name: r.description, amount: round2(r.amount) }))

    // Gratuity by the employee's tax country (statutory_tables IN_GRATUITY / ZM_GRATUITY)
    const contract = await prisma.employeeContract.findFirst({ where: { employeeId: emp.id, active: true, effectiveFrom: { lte: lwd } }, orderBy: { effectiveFrom: 'desc' }, select: { effectiveFrom: true, effectiveUntil: true } })
    const contractFrom = contract?.effectiveFrom ?? emp.hireDate
    const paidSlips = await prisma.payslip.findMany({ where: { employeeId: emp.id, payrollCycle: { tenantId, status: { in: ['disbursed', 'locked'] }, payPeriodStart: { gte: contractFrom } } }, select: { lines: { select: { category: true, amount: true } } } })
    const paidBasic = { _sum: { amount: paidSlips.reduce((t: number, p: any) => t + (p.lines as any[]).filter((l) => l.category === 'BASIC').reduce((s, l) => s + Number(l.amount), 0), 0) } }
    const finalBasic = salaryPaid ? 0 : (payslipLines(out.payslip)).filter((l) => l.category === 'BASIC').reduce((t, l) => t + Number(l.amount), 0)
    const grat = computeGratuity({
      country: emp.taxJurisdiction, hireDate: ymd(emp.hireDate), lastWorkingDate: ymd(lwd), exitType: exit.exitType, basicMonthly,
      basicEarnedInContract: round2(Number(paidBasic._sum.amount ?? 0) + finalBasic), contractFrom: ymd(contractFrom), contractUntil: contract?.effectiveUntil ? ymd(contract.effectiveUntil) : null,
    }, await statutoryFor(ymd(lwd), tenantId))
    if (grat.amount > 0) lines.push({ section: 'gratuity', kind: 'earning', code: 'GRATUITY', name: 'Gratuity', amount: grat.amount, formula: grat.formula })
    if (grat.warning) warnings.push(grat.warning)
    warnings.push('Leave encashment and notice pay are not taxed in this settlement: tax on terminal benefits arrives with the Phase 3 tax tables')

    const totalEarnings = round2(lines.filter((l) => l.kind === 'earning').reduce((s, l) => s + l.amount, 0))
    const totalDeductions = round2(lines.filter((l) => l.kind === 'deduction').reduce((s, l) => s + l.amount, 0))
    const netPayable = round2(totalEarnings - totalDeductions)

    await transition(id, tenantId, ['initiated', 'computed'], {
      status: 'computed', currency: out.payslip.currency, lines: lines as any, warnings, totalEarnings, totalDeductions, netPayable,
      computedBy: user.userId, computedAt: new Date(),
    })
    await audit(user, 'FNF_COMPUTED', id, { totalEarnings, totalDeductions, netPayable, currency: out.payslip.currency })
    await eventBus.publish(tenantId, 'fnf.computed', { exitId: id, employeeId: emp.id, netPayable, currency: out.payslip.currency, computedBy: user.userId })
    return loadVisible(id, user)
  },

  // A negative settlement (the employee owes money) cannot go to payment until someone records how it is recovered or that it is waived
  async recordRecovery(id: string, user: AccessUser, body: { note: string; recoveredAmount?: number | null; waived?: boolean }) {
    const exit = await loadVisible(id, user)
    if (!['computed', 'approved'].includes(exit.status)) throw new AppError('A recovery is recorded once the settlement is computed', 400)
    if (!negative(exit)) throw new AppError('This settlement is not negative, so nothing needs recovering', 400)
    await audit(user, 'FNF_RECOVERY_RECORDED', id, { note: body.note, recoveredAmount: body.recoveredAmount ?? null, waived: !!body.waived })
    return this.get(id, user)
  },

  // Maker-checker: finance approves a settlement HR computed, never their own and never their own exit
  async approve(id: string, user: AccessUser) {
    const exit = await loadVisible(id, user)
    if (exit.status !== 'computed') throw new AppError(`Only a computed settlement can be approved (this one is ${exit.status})`, 400)
    if (exit.computedBy === user.userId) throw new AppError('The settlement must be approved by a different user than the one who computed it', 403)
    if (exit.employee.userId === user.userId) throw new AppError('You cannot approve your own settlement', 403)
    await assertRecoveryRecorded(exit, user.tenantId, 'approve it')

    await transition(id, user.tenantId, ['computed'], { status: 'approved', approvedBy: user.userId, approvedAt: new Date() })
    await audit(user, 'FNF_APPROVED', id, { netPayable: exit.netPayable })
    await eventBus.publish(user.tenantId, 'fnf.approved', { exitId: id, employeeId: exit.employeeId, approvedBy: user.userId })
    return loadVisible(id, user)
  },

  // Payment closes everything: claims paid, leave encashed, contracts closed, employee + login archived. Immutable afterwards.
  async pay(id: string, user: AccessUser) {
    const { tenantId } = user
    const exit = await loadVisible(id, user)
    if (exit.status !== 'approved') throw new AppError(`Only an approved settlement can be paid (this one is ${exit.status})`, 400)
    await assertRecoveryRecorded(exit, tenantId, 'mark it paid')
    const lines = (exit.lines ?? []) as unknown as SettlementLine[]
    const claimIds = lines.filter((l) => l.section === 'reimbursement' && l.sourceRefId).map((l) => l.sourceRefId!)
    const now = new Date()
    const name = `${exit.employee.firstName} ${exit.employee.lastName}`
    const closed: { contractId: string; toStatus: ContractStatus }[] = []

    await prisma.$transaction(async (tx) => {
      const res = await tx.employeeExit.updateMany({ where: { id, tenantId, status: 'approved' }, data: { status: 'paid', paidBy: user.userId, paidAt: now } })
      if (res.count === 0) throw new AppError('This settlement is no longer approved', 409)

      if (claimIds.length) {
        const paid = await tx.reimbursementClaim.updateMany({
          where: { id: { in: claimIds }, tenantId, status: 'finance_approved', paidInCycleId: null },
          data: { status: 'paid', paidAt: now },
        })
        if (paid.count !== claimIds.length) throw new AppError('A reimbursement in this settlement was already paid elsewhere — recompute and re-approve', 409)
      }

      for (const l of lines.filter((x) => x.section === 'encashment' && x.sourceRefId)) {
        await tx.leaveBalance.update({
          where: { employeeId_leaveTypeId: { employeeId: exit.employeeId, leaveTypeId: l.sourceRefId! } },
          data: { encashedDays: { increment: l.quantity ?? 0 } },
        })
      }

      // Close every live contract through the state machine: running → expired, not yet running → cancelled
      const contracts = await tx.employeeContract.findMany({ where: { employeeId: exit.employeeId, active: true, status: { in: ['new', 'draft', 'confirmed', 'running'] } } })
      for (const c of contracts) {
        const toStatus: ContractStatus = c.status === 'running' ? 'expired' : 'cancelled'
        if (!CONTRACT_TRANSITIONS[c.status as ContractStatus].includes(toStatus)) continue
        const effectiveUntil = c.effectiveUntil && c.effectiveUntil < exit.lastWorkingDate ? c.effectiveUntil : exit.lastWorkingDate
        await tx.employeeContract.update({
          where: { id: c.id },
          data: { status: toStatus, stateChangedAt: now, stateChangedBy: user.userId, ...(toStatus === 'expired' && { effectiveUntil }) },
        })
        await tx.contractStateTransition.create({
          data: { contractId: c.id, fromState: c.status, toState: toStatus, transitionedBy: user.userId, reason: 'Closed by full & final settlement' },
        })
        closed.push({ contractId: c.id, toStatus })
      }

      await tx.employee.update({
        where: { id: exit.employeeId },
        data: { active: false, archivedAt: now, archivedBy: user.userId, archiveReason: `Full & final settlement paid (${exit.exitType})`, employmentStatus: 'terminated' },
      })
      await tx.user.update({ where: { id: exit.employee.userId }, data: { active: false, archivedAt: now, archivedBy: user.userId, archiveReason: 'Exited' } })
      await tx.refreshToken.updateMany({ where: { userId: exit.employee.userId, revokedAt: null }, data: { revokedAt: now } })
    }, { timeout: 30_000 })

    await audit(user, 'FNF_PAID', id, { netPayable: exit.netPayable, currency: exit.currency, claimsPaid: claimIds.length, contractsClosed: closed.length })
    for (const claimId of claimIds) {
      await prisma.auditLog.create({ data: { tenantId, userId: user.userId, action: 'EXPENSE_PAID', entityType: 'expense_claim', entityId: claimId, newValue: { employeeExitId: id } } })
    }
    await eventBus.publish(tenantId, 'fnf.paid', { exitId: id, employeeId: exit.employeeId, netPayable: exit.netPayable, currency: exit.currency, paidBy: user.userId })
    for (const c of closed) {
      await eventBus.publish(tenantId, `contract.${c.toStatus}`, { contractId: c.contractId, employeeId: exit.employeeId, name, transitionedBy: user.userId })
    }
    await eventBus.publish(tenantId, 'employee.archived', { employeeId: exit.employeeId, archivedBy: user.userId, reason: `Full & final settlement paid (${exit.exitType})` })
    await this.afterPay(user, exit, name)
    return loadVisible(id, user)
  },

  // What is left behind once someone has gone: their old sign-in stops at once, their reports get the leaver's manager, pending leave is called
  // off, and HR is asked whether the person should get an alumni login (never switched on by itself)
  async afterPay(user: AccessUser, exit: { id: string; employeeId: string; lastWorkingDate: Date; employee: { userId: string; managerId: string | null; firstName: string; lastName: string } }, name: string) {
    const { tenantId } = user
    await revokeUserAccess(exit.employee.userId)
    const cancelled = await callOffLeave(tenantId, exit.employeeId, exit.lastWorkingDate, true).catch(() => 0)
    const reports = await prisma.employee.findMany({ where: { tenantId, managerId: exit.employeeId, active: true }, select: { id: true, userId: true, firstName: true, lastName: true } })
    if (reports.length) {
      const newManagerId = exit.employee.managerId
      await prisma.employee.updateMany({ where: { tenantId, managerId: exit.employeeId, active: true }, data: { managerId: newManagerId } })
      await audit(user, 'REPORTS_REASSIGNED', exit.id, { from: exit.employeeId, to: newManagerId, people: reports.map((r) => r.id) })
      const list = reports.map(fullName).join(', ')
      if (newManagerId) {
        const mgrUser = await userIdOfEmployee(tenantId, newManagerId)
        if (mgrUser) await notify({ tenantId, userIds: [mgrUser], type: 'exit.reports_reassigned', title: `${reports.length} ${reports.length > 1 ? 'people now report' : 'person now reports'} to you`, body: `${name} has left. ${list} ${reports.length > 1 ? 'were' : 'was'} moved to you.`, link: '/employees', entityType: 'employee_exit', entityId: exit.id })
      } else {
        await notify({ tenantId, userIds: await userIdsWithRole(tenantId, 'hr_admin'), type: 'exit.reports_reassigned', title: `${reports.length} ${reports.length > 1 ? 'people have' : 'person has'} no manager`, body: `${name} has left and had no manager to hand over to. Give ${list} a manager.`, link: '/employees', entityType: 'employee_exit', entityId: exit.id })
      }
      await notify({ tenantId, userIds: (await Promise.all(reports.map((r) => userIdOfEmployee(tenantId, r.id)))).filter((x): x is string => !!x), type: 'exit.reports_reassigned', title: 'You have a new manager', body: `${name} has left. Your approvals now go to ${newManagerId ? 'your new manager' : 'HR until a manager is set'}.`, link: '/dashboard', entityType: 'employee_exit', entityId: exit.id })
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true, addons: true } })
    if (tenant && hasFeature(tenant.plan, tenant.addons ?? [], 'alumni')) {
      await notify({ tenantId, userIds: await userIdsWithRole(tenantId, 'hr_admin'), type: 'exit.alumni_available', title: `${name} has left: give them alumni access?`, body: 'An alumni login lets them download their letters and ask for new ones. It is off until you switch it on.', link: '/alumni', entityType: 'employee_exit', entityId: exit.id })
    }
    if (cancelled) await audit(user, 'EXIT_LEAVE_CANCELLED', exit.id, { requests: cancelled })
  },

  // Daily (hourly, idempotent) by the exit-last-day job. After the last working day: the login ends (HR can restore it), leave asked for after the
  // last day is called off, and a sign-off still open after 3 days gets a reminder to its owner (at most once a day).
  async lastDay(tenantId: string) {
    const today = await businessToday(tenantId)
    const open = await prisma.employeeExit.findMany({ where: { tenantId, status: { in: ['initiated', 'computed', 'approved'] } }, include: { employee: { select: { id: true, userId: true, firstName: true, lastName: true } }, clearances: true } })
    let loginsEnded = 0, leaveCalledOff = 0, reminders = 0
    for (const x of open) {
      if (x.lastWorkingDate < today) {
        leaveCalledOff += await callOffLeave(tenantId, x.employeeId, x.lastWorkingDate).catch(() => 0)
        const u = await prisma.user.findFirst({ where: { id: x.employee.userId, tenantId, active: true }, select: { id: true } })
        if (u) {
          await prisma.user.update({ where: { id: u.id }, data: { active: false } })
          await prisma.refreshToken.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } })
          await revokeUserAccess(u.id)
          await prisma.auditLog.create({ data: { tenantId, userId: u.id, action: 'EXIT_LOGIN_ENDED', entityType: 'employee_exit', entityId: x.id, newValue: { lastWorkingDate: ymd(x.lastWorkingDate) } } })
          await notify({ tenantId, userIds: await userIdsWithRole(tenantId, 'hr_admin'), type: 'exit.login_ended', title: `${fullName(x.employee)}'s sign-in has ended`, body: 'Their last working day has passed. You can restore the login from the exit page if they still need it.', link: `/exits/${x.id}`, entityType: 'employee_exit', entityId: x.id })
          loginsEnded++
        }
      }
      if (x.status === 'initiated' && daysBetween(x.createdAt, today) > 3) {
        for (const c of x.clearances.filter((c) => c.status === 'pending')) {
          const since = new Date(Date.now() - 20 * 3_600_000)
          if (await prisma.notification.findFirst({ where: { tenantId, userId: c.responsibleUserId, type: 'exit.clearance_overdue', entityId: c.id, createdAt: { gt: since } } })) continue
          await notify({ tenantId, userIds: [c.responsibleUserId], type: 'exit.clearance_overdue', title: `Still waiting: your ${c.department} sign-off for ${fullName(x.employee)}`, body: 'This sign-off has been open for more than 3 days. The settlement cannot be computed until it is done.', link: `/exits/${x.id}`, entityType: 'exit_clearance', entityId: c.id })
          reminders++
        }
      }
    }
    return { loginsEnded, leaveCalledOff, reminders }
  },

  // HR puts back a sign-in the last-day job ended (for example the person is working a longer handover)
  async restoreLogin(id: string, user: AccessUser) {
    const exit = await loadVisible(id, user)
    if (!['initiated', 'computed', 'approved'].includes(exit.status)) throw new AppError('Only an exit that is still open can have its login restored', 400)
    await prisma.user.updateMany({ where: { id: exit.employee.userId, tenantId: user.tenantId }, data: { active: true } })
    await audit(user, 'EXIT_LOGIN_RESTORED', id)
    return loadVisible(id, user)
  },

  async cancel(id: string, user: AccessUser, reason: string) {
    const exit = await loadVisible(id, user)
    await transition(id, user.tenantId, ['initiated', 'computed'], { status: 'cancelled', cancelledBy: user.userId, cancelledAt: new Date(), cancelReason: reason })
    await prisma.employee.update({ where: { id: exit.employeeId }, data: { exitDate: null, exitReason: null } })
    // a sign-in the last-day job ended comes back when the exit is called off
    const ended = await prisma.auditLog.findFirst({ where: { tenantId: user.tenantId, entityType: 'employee_exit', entityId: id, action: 'EXIT_LOGIN_ENDED' } })
    if (ended) await prisma.user.updateMany({ where: { id: exit.employee.userId, tenantId: user.tenantId }, data: { active: true } })
    await audit(user, 'EXIT_CANCELLED', id, { reason })
    await eventBus.publish(user.tenantId, 'exit.cancelled', { exitId: id, employeeId: exit.employeeId, reason })
    return loadVisible(id, user)
  },

  async settlementPdf(id: string, user: AccessUser) {
    const exit = await loadVisible(id, user)
    if (!isStaff(user)) throw new AppError('Exit not found', 404)
    if (!exit.lines) throw new AppError('The settlement has not been computed yet', 400)
    const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } })
    const pdf = await generatePayslipPdf(renderSettlementHtml(exit as any, tenant?.name || ''))
    await audit(user, 'FNF_PDF_DOWNLOADED', id)
    return { pdf, filename: `final-settlement-${exit.employee.employeeCode}.pdf` }
  },
}

import { Prisma } from '@prisma/client'
import { prisma } from '../../infrastructure/database/prisma'
import { eventBus } from '../../infrastructure/events/eventBus'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { dateOnly, monthRange } from '../../shared/utils/businessDate'
import { computeEmployeePayslip } from '../payroll/payroll.service'
import { generatePayslipPdf } from '../payroll/payslip.pdf'
import { CONTRACT_TRANSITIONS, ContractStatus } from '../employees/contracts.types'
import { renderSettlementHtml } from './exits.pdf'
import { DEPARTMENTS } from './exits.schema'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000)

// ponytail: one divisor for every per-day rate (basic ÷ 30). Country rules (26-day months, gratuity) arrive with Phase 3 tax tables.
const DAYS_PER_MONTH = 30
const STAFF = ['hr_admin', 'payroll_admin']
const OPEN = ['initiated', 'computed', 'approved']

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

async function transition(id: string, tenantId: string, from: string[], data: Prisma.EmployeeExitUncheckedUpdateManyInput) {
  const res = await prisma.employeeExit.updateMany({ where: { id, tenantId, status: { in: from } }, data })
  if (res.count === 0) throw new AppError(`This exit is no longer ${from.join(' or ')}`, 409)
}

export const exitsService = {
  async initiate(user: AccessUser, body: {
    employeeId: string; exitType: 'resignation' | 'termination'; reason: string; noticeDate: string; lastWorkingDate: string
    shortfallAction?: 'recover' | 'buyout' | 'waive'; clearance: { IT: string; FINANCE: string; ADMIN: string; MANAGER?: string }
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

    const open = await prisma.employeeExit.findFirst({ where: { tenantId, employeeId: employee.id, status: { in: OPEN } } })
    if (open) throw new AppError('This employee already has an exit in progress', 409)

    const assignees = { ...body.clearance, MANAGER: body.clearance.MANAGER ?? employee.manager?.userId }
    if (!assignees.MANAGER) throw new AppError('The employee has no manager on record: assign the MANAGER clearance to a user', 400)
    const ids = DEPARTMENTS.map((d) => assignees[d]!)
    if (new Set(ids).size !== ids.length) throw new AppError('Each clearance must be signed off by a different user', 400)
    if (ids.includes(employee.userId)) throw new AppError('The exiting employee cannot sign off their own clearance', 400)
    const users = await prisma.user.count({ where: { id: { in: ids }, tenantId, active: true } })
    if (users !== ids.length) throw new AppError('Every clearance user must be an active user of this organisation', 400)

    // Notice period comes from the contract in force on the last working day
    const contract = await prisma.employeeContract.findFirst({
      where: { employeeId: employee.id, active: true, status: 'running', effectiveFrom: { lte: lastWorkingDate } },
      orderBy: { effectiveFrom: 'desc' },
    })
    const noticePeriodDays = contract?.noticePeriodDays ?? 0
    const noticeServedDays = daysBetween(noticeDate, lastWorkingDate)
    const shortfallDays = Math.max(0, noticePeriodDays - noticeServedDays)
    const shortfallAction = body.shortfallAction ?? (body.exitType === 'resignation' ? 'recover' : 'buyout')

    const exit = await prisma.employeeExit.create({
      data: {
        tenantId, employeeId: employee.id, contractId: contract?.id ?? null, exitType: body.exitType, reason: body.reason,
        noticeDate, lastWorkingDate, noticePeriodDays, noticeServedDays, shortfallDays, shortfallAction, initiatedBy: user.userId,
        clearances: { create: DEPARTMENTS.map((department) => ({ department, responsibleUserId: assignees[department]! })) },
      },
      include: exitInclude,
    })
    await prisma.employee.update({ where: { id: employee.id }, data: { exitDate: lastWorkingDate, exitReason: body.reason } })

    await audit(user, 'EXIT_INITIATED', exit.id, { exitType: body.exitType, lastWorkingDate: body.lastWorkingDate, noticePeriodDays, shortfallDays, shortfallAction })
    await eventBus.publish(tenantId, 'exit.initiated', {
      exitId: exit.id, employeeId: employee.id, exitType: body.exitType, lastWorkingDate: body.lastWorkingDate, initiatedBy: user.userId,
    })
    return exit
  },

  // Who HR can assign a clearance to: every active user of the tenant (finance staff may have no employee record)
  assignableUsers(user: AccessUser) {
    return prisma.user.findMany({
      where: { tenantId: user.tenantId, active: true },
      select: { id: true, fullName: true, email: true, userRoles: { select: { role: { select: { name: true } } } } },
      orderBy: { fullName: 'asc' },
    })
  },

  list(user: AccessUser) {
    return prisma.employeeExit.findMany({ where: { tenantId: user.tenantId }, include: exitInclude, orderBy: { createdAt: 'desc' } })
  },

  get: (id: string, user: AccessUser) => loadVisible(id, user),

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
    if (pending === 0) await eventBus.publish(user.tenantId, 'exit.clearance.completed', { exitId: id, employeeId: exit.employeeId })
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

    // Last month, prorated to the last working day by the payroll engine
    const lwd = exit.lastWorkingDate
    const { start, end } = monthRange(lwd.getUTCFullYear(), lwd.getUTCMonth() + 1)
    const inputCodes = (await prisma.payrollInputType.findMany({ where: { tenantId, active: true }, select: { code: true } })).map((t) => t.code)
    const out = await computeEmployeePayslip(emp, { id: exit.id, payPeriodStart: start, payPeriodEnd: end }, [], inputCodes)
    if (out.skip) throw new AppError(`Cannot compute the final salary: ${out.skip}`, 400)
    const warnings = [...out.warnings]

    // A regular payroll payslip for the same month either already paid it, or must be re-run to drop this employee
    const regular = await prisma.payslip.findFirst({
      where: { employeeId: emp.id, payrollCycle: { tenantId, payPeriodStart: { lte: end }, payPeriodEnd: { gte: start } } },
      include: { payrollCycle: { select: { status: true, payPeriodStart: true } } },
    })
    const salaryPaid = !!regular && ['disbursed', 'locked'].includes(regular.payrollCycle.status)
    if (regular && !salaryPaid) {
      throw new AppError(`The ${ymd(regular.payrollCycle.payPeriodStart).slice(0, 7)} payroll cycle (${regular.payrollCycle.status}) has a payslip for this employee: re-run it so the final month is paid only through this settlement`, 409)
    }
    if (salaryPaid) warnings.push(`Salary for ${ymd(start).slice(0, 7)} was already paid in the regular payroll cycle — not repeated here`)

    const lines: SettlementLine[] = []
    for (const l of out.payslip.lines.create as any[]) {
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

    lines.push({ section: 'gratuity', kind: 'earning', code: 'GRATUITY', name: 'Gratuity — PLACEHOLDER, statutory formula arrives in Phase 3', amount: 0 })
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

  // Maker-checker: finance approves a settlement HR computed, never their own and never their own exit
  async approve(id: string, user: AccessUser) {
    const exit = await loadVisible(id, user)
    if (exit.status !== 'computed') throw new AppError(`Only a computed settlement can be approved (this one is ${exit.status})`, 400)
    if (exit.computedBy === user.userId) throw new AppError('The settlement must be approved by a different user than the one who computed it', 403)
    if (exit.employee.userId === user.userId) throw new AppError('You cannot approve your own settlement', 403)

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
    return loadVisible(id, user)
  },

  async cancel(id: string, user: AccessUser, reason: string) {
    const exit = await loadVisible(id, user)
    await transition(id, user.tenantId, ['initiated', 'computed'], { status: 'cancelled', cancelledBy: user.userId, cancelledAt: new Date(), cancelReason: reason })
    await prisma.employee.update({ where: { id: exit.employeeId }, data: { exitDate: null, exitReason: null } })
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

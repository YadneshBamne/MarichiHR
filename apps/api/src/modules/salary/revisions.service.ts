import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'

// Salary revisions with maker-checker. One person raises a revision (new CTC and monthly wage from the first day of a
// month); someone else approves it. Approval creates the next contract version and ends the current one the day before.
// If the revision starts in a month that was already paid, the difference for each paid month (scaled by the days
// paid that month) is arrears: payroll posts it into an open run as a "Salary Arrear" input, which payroll's own
// maker-checker then approves.

const STAFF = ['payroll_admin']
const isStaff = (u: AccessUser) => u.roleIds.some((r) => STAFF.includes(r))
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const day = (s: string) => new Date(`${s}T00:00:00.000Z`)
const audit = (u: AccessUser, action: string, entityId: string, newValue: any) => prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action, entityType: 'salary_revision', entityId, newValue } })

async function currentContract(employeeId: string) {
  return prisma.employeeContract.findFirst({ where: { employeeId, active: true, status: 'running' }, orderBy: { effectiveFrom: 'desc' } })
}

// Arrears: months already paid (disbursed or locked) from the revision date, at the new wage minus the old
export async function arrearsFor(employeeId: string, tenantId: string, effectiveFrom: Date, oldWage: number, newWage: number) {
  const slips = await prisma.payslip.findMany({
    where: { employeeId, payrollCycle: { tenantId, status: { in: ['disbursed', 'locked'] }, payPeriodStart: { gte: effectiveFrom } } },
    select: { workingDays: true, paidDays: true, payrollCycle: { select: { payPeriodStart: true } } },
    orderBy: { payrollCycle: { payPeriodStart: 'asc' } },
  })
  const detail = slips.map((s) => {
    const share = s.workingDays > 0 ? Math.min(1, s.paidDays / s.workingDays) : 1
    return { month: ymd(s.payrollCycle.payPeriodStart).slice(0, 7), paidDays: s.paidDays, workingDays: s.workingDays, difference: round2((newWage - oldWage) * share) }
  })
  return { amount: round2(detail.reduce((t, d) => t + d.difference, 0)), detail }
}

const view = async (r: any) => {
  const [emp, users] = await Promise.all([
    prisma.employee.findUnique({ where: { id: r.employeeId }, select: { firstName: true, lastName: true, employeeCode: true } }),
    prisma.user.findMany({ where: { id: { in: [r.requestedBy, r.decidedBy].filter(Boolean) } }, select: { id: true, fullName: true } }),
  ])
  const from = await prisma.employeeContract.findUnique({ where: { id: r.fromContractId }, select: { ctcAnnual: true, wageMonthly: true, currency: true } })
  const nm = (id: string | null) => (id ? users.find((u) => u.id === id)?.fullName ?? null : null)
  return {
    id: r.id, employeeId: r.employeeId, employee: emp ? `${emp.firstName} ${emp.lastName}` : null, employeeCode: emp?.employeeCode ?? null,
    currency: from?.currency ?? null, oldCtcAnnual: Number(from?.ctcAnnual ?? 0), oldWageMonthly: Number(from?.wageMonthly ?? 0),
    newCtcAnnual: Number(r.newCtcAnnual), newWageMonthly: Number(r.newWageMonthly), changePct: from && Number(from.wageMonthly) > 0 ? round2(((Number(r.newWageMonthly) - Number(from.wageMonthly)) / Number(from.wageMonthly)) * 100) : null,
    effectiveFrom: ymd(r.effectiveFrom), reason: r.reason, status: r.status, requestedBy: nm(r.requestedBy), requestedById: r.requestedBy, decidedBy: nm(r.decidedBy), decidedAt: r.decidedAt, decisionNote: r.decisionNote,
    arrearsAmount: r.arrearsAmount == null ? null : Number(r.arrearsAmount), arrearsDetail: r.arrearsDetail, arrearsPosted: !!r.arrearsInputId, newContractId: r.newContractId, createdAt: r.createdAt,
  }
}

export const revisionService = {
  async list(u: AccessUser, filter: { status?: string; employeeId?: string }) {
    if (!isStaff(u)) throw new AppError('Only HR and payroll can see salary revisions', 403)
    const rows = await prisma.salaryRevision.findMany({ where: { tenantId: u.tenantId, ...(filter.status && { status: filter.status }), ...(filter.employeeId && { employeeId: filter.employeeId }) }, orderBy: { createdAt: 'desc' }, take: 300 })
    const out = []
    for (const r of rows) {
      const v = await view(r)
      // Pending ones show the arrears they would create
      if (r.status === 'pending') { const a = await arrearsFor(r.employeeId, u.tenantId, r.effectiveFrom, v.oldWageMonthly, v.newWageMonthly); Object.assign(v, { arrearsAmount: a.amount, arrearsDetail: a.detail }) }
      out.push(v)
    }
    return out
  },

  async create(u: AccessUser, b: { employeeId: string; newCtcAnnual: number; newWageMonthly: number; newSalaryStructureId?: string; effectiveFrom: string; reason: string }) {
    if (!isStaff(u)) throw new AppError('Only HR and payroll raise salary revisions', 403)
    const emp = await prisma.employee.findFirst({ where: { id: b.employeeId, tenantId: u.tenantId, active: true } })
    if (!emp) throw new AppError('Employee not found', 404)
    if (emp.id === u.employeeId) throw new AppError('You cannot revise your own salary', 403)
    if (!b.effectiveFrom.endsWith('-01')) throw new AppError('A revision starts on the first day of a month', 400)
    if (b.newWageMonthly * 12 > b.newCtcAnnual * 1.0001) throw new AppError('Twelve months of wage cannot be more than the annual CTC', 400)
    const contract = await currentContract(emp.id)
    if (!contract) throw new AppError('This person has no running contract to revise', 400)
    if (day(b.effectiveFrom) <= contract.effectiveFrom) throw new AppError(`The revision must start after the current contract began (${ymd(contract.effectiveFrom)})`, 400)
    if (b.newSalaryStructureId && !(await prisma.salaryStructure.findFirst({ where: { id: b.newSalaryStructureId, tenantId: u.tenantId } }))) throw new AppError('Salary structure not found', 404)
    if (await prisma.salaryRevision.findFirst({ where: { tenantId: u.tenantId, employeeId: emp.id, status: 'pending' } })) throw new AppError('This person already has a revision waiting for approval', 409)
    const r = await prisma.salaryRevision.create({ data: { tenantId: u.tenantId, employeeId: emp.id, fromContractId: contract.id, newCtcAnnual: b.newCtcAnnual, newWageMonthly: b.newWageMonthly, newSalaryStructureId: b.newSalaryStructureId ?? null, effectiveFrom: day(b.effectiveFrom), reason: b.reason, requestedBy: u.userId } })
    await audit(u, 'SALARY_REVISION_RAISED', r.id, { employeeId: emp.id, from: Number(contract.wageMonthly), to: b.newWageMonthly, effectiveFrom: b.effectiveFrom })
    const approvers = (await userIdsWithRole(u.tenantId, 'payroll_admin')).filter((id) => id !== u.userId && id !== emp.userId)
    await notify({ tenantId: u.tenantId, userIds: approvers, type: 'salary.revision', title: `Salary revision for ${emp.firstName} ${emp.lastName} needs approval`, body: `From ${b.effectiveFrom}: ${b.reason}`, link: '/compensation', entityType: 'salary_revision', entityId: r.id })
    return view(r)
  },

  async decide(u: AccessUser, id: string, approve: boolean, note?: string) {
    if (!isStaff(u)) throw new AppError('Only Payroll admins approve salary revisions', 403)
    const r = await prisma.salaryRevision.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!r) throw new AppError('Revision not found', 404)
    if (r.status !== 'pending') throw new AppError(`This revision is already ${r.status}`, 400)
    if (r.requestedBy === u.userId) throw new AppError('A revision must be approved by someone other than the person who raised it', 403)
    if (r.employeeId === u.employeeId) throw new AppError('You cannot approve your own salary', 403)
    if (!approve && !note) throw new AppError('Give a reason for rejecting', 400)
    const from = await prisma.employeeContract.findUnique({ where: { id: r.fromContractId } })
    if (!from) throw new AppError('The contract being revised no longer exists', 409)
    if (!approve) {
      await prisma.salaryRevision.update({ where: { id }, data: { status: 'rejected', decidedBy: u.userId, decidedAt: new Date(), decisionNote: note } })
      await audit(u, 'SALARY_REVISION_REJECTED', id, { note })
      return view(await prisma.salaryRevision.findUniqueOrThrow({ where: { id } }))
    }
    const arrears = await arrearsFor(r.employeeId, u.tenantId, r.effectiveFrom, Number(from.wageMonthly), Number(r.newWageMonthly))
    const today = day(new Date().toISOString().slice(0, 10))
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await tx.salaryRevision.updateMany({ where: { id, status: 'pending' }, data: { status: 'approved', decidedBy: u.userId, decidedAt: new Date(), decisionNote: note ?? null, arrearsAmount: arrears.amount, arrearsDetail: arrears.detail as any } })
      if (!claimed.count) throw new AppError('Someone else just decided this revision', 409)
      await tx.employeeContract.update({ where: { id: from.id }, data: { effectiveUntil: new Date(r.effectiveFrom.getTime() - 86_400_000) } })
      const next = await tx.employeeContract.create({
        data: {
          employeeId: r.employeeId, salaryStructureId: r.newSalaryStructureId ?? from.salaryStructureId, gradeBandId: from.gradeBandId, ctcAnnual: r.newCtcAnnual, wageMonthly: r.newWageMonthly,
          currency: from.currency, variablePayPercent: from.variablePayPercent, noticePeriodDays: from.noticePeriodDays, effectiveFrom: r.effectiveFrom,
          status: r.effectiveFrom <= today ? 'running' : 'confirmed', version: from.version + 1, previousContractId: from.id, revisionReason: r.reason, approvedBy: u.userId,
        },
      })
      await tx.salaryRevision.update({ where: { id }, data: { newContractId: next.id } })
      return next
    })
    await audit(u, 'SALARY_REVISION_APPROVED', id, { newContractId: result.id, arrears: arrears.amount })
    return view(await prisma.salaryRevision.findUniqueOrThrow({ where: { id } }))
  },

  async cancel(u: AccessUser, id: string) {
    const r = await prisma.salaryRevision.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!r || !isStaff(u)) throw new AppError('Revision not found', 404)
    if (r.status !== 'pending') throw new AppError(`This revision is already ${r.status}`, 400)
    await prisma.salaryRevision.update({ where: { id }, data: { status: 'cancelled' } })
    await audit(u, 'SALARY_REVISION_CANCELLED', id, {})
    return { cancelled: true }
  },

  // Arrears go into an open run (draft or review) as an approved-later payroll input
  async postArrears(u: AccessUser, id: string, cycleId: string) {
    if (!isStaff(u)) throw new AppError('Only HR and payroll post arrears', 403)
    const r = await prisma.salaryRevision.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!r) throw new AppError('Revision not found', 404)
    if (r.status !== 'approved') throw new AppError('Approve the revision first', 400)
    if (r.arrearsInputId) throw new AppError('These arrears are already posted', 400)
    const amount = Number(r.arrearsAmount ?? 0)
    if (amount <= 0) throw new AppError(amount < 0 ? 'The revision lowered pay: recover the difference with a deduction input instead' : 'There are no arrears for this revision', 400)
    const cycle = await prisma.payrollCycle.findFirst({ where: { id: cycleId, tenantId: u.tenantId } })
    if (!cycle) throw new AppError('Payroll run not found', 404)
    if (!['draft', 'review'].includes(cycle.status)) throw new AppError(`That payroll run is ${cycle.status}; pick one that is still open`, 400)
    let type = await prisma.payrollInputType.findFirst({ where: { tenantId: u.tenantId, code: { in: ['ARREAR', 'ARREARS'] } } })
    if (!type) type = await prisma.payrollInputType.create({ data: { tenantId: u.tenantId, name: 'Salary Arrear', code: 'ARREAR', category: 'earnings', description: 'Arrear payment from prior period' } })
    const months = ((r.arrearsDetail as any[]) ?? []).map((d) => d.month).join(', ')
    const input = await prisma.payrollInput.create({ data: { payrollCycleId: cycle.id, employeeId: r.employeeId, inputTypeId: type.id, amount, description: `Salary revision arrears (${months})`.slice(0, 250), addedBy: u.userId } })
    await prisma.salaryRevision.update({ where: { id }, data: { arrearsInputId: input.id, arrearsPostedAt: new Date() } })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'PAYROLL_INPUT_ADDED', entityType: 'payroll_input', entityId: input.id, newValue: { salaryRevisionId: id, employeeId: r.employeeId, amount } } })
    return { posted: true, payrollInputId: input.id, amount }
  },
}

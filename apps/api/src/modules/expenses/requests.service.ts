import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { actOnApproval, approvalTrail, closeApproval, Level, startApproval } from '../approvals/approvals.service'

// Pre-approval: before spending, the person asks for money, travel or accommodation (how much, for what, why).
// It goes up the reporting line, or through the approval chain HR set for "pre_approval". Once approved, Finance
// (Payroll admins) sees it and the bills are submitted against it as expense claims. Finance closes it when settled.

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const RequestBody = z.object({
  kind: z.enum(['money', 'travel', 'accommodation']),
  purpose: z.string().trim().min(3).max(200),
  justification: z.string().trim().min(10).max(2000),
  amount: z.number().positive().max(1e10),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  destination: z.string().trim().min(2).max(120).optional(),
  startDate: ymd.optional(),
  endDate: ymd.optional(),
}).strict()
type Body = z.infer<typeof RequestBody>

const KIND: Record<string, string> = { money: 'Money', travel: 'Travel', accommodation: 'Accommodation' }
const finance = (u: AccessUser) => u.roleIds.includes('payroll_admin') || u.roleIds.includes('hr_admin')
const d = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null)
const date = (s?: string) => (s ? new Date(`${s}T00:00:00.000Z`) : null)
const audit = (u: AccessUser, action: string, id: string, newValue?: object) =>
  prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action, entityType: 'expense_request', entityId: id, newValue: newValue as any } })

const include = {
  employee: { select: { firstName: true, lastName: true, employeeCode: true, userId: true } },
  claims: { select: { id: true, homeAmount: true, homeCurrency: true, status: true, description: true, expenseDate: true } },
}
function shape(r: any) {
  const live = r.claims.filter((c: any) => !['rejected', 'withdrawn'].includes(c.status))
  return {
    id: r.id, employeeId: r.employeeId, employee: `${r.employee.firstName} ${r.employee.lastName} (${r.employee.employeeCode})`, kind: r.kind, purpose: r.purpose,
    justification: r.justification, amount: r.amount, currency: r.currency, destination: r.destination, startDate: d(r.startDate), endDate: d(r.endDate),
    status: r.status, decisionNote: r.decisionNote, decidedAt: r.decidedAt, createdAt: r.createdAt,
    claimed: Math.round(live.reduce((s: number, c: any) => s + Number(c.homeAmount), 0) * 100) / 100,
    claims: r.claims.map((c: any) => ({ ...c, expenseDate: d(c.expenseDate) })),
  }
}

// Up the reporting line: the manager, then their manager; with no manager, HR
async function hierarchy(employeeId: string): Promise<Level[]> {
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { manager: { select: { managerId: true } } } })
  if (!e?.manager) return [{ kind: 'hr' }]
  return e.manager.managerId ? [{ kind: 'manager' }, { kind: 'skip_manager' }] : [{ kind: 'manager' }]
}

export const expenseRequestService = {
  async create(u: AccessUser, b: Body) {
    if (!u.employeeId) throw new AppError('Only employees can raise a pre-approval request', 403)
    if (b.kind !== 'money' && (!b.destination || !b.startDate || !b.endDate)) throw new AppError(`${KIND[b.kind]} needs a destination and dates`, 400)
    if (b.startDate && b.endDate && b.endDate < b.startDate) throw new AppError('The end date is before the start date', 400)
    const tenant = await prisma.tenant.findUnique({ where: { id: u.tenantId }, select: { baseCurrency: true } })
    const row = await prisma.expenseRequest.create({
      data: {
        tenantId: u.tenantId, employeeId: u.employeeId, kind: b.kind, purpose: b.purpose, justification: b.justification, amount: b.amount,
        currency: b.currency ?? tenant?.baseCurrency ?? 'ZMW', destination: b.destination ?? null, startDate: date(b.startDate), endDate: date(b.endDate),
      },
    })
    await startApproval(u.tenantId, 'pre_approval', row.id, u.employeeId, {}, await hierarchy(u.employeeId))
    await audit(u, 'PRE_APPROVAL_REQUESTED', row.id, { kind: b.kind, amount: b.amount, currency: row.currency, purpose: b.purpose })
    return shape(await prisma.expenseRequest.findUnique({ where: { id: row.id }, include }))
  },

  // mine: my own · finance: approved and settled ones (Finance and HR) · all: everything (Finance and HR)
  async list(u: AccessUser, scope: 'mine' | 'finance' | 'all') {
    if (scope !== 'mine' && !finance(u)) throw new AppError('Only Finance and HR see everyone’s requests', 403)
    const where: any = { tenantId: u.tenantId, ...(scope === 'mine' ? { employeeId: u.employeeId ?? '-' } : scope === 'finance' ? { status: { in: ['approved', 'closed'] } } : {}) }
    const rows = await prisma.expenseRequest.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: 300 })
    return rows.map(shape)
  },

  async get(u: AccessUser, id: string) {
    const r = await prisma.expenseRequest.findFirst({ where: { id, tenantId: u.tenantId }, include })
    if (!r) throw new AppError('Request not found', 404)
    const steps = await prisma.approvalStep.findMany({ where: { tenantId: u.tenantId, requestType: 'pre_approval', requestId: id }, select: { status: true, kind: true, userId: true } })
    const own = r.employeeId === u.employeeId
    // Approvers in the chain can open it too
    if (!own && !finance(u) && !(await actedOrCanAct(u, id, steps.length))) throw new AppError('Request not found', 404)
    return { ...shape(r), trail: await approvalTrail(u.tenantId, 'pre_approval', id) }
  },

  // Called from the Approvals module for each step; when the last level approves (or anyone rejects), the request is decided
  async decide(u: AccessUser, id: string, approve: boolean, comments?: string, override = false) {
    const r = await prisma.expenseRequest.findFirst({ where: { id, tenantId: u.tenantId }, include })
    if (!r) throw new AppError('Request not found', 404)
    if (r.status !== 'pending') throw new AppError(`This request is already ${r.status}`, 400)
    if (!approve && !comments?.trim()) throw new AppError('Give a reason for rejecting', 400)
    const step = await actOnApproval(u, 'pre_approval', id, r.employeeId, approve, comments, { override })
    if (!step.final) return { status: 'pending', level: step.level, of: step.of }
    const status = approve ? 'approved' : 'rejected'
    const done = await prisma.expenseRequest.updateMany({ where: { id, status: 'pending' }, data: { status, decidedBy: u.userId, decidedAt: new Date(), decisionNote: comments?.trim() || null } })
    if (!done.count) throw new AppError('Someone else just decided this request', 409)
    await audit(u, approve ? 'PRE_APPROVAL_APPROVED' : 'PRE_APPROVAL_REJECTED', id, { comments })
    const what = `${KIND[r.kind]}: ${r.currency} ${Number(r.amount).toLocaleString('en')} for ${r.purpose}`
    if (r.employee.userId) await notify({ tenantId: u.tenantId, userIds: [r.employee.userId], type: `pre_approval.${status}`, title: `Pre-approval ${status}: ${r.purpose}`, body: approve ? `${what}. Submit the bills against it under Expenses.` : `Reason: ${comments}`, link: '/expenses?tab=requests', entityType: 'expense_request', entityId: id })
    if (approve) {
      const fin = (await userIdsWithRole(u.tenantId, 'payroll_admin')).filter((x) => x !== r.employee.userId)
      await notify({ tenantId: u.tenantId, userIds: fin, type: 'pre_approval.for_finance', title: `Approved spend: ${r.employee.firstName} ${r.employee.lastName}`, body: what, link: '/expenses?tab=requests', entityType: 'expense_request', entityId: id })
    }
    return { status }
  },

  async withdraw(u: AccessUser, id: string) {
    const r = await prisma.expenseRequest.findFirst({ where: { id, tenantId: u.tenantId, employeeId: u.employeeId ?? '-' } })
    if (!r) throw new AppError('Request not found', 404)
    const done = await prisma.expenseRequest.updateMany({ where: { id, status: 'pending' }, data: { status: 'withdrawn' } })
    if (!done.count) throw new AppError(`A request that is ${r.status} cannot be withdrawn`, 400)
    await closeApproval(u.tenantId, 'pre_approval', id)
    await audit(u, 'PRE_APPROVAL_WITHDRAWN', id)
    return { status: 'withdrawn' }
  },

  // Finance marks it settled once the bills are in (no more claims against it)
  async close(u: AccessUser, id: string, note?: string) {
    if (!finance(u)) throw new AppError('Only Finance closes a request', 403)
    const r = await prisma.expenseRequest.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!r) throw new AppError('Request not found', 404)
    const done = await prisma.expenseRequest.updateMany({ where: { id, status: 'approved' }, data: { status: 'closed', decisionNote: note?.trim() || r.decisionNote } })
    if (!done.count) throw new AppError('Only an approved request can be closed', 400)
    await audit(u, 'PRE_APPROVAL_CLOSED', id, { note })
    return { status: 'closed' }
  },

  // A bill submitted against a request: it must be the caller's own, approved one
  async assertClaimable(u: AccessUser, id: string) {
    const r = await prisma.expenseRequest.findFirst({ where: { id, tenantId: u.tenantId, employeeId: u.employeeId ?? '-' } })
    if (!r) throw new AppError('Pre-approval request not found', 404)
    if (r.status !== 'approved') throw new AppError(r.status === 'closed' ? 'That request is closed; ask Finance to reopen it' : 'Bills can be submitted once the request is approved', 400)
  },
}

async function actedOrCanAct(u: AccessUser, id: string, steps: number) {
  if (!steps) return false
  const acted = await prisma.approvalStep.count({ where: { tenantId: u.tenantId, requestType: 'pre_approval', requestId: id, actedBy: u.userId } })
  if (acted) return true
  const { pendingApprovals } = await import('../approvals/approvals.service')
  return (await pendingApprovals(u, false)).some((p) => p.requestType === 'pre_approval' && p.requestId === id)
}

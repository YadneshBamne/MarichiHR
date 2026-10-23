import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { actOnApproval, approvalTrail, closeApproval, Level, startApproval } from '../approvals/approvals.service'

// Policy queries (a question to HR, answered within QUERY_SLA_HOURS) and policy exceptions (a request to be treated
// differently under a policy, decided up the approval chain: manager then HR unless HR set a chain).
export const QUERY_SLA_HOURS = 72
const isHR = (u: AccessUser) => u.roleIds.includes('hr_admin')
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
const ymdArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const QueryBody = z.object({ policyId: z.string().uuid().optional(), question: z.string().trim().min(5).max(2000) }).strict()
export const ExceptionBody = z.object({ policyId: z.string().uuid(), request: z.string().trim().min(5).max(500), reason: z.string().trim().min(10).max(2000), startDate: ymdArg.optional(), endDate: ymdArg.optional() }).strict()

async function policyTitles(tenantId: string, ids: (string | null)[]) {
  const rows = await prisma.policy.findMany({ where: { tenantId, id: { in: ids.filter(Boolean) as string[] } }, select: { id: true, title: true } })
  return new Map(rows.map((r) => [r.id, r.title]))
}

async function hierarchy(employeeId: string): Promise<Level[]> {
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { managerId: true } })
  return e?.managerId ? [{ kind: 'manager' }, { kind: 'hr' }] : [{ kind: 'hr' }]
}

export const policyRequestsService = {
  // ─── Queries ──────────────────────────────────────────────
  async ask(u: AccessUser, b: z.infer<typeof QueryBody>) {
    if (b.policyId && !(await prisma.policy.findFirst({ where: { id: b.policyId, tenantId: u.tenantId, active: true } }))) throw new AppError('Policy not found', 404)
    const q = await prisma.policyQuery.create({ data: { tenantId: u.tenantId, policyId: b.policyId ?? null, askedByUserId: u.userId, question: b.question, dueAt: new Date(Date.now() + QUERY_SLA_HOURS * 3_600_000) } })
    // Routed to the policy's owner (e.g. Legal or IT) when it has one, else to HR
    const owner = b.policyId ? (await prisma.policy.findFirst({ where: { id: b.policyId, tenantId: u.tenantId }, select: { ownerUserId: true } }))?.ownerUserId : null
    const to = owner && owner !== u.userId ? [owner] : (await userIdsWithRole(u.tenantId, 'hr_admin')).filter((x) => x !== u.userId)
    await notify({ tenantId: u.tenantId, userIds: to, type: 'policy.query', title: 'New policy question', body: b.question.slice(0, 160), link: '/policies?tab=queries', entityType: 'policy_query', entityId: q.id })
    return q
  },
  async queries(u: AccessUser, scope: 'mine' | 'all' | 'owned') {
    if (scope === 'all' && !isHR(u)) throw new AppError('Only HR sees every question', 403)
    const owned = scope === 'owned' ? (await prisma.policy.findMany({ where: { tenantId: u.tenantId, ownerUserId: u.userId }, select: { id: true } })).map((p) => p.id) : []
    const rows = await prisma.policyQuery.findMany({ where: { tenantId: u.tenantId, ...(scope === 'mine' && { askedByUserId: u.userId }), ...(scope === 'owned' && { policyId: { in: owned } }) }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 300 })
    const [titles, users] = await Promise.all([policyTitles(u.tenantId, rows.map((r) => r.policyId)), prisma.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.askedByUserId, r.answeredBy].filter(Boolean) as string[]) } }, select: { id: true, fullName: true } })])
    const nm = new Map(users.map((x) => [x.id, x.fullName]))
    const now = new Date()
    return rows.map((r) => ({ ...r, policy: r.policyId ? titles.get(r.policyId) ?? null : null, askedBy: nm.get(r.askedByUserId) ?? null, answeredByName: r.answeredBy ? nm.get(r.answeredBy) ?? null : null, overdue: r.status === 'open' && r.dueAt < now }))
  },
  async answer(u: AccessUser, id: string, answer: string, close: boolean) {
    const q = await prisma.policyQuery.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!q) throw new AppError('Question not found', 404)
    const owner = q.policyId ? (await prisma.policy.findFirst({ where: { id: q.policyId, tenantId: u.tenantId }, select: { ownerUserId: true } }))?.ownerUserId : null
    if (!isHR(u) && owner !== u.userId) throw new AppError('Only HR or the policy owner answers this question', 403)
    if (q.status === 'closed') throw new AppError('This question is closed', 400)
    const updated = await prisma.policyQuery.update({ where: { id }, data: { answer, answeredBy: u.userId, answeredAt: new Date(), status: close ? 'closed' : 'answered' } })
    await notify({ tenantId: u.tenantId, userIds: [q.askedByUserId], type: 'policy.query', title: 'Your policy question was answered', body: answer.slice(0, 160), link: '/policies?tab=queries', entityType: 'policy_query', entityId: id })
    return updated
  },

  // ─── Exceptions ───────────────────────────────────────────
  async requestException(u: AccessUser, b: z.infer<typeof ExceptionBody>) {
    if (!u.employeeId) throw new AppError('Only employees can ask for an exception', 403)
    if (!(await prisma.policy.findFirst({ where: { id: b.policyId, tenantId: u.tenantId, active: true } }))) throw new AppError('Policy not found', 404)
    if (b.startDate && b.endDate && b.endDate < b.startDate) throw new AppError('The end date is before the start date', 400)
    const x = await prisma.policyException.create({ data: { tenantId: u.tenantId, policyId: b.policyId, employeeId: u.employeeId, request: b.request, reason: b.reason, startDate: b.startDate ? new Date(`${b.startDate}T00:00:00Z`) : null, endDate: b.endDate ? new Date(`${b.endDate}T00:00:00Z`) : null } })
    await startApproval(u.tenantId, 'policy_exception', x.id, u.employeeId, {}, await hierarchy(u.employeeId))
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'POLICY_EXCEPTION_REQUESTED', entityType: 'policy_exception', entityId: x.id, newValue: { policyId: b.policyId, request: b.request } } })
    return x
  },
  async exceptions(u: AccessUser, scope: 'mine' | 'all') {
    if (scope === 'all' && !isHR(u)) throw new AppError('Only HR sees every exception', 403)
    const rows = await prisma.policyException.findMany({ where: { tenantId: u.tenantId, ...(scope === 'mine' && { employeeId: u.employeeId ?? '-' }) }, orderBy: { createdAt: 'desc' }, take: 300 })
    const [titles, emps] = await Promise.all([policyTitles(u.tenantId, rows.map((r) => r.policyId)), prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, firstName: true, lastName: true } })])
    const en = new Map(emps.map((e) => [e.id, `${e.firstName} ${e.lastName}`]))
    return Promise.all(rows.map(async (r) => ({ ...r, startDate: ymd(r.startDate), endDate: ymd(r.endDate), policy: titles.get(r.policyId) ?? null, employee: en.get(r.employeeId) ?? null, trail: await approvalTrail(u.tenantId, 'policy_exception', r.id) })))
  },
  // Called by the Approvals module for each step
  async decide(u: AccessUser, id: string, approve: boolean, comments?: string, override = false) {
    const x = await prisma.policyException.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!x) throw new AppError('Request not found', 404)
    if (x.status !== 'pending') throw new AppError(`This request is already ${x.status}`, 400)
    if (!approve && !comments?.trim()) throw new AppError('Give a reason for rejecting', 400)
    const step = await actOnApproval(u, 'policy_exception', id, x.employeeId, approve, comments, { override })
    if (!step.final) return { status: 'pending', level: step.level, of: step.of }
    const status = approve ? 'approved' : 'rejected'
    const done = await prisma.policyException.updateMany({ where: { id, status: 'pending' }, data: { status, decidedBy: u.userId, decidedAt: new Date(), decisionNote: comments?.trim() || null } })
    if (!done.count) throw new AppError('Someone else just decided this request', 409)
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: approve ? 'POLICY_EXCEPTION_APPROVED' : 'POLICY_EXCEPTION_REJECTED', entityType: 'policy_exception', entityId: id, newValue: { comments } } })
    const uid = await userIdOfEmployee(u.tenantId, x.employeeId)
    if (uid) await notify({ tenantId: u.tenantId, userIds: [uid], type: `policy.exception.${status}`, title: `Policy exception ${status}`, body: approve ? x.request : `Reason: ${comments}`, link: '/policies?tab=exceptions', entityType: 'policy_exception', entityId: id })
    return { status }
  },
  async withdraw(u: AccessUser, id: string) {
    const r = await prisma.policyException.updateMany({ where: { id, tenantId: u.tenantId, employeeId: u.employeeId ?? '-', status: 'pending' }, data: { status: 'withdrawn' } })
    if (!r.count) throw new AppError('Only your own pending request can be withdrawn', 400)
    await closeApproval(u.tenantId, 'policy_exception', id)
    return { status: 'withdrawn' }
  },
}

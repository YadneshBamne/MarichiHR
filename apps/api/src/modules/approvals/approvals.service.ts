import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, assertCanApprove } from '../../shared/utils/access'

// Approval chains for leave, regularisation and overtime. A chain lists 1-5 levels; each level is the direct manager,
// the manager's manager, HR, or a named person. When a request is raised, its steps are created; the first is
// pending, the rest wait. Whoever may act on the pending step approves (the next step opens) or rejects (the rest are
// skipped). Delegates act for someone who is away. A request with no steps follows the old rule (manager or HR, once).
// Nobody ever approves their own request.

export type RequestType = 'leave' | 'regularisation' | 'overtime' | 'pre_approval'
const LABEL: Record<RequestType, string> = { leave: 'leave', regularisation: 'attendance', overtime: 'overtime', pre_approval: 'pre-approval' }
export interface Level { kind: 'manager' | 'skip_manager' | 'hr' | 'user'; userId?: string }
const isHR = (u: { roleIds: string[] }) => u.roleIds.includes('hr_admin')
const today = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)

// The chain for a request: the first active one (lowest priority) whose leave filters match
export async function chainFor(tenantId: string, type: RequestType, ctx: { leaveTypeId?: string; days?: number } = {}) {
  const chains = await prisma.approvalChain.findMany({ where: { tenantId, requestType: type, active: true }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] })
  return chains.find((c) => (!c.leaveTypeIds.length || (ctx.leaveTypeId && c.leaveTypeIds.includes(ctx.leaveTypeId))) && (c.minDays == null || (ctx.days ?? 0) >= c.minDays)) ?? null
}

// Called when a request is raised. No chain: the fallback levels if given, else nothing (the old rule applies)
export async function startApproval(tenantId: string, type: RequestType, requestId: string, ownerEmployeeId: string, ctx: { leaveTypeId?: string; days?: number } = {}, fallback?: Level[]) {
  const chain = await chainFor(tenantId, type, ctx)
  if (!chain && !fallback?.length) return null
  const levels = (chain?.levels ?? fallback) as unknown as Level[]
  await prisma.approvalStep.createMany({
    data: levels.map((l, i) => ({ tenantId, requestType: type, requestId, level: i + 1, kind: l.kind, userId: l.userId ?? null, status: i === 0 ? 'pending' : 'waiting', pendingSince: i === 0 ? new Date() : null })),
  })
  await notifyApprovers(tenantId, type, requestId, ownerEmployeeId, levels[0])
  return chain?.id ?? 'default'
}

async function ownerChain(employeeId: string) {
  const owner = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, managerId: true, firstName: true, lastName: true } })
  const manager = owner?.managerId ? await prisma.employee.findUnique({ where: { id: owner.managerId }, select: { id: true, managerId: true, userId: true } }) : null
  const skip = manager?.managerId ? await prisma.employee.findUnique({ where: { id: manager.managerId }, select: { id: true, userId: true } }) : null
  return { owner, manager, skip }
}

// The people a level points at (user ids). A missing manager falls to HR, so a request never gets stuck.
async function approversOf(tenantId: string, level: { kind: string; userId?: string | null }, ownerEmployeeId: string): Promise<string[]> {
  const { manager, skip } = await ownerChain(ownerEmployeeId)
  if (level.kind === 'manager' && manager) return [manager.userId]
  if (level.kind === 'skip_manager' && skip) return [skip.userId]
  if (level.kind === 'user' && level.userId) return [level.userId]
  return userIdsWithRole(tenantId, 'hr_admin')
}

// Who someone is standing in for today
async function delegatorsOf(tenantId: string, userId: string) {
  const rows = await prisma.approvalDelegation.findMany({ where: { tenantId, toUserId: userId, active: true, startDate: { lte: today() }, endDate: { gte: today() } }, select: { fromUserId: true } })
  return rows.map((r) => r.fromUserId)
}

async function canAct(u: AccessUser, step: { kind: string; userId: string | null }, ownerEmployeeId: string): Promise<{ ok: boolean; onBehalfOf?: string }> {
  if (u.employeeId === ownerEmployeeId) return { ok: false }
  const approvers = await approversOf(u.tenantId, step, ownerEmployeeId)
  if (approvers.includes(u.userId)) return { ok: true }
  for (const from of await delegatorsOf(u.tenantId, u.userId)) if (approvers.includes(from)) return { ok: true, onBehalfOf: from }
  return { ok: false }
}

async function notifyApprovers(tenantId: string, type: RequestType, requestId: string, ownerEmployeeId: string, level: { kind: string; userId?: string | null }) {
  const users = await approversOf(tenantId, level, ownerEmployeeId)
  const delegates = await prisma.approvalDelegation.findMany({ where: { tenantId, fromUserId: { in: users }, active: true, startDate: { lte: today() }, endDate: { gte: today() } }, select: { toUserId: true } })
  const owner = await prisma.employee.findUnique({ where: { id: ownerEmployeeId }, select: { firstName: true, lastName: true, userId: true } })
  const to = [...users, ...delegates.map((d) => d.toUserId)].filter((x) => x !== owner?.userId)
  await notify({ tenantId, userIds: to, type: 'approval.waiting', title: `${owner?.firstName} ${owner?.lastName}: ${LABEL[type as RequestType] ?? type} request waiting for you`, body: 'Open Approvals to review it', link: '/approvals', entityType: type, entityId: requestId })
}

// Approve or reject a request at its current step. { final: true } means the request is now decided.
export async function actOnApproval(u: AccessUser, type: RequestType, requestId: string, ownerEmployeeId: string, approve: boolean, comments?: string, opts: { override?: boolean } = {}): Promise<{ final: boolean; level?: number; of?: number }> {
  if (opts.override) {
    if (!isHR(u)) throw new AppError('Only HR can override an approval chain', 403)
    if (u.employeeId === ownerEmployeeId) throw new AppError('You cannot decide your own request', 403)
    if (!comments) throw new AppError('Give a reason for overriding', 400)
  }
  const steps = await prisma.approvalStep.findMany({ where: { tenantId: u.tenantId, requestType: type, requestId }, orderBy: { level: 'asc' } })
  if (!steps.length) {
    // No chain: the direct manager or HR, as before, or someone standing in for them
    try {
      await assertCanApprove(u, ownerEmployeeId, u.tenantId, { entityType: type === 'leave' ? 'leave_request' : type === 'regularisation' ? 'attendance_regularisation' : 'overtime_request', entityId: requestId })
    } catch (err) {
      const { manager } = await ownerChain(ownerEmployeeId)
      const [froms, hrs] = await Promise.all([delegatorsOf(u.tenantId, u.userId), userIdsWithRole(u.tenantId, 'hr_admin')])
      const owner = await prisma.employee.findUnique({ where: { id: ownerEmployeeId }, select: { userId: true } })
      const standIn = froms.find((f) => f !== owner?.userId && (f === manager?.userId || hrs.includes(f)))
      if (u.employeeId === ownerEmployeeId || !standIn) throw err
      await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: approve ? 'APPROVAL_STEP_APPROVED' : 'APPROVAL_STEP_REJECTED', entityType: type, entityId: requestId, newValue: { onBehalfOf: standIn } } })
    }
    return { final: true }
  }
  const current = steps.find((s) => s.status === 'pending')
  if (!current) throw new AppError('This request has already been decided', 400)
  const who = opts.override ? { ok: true as const, onBehalfOf: undefined } : await canAct(u, current, ownerEmployeeId)
  if (!who.ok) throw new AppError(u.employeeId === ownerEmployeeId ? 'You cannot approve your own request' : `This request is waiting for level ${current.level} (${describe(current)})`, 403)
  const claimed = await prisma.approvalStep.updateMany({ where: { id: current.id, status: 'pending' }, data: { status: approve ? 'approved' : 'rejected', actedBy: u.userId, onBehalfOf: who.onBehalfOf ?? null, actedAt: new Date(), comments: comments ?? null } })
  if (!claimed.count) throw new AppError('Someone else just acted on this request', 409)
  await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: opts.override ? 'APPROVAL_OVERRIDDEN' : approve ? 'APPROVAL_STEP_APPROVED' : 'APPROVAL_STEP_REJECTED', entityType: type, entityId: requestId, newValue: { level: current.level, of: steps.length, onBehalfOf: who.onBehalfOf ?? null, comments: comments ?? null } } })
  const next = steps.find((s) => s.level === current.level + 1)
  if (!approve || opts.override) {
    await prisma.approvalStep.updateMany({ where: { tenantId: u.tenantId, requestType: type, requestId, status: 'waiting' }, data: { status: 'skipped' } })
    return { final: true, level: current.level, of: steps.length }
  }
  if (!next) return { final: true, level: current.level, of: steps.length }
  await prisma.approvalStep.update({ where: { id: next.id }, data: { status: 'pending', pendingSince: new Date() } })
  await notifyApprovers(u.tenantId, type, requestId, ownerEmployeeId, next)
  return { final: false, level: current.level, of: steps.length }
}

// When a request is withdrawn, its open steps close
export async function closeApproval(tenantId: string, type: RequestType, requestId: string) {
  await prisma.approvalStep.updateMany({ where: { tenantId, requestType: type, requestId, status: { in: ['pending', 'waiting'] } }, data: { status: 'skipped' } })
}

export const describe = (s: { kind: string; userId?: string | null }) => ({ manager: 'their manager', skip_manager: "their manager's manager", hr: 'HR', user: 'a named approver' } as Record<string, string>)[s.kind] ?? s.kind

// ─── Pending lists: mine, and the monitor of everything for HR ─────────────────

async function summaries(tenantId: string, items: { requestType: string; requestId: string }[]) {
  const ids = (t: string) => items.filter((i) => i.requestType === t).map((i) => i.requestId)
  const [leave, reg, ot, pre] = await Promise.all([
    prisma.leaveRequest.findMany({ where: { id: { in: ids('leave') }, employee: { tenantId } }, select: { id: true, employeeId: true, startDate: true, endDate: true, totalDays: true, status: true, leaveType: { select: { name: true } }, employee: { select: { firstName: true, lastName: true, employeeCode: true } } } }),
    prisma.attendanceRegularisation.findMany({ where: { id: { in: ids('regularisation') }, employee: { tenantId } }, select: { id: true, employeeId: true, date: true, actualIn: true, actualOut: true, status: true, employee: { select: { firstName: true, lastName: true, employeeCode: true } } } }),
    prisma.overtimeRequest.findMany({ where: { id: { in: ids('overtime') }, employee: { tenantId } }, select: { id: true, employeeId: true, date: true, overtimeHours: true, status: true, employee: { select: { firstName: true, lastName: true, employeeCode: true } } } }),
    prisma.expenseRequest.findMany({ where: { id: { in: ids('pre_approval') }, tenantId }, select: { id: true, employeeId: true, kind: true, purpose: true, amount: true, currency: true, status: true, employee: { select: { firstName: true, lastName: true, employeeCode: true } } } }),
  ])
  const d = (x: Date) => x.toISOString().slice(0, 10)
  const m = new Map<string, { employeeId: string; employee: string; summary: string; status: string }>()
  leave.forEach((r) => m.set(`leave:${r.id}`, { employeeId: r.employeeId, employee: `${r.employee.firstName} ${r.employee.lastName}`, summary: `${r.leaveType.name}, ${r.totalDays} day${r.totalDays === 1 ? '' : 's'} (${d(r.startDate)} – ${d(r.endDate)})`, status: r.status }))
  reg.forEach((r) => m.set(`regularisation:${r.id}`, { employeeId: r.employeeId, employee: `${r.employee.firstName} ${r.employee.lastName}`, summary: `Attendance on ${d(r.date)}: ${r.actualIn ?? '?'}–${r.actualOut ?? '?'}`, status: r.status }))
  ot.forEach((r) => m.set(`overtime:${r.id}`, { employeeId: r.employeeId, employee: `${r.employee.firstName} ${r.employee.lastName}`, summary: `${r.overtimeHours} h overtime on ${d(r.date)}`, status: r.status }))
  pre.forEach((r) => m.set(`pre_approval:${r.id}`, { employeeId: r.employeeId, employee: `${r.employee.firstName} ${r.employee.lastName}`, summary: `${r.kind === 'money' ? 'Money' : r.kind === 'travel' ? 'Travel' : 'Accommodation'}: ${r.currency} ${Number(r.amount).toLocaleString('en')} for ${r.purpose}`, status: r.status }))
  return m
}

export async function pendingApprovals(u: AccessUser, all: boolean) {
  const steps = await prisma.approvalStep.findMany({ where: { tenantId: u.tenantId, status: 'pending' }, orderBy: { pendingSince: 'asc' }, take: 500 })
  const totals = await prisma.approvalStep.groupBy({ by: ['requestType', 'requestId'], where: { tenantId: u.tenantId, requestId: { in: steps.map((s) => s.requestId) } }, _count: true })
  const info = await summaries(u.tenantId, steps)
  const out = []
  for (const s of steps) {
    const meta = info.get(`${s.requestType}:${s.requestId}`)
    if (!meta || meta.status !== 'pending') continue
    const mine = (await canAct(u, s, meta.employeeId)).ok
    if (!all && !mine) continue
    const approvers = all ? await approversOf(u.tenantId, s, meta.employeeId) : []
    const names = approvers.length ? (await prisma.user.findMany({ where: { id: { in: approvers } }, select: { fullName: true } })).map((x) => x.fullName) : []
    out.push({
      requestType: s.requestType, requestId: s.requestId, employeeId: meta.employeeId, employee: meta.employee, summary: meta.summary, level: s.level,
      of: totals.find((t) => t.requestId === s.requestId && t.requestType === s.requestType)?._count ?? 1, waitingFor: describe(s), approvers: names, pendingSince: s.pendingSince, canAct: mine,
    })
  }
  return out
}

// The trail shown on a request
export async function approvalTrail(tenantId: string, type: RequestType, requestId: string) {
  const steps = await prisma.approvalStep.findMany({ where: { tenantId, requestType: type, requestId }, orderBy: { level: 'asc' } })
  const users = await prisma.user.findMany({ where: { id: { in: steps.flatMap((s) => [s.actedBy, s.onBehalfOf].filter(Boolean) as string[]) } }, select: { id: true, fullName: true } })
  const nm = (id: string | null) => (id ? users.find((x) => x.id === id)?.fullName ?? null : null)
  return steps.map((s) => ({ level: s.level, waitingFor: describe(s), status: s.status, by: nm(s.actedBy), onBehalfOf: nm(s.onBehalfOf), at: s.actedAt, comments: s.comments }))
}

// ─── Admin: chains and delegations ────────────────────────────────────────────

const audit = (u: AccessUser, action: string, entityId: string, newValue: any) => prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action, entityType: 'approval_chain', entityId, newValue } })

export const chainService = {
  list: (tenantId: string) => prisma.approvalChain.findMany({ where: { tenantId }, orderBy: [{ requestType: 'asc' }, { active: 'desc' }, { priority: 'asc' }] }),
  async save(u: AccessUser, id: string | null, b: { requestType?: RequestType; name?: string; priority?: number; leaveTypeIds?: string[]; minDays?: number | null; levels?: Level[]; active?: boolean }) {
    if (b.levels) {
      for (const l of b.levels) if (l.kind === 'user' && !(l.userId && (await prisma.user.findFirst({ where: { id: l.userId, tenantId: u.tenantId, active: true } })))) throw new AppError('Named approver not found', 404)
      if (b.levels.filter((l) => l.kind === 'manager').length > 1) throw new AppError('The manager can only be one level', 400)
    }
    if (b.leaveTypeIds?.length && (await prisma.leaveType.count({ where: { tenantId: u.tenantId, id: { in: b.leaveTypeIds } } })) !== b.leaveTypeIds.length) throw new AppError('Leave type not found', 404)
    if (id) {
      const row = await prisma.approvalChain.findFirst({ where: { id, tenantId: u.tenantId } })
      if (!row) throw new AppError('Approval chain not found', 404)
      const { requestType: _t, ...rest } = b
      const updated = await prisma.approvalChain.update({ where: { id }, data: { ...rest, levels: (b.levels ?? undefined) as any } })
      await audit(u, 'APPROVAL_CHAIN_UPDATED', id, b)
      return updated
    }
    const row = await prisma.approvalChain.create({ data: { tenantId: u.tenantId, requestType: b.requestType!, name: b.name!, priority: b.priority ?? 100, leaveTypeIds: b.leaveTypeIds ?? [], minDays: b.minDays ?? null, levels: b.levels as any, active: b.active ?? true } })
    await audit(u, 'APPROVAL_CHAIN_CREATED', row.id, b)
    return row
  },
}

export const delegationService = {
  async list(u: AccessUser) {
    const where = isHR(u) ? { tenantId: u.tenantId } : { tenantId: u.tenantId, OR: [{ fromUserId: u.userId }, { toUserId: u.userId }] }
    const rows = await prisma.approvalDelegation.findMany({ where, orderBy: { startDate: 'desc' }, take: 200 })
    const users = await prisma.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.fromUserId, r.toUserId]) } }, select: { id: true, fullName: true } })
    const nm = (id: string) => users.find((x) => x.id === id)?.fullName ?? null
    return rows.map((r) => ({ ...r, from: nm(r.fromUserId), to: nm(r.toUserId), startDate: r.startDate.toISOString().slice(0, 10), endDate: r.endDate.toISOString().slice(0, 10) }))
  },
  // People delegate their own approvals; HR can set one up for anyone
  async create(u: AccessUser, b: { fromUserId?: string; toUserId: string; startDate: string; endDate: string; reason?: string }) {
    const from = b.fromUserId ?? u.userId
    if (from !== u.userId && !isHR(u)) throw new AppError('You can only delegate your own approvals', 403)
    if (from === b.toUserId) throw new AppError('Choose someone else to approve for you', 400)
    if (b.endDate < b.startDate) throw new AppError('The end date is before the start date', 400)
    const [f, t] = await Promise.all([prisma.user.findFirst({ where: { id: from, tenantId: u.tenantId } }), prisma.user.findFirst({ where: { id: b.toUserId, tenantId: u.tenantId, active: true } })])
    if (!f || !t) throw new AppError('Person not found', 404)
    const row = await prisma.approvalDelegation.create({ data: { tenantId: u.tenantId, fromUserId: from, toUserId: b.toUserId, startDate: new Date(`${b.startDate}T00:00:00.000Z`), endDate: new Date(`${b.endDate}T00:00:00.000Z`), reason: b.reason ?? null } })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'APPROVALS_DELEGATED', entityType: 'user', entityId: from, newValue: { to: b.toUserId, from: b.startDate, until: b.endDate } } })
    await notify({ tenantId: u.tenantId, userIds: [b.toUserId], type: 'approval.delegated', title: `${f.fullName} asked you to approve for them`, body: `${b.startDate} to ${b.endDate}`, link: '/approvals', entityType: 'user', entityId: from })
    return row
  },
  async end(u: AccessUser, id: string) {
    const row = await prisma.approvalDelegation.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!row || !(isHR(u) || row.fromUserId === u.userId)) throw new AppError('Delegation not found', 404)
    await prisma.approvalDelegation.update({ where: { id }, data: { active: false } })
    return { ended: true }
  },
}

export { userIdOfEmployee }

import crypto from 'crypto'
import { prisma } from '../../infrastructure/database/prisma'
import { eventBus } from '../../infrastructure/events/eventBus'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'

// Confidential grievance desk. Anonymous cases never store who raised them: the raiser keeps a case key (shown once)
// and we keep only its SHA-256. Nothing about an anonymous raiser goes into notifications or the audit log.

export const CATEGORIES = ['Harassment', 'Discrimination', 'Pay & benefits', 'Workplace safety', 'Manager or team conflict', 'Policy violation', 'Facilities', 'Other'] as const
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const SLA_DAYS: Record<string, number> = { critical: 2, high: 5, medium: 7, low: 14 }
const STATUSES = ['open', 'in_review', 'resolved', 'closed'] as const
type Severity = (typeof SEVERITIES)[number]
type Status = (typeof STATUSES)[number]

const hashKey = (key: string) => crypto.createHash('sha256').update(key.trim()).digest('hex')
const isHandler = (user: AccessUser) => user.roleIds.includes('hr_admin')

async function nextTicket(tenantId: string) {
  const n = await prisma.grievance.count({ where: { tenantId } })
  return `GRV-${String(n + 1).padStart(4, '0')}`
}

// A case as the raiser sees it: no internal notes, no handler identity beyond "HR"
const forRaiser = (g: any) => ({
  id: g.id, ticketNo: g.ticketNo, category: g.category, subject: g.subject, description: g.description, severity: g.severity, anonymous: g.anonymous,
  status: g.status, resolution: g.resolution, createdAt: g.createdAt, resolvedAt: g.resolvedAt,
  messages: (g.messages ?? []).filter((m: any) => !m.internal).map((m: any) => ({ id: m.id, from: m.authorRole === 'raiser' ? 'you' : 'HR', body: m.body, createdAt: m.createdAt })),
})

async function caseForHandler(user: AccessUser, id: string) {
  const g = await prisma.grievance.findFirst({ where: { id, tenantId: user.tenantId }, include: { messages: { orderBy: { createdAt: 'asc' } } } })
  if (!g) throw new AppError('Case not found', 404)
  return g
}

const audit = (user: AccessUser, action: string, entityId: string, newValue?: any) =>
  prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action, entityType: 'grievance', entityId, newValue } })

export const grievanceService = {
  async raise(user: AccessUser, body: { category: string; subject: string; description: string; severity?: Severity; anonymous?: boolean }) {
    const severity = body.severity ?? 'medium'
    const anonymous = !!body.anonymous
    const caseKey = anonymous ? `${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}` : null
    let g: Awaited<ReturnType<typeof prisma.grievance.create>> | null = null
    for (let attempt = 0; attempt < 5 && !g; attempt++) {
      try {
        g = await prisma.grievance.create({
          data: {
            tenantId: user.tenantId, ticketNo: await nextTicket(user.tenantId), category: body.category, subject: body.subject, description: body.description,
            severity, anonymous, raisedByUserId: anonymous ? null : user.userId, caseKeyHash: caseKey ? hashKey(caseKey) : null,
            dueAt: new Date(Date.now() + SLA_DAYS[severity] * 86_400_000),
          },
        })
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err // two cases raised at the same moment: take the next number
      }
    }
    if (!g) throw new AppError('Could not file the case, please try again', 503)
    // HR hears about it (category and severity only); an anonymous case leaves no trace of who raised it
    await eventBus.publish(user.tenantId, 'grievance.raised', { grievanceId: g.id })
    if (!anonymous) await audit(user, 'GRIEVANCE_RAISED', g.id, { ticketNo: g.ticketNo })
    return { id: g.id, ticketNo: g.ticketNo, caseKey, dueAt: g.dueAt }
  },

  async mine(user: AccessUser) {
    const rows = await prisma.grievance.findMany({ where: { tenantId: user.tenantId, raisedByUserId: user.userId }, orderBy: { createdAt: 'desc' } })
    return rows.map((g) => ({ id: g.id, ticketNo: g.ticketNo, subject: g.subject, category: g.category, status: g.status, createdAt: g.createdAt }))
  },

  // The raiser's view of a named case
  async mineOne(user: AccessUser, id: string) {
    const g = await prisma.grievance.findFirst({ where: { id, tenantId: user.tenantId, raisedByUserId: user.userId }, include: { messages: { orderBy: { createdAt: 'asc' } } } })
    if (!g) throw new AppError('Case not found', 404)
    return forRaiser(g)
  },

  async byKey(user: AccessUser, caseKey: string) {
    const g = await prisma.grievance.findFirst({ where: { tenantId: user.tenantId, anonymous: true, caseKeyHash: hashKey(caseKey) }, include: { messages: { orderBy: { createdAt: 'asc' } } } })
    if (!g) throw new AppError('No case matches that key', 404)
    return forRaiser(g)
  },

  // Raiser adds to the conversation (named: by id; anonymous: by case key)
  async raiserReply(user: AccessUser, ref: { id?: string; caseKey?: string }, body: string) {
    const g = ref.caseKey
      ? await prisma.grievance.findFirst({ where: { tenantId: user.tenantId, anonymous: true, caseKeyHash: hashKey(ref.caseKey) } })
      : await prisma.grievance.findFirst({ where: { id: ref.id, tenantId: user.tenantId, raisedByUserId: user.userId } })
    if (!g) throw new AppError('Case not found', 404)
    if (g.status === 'closed') throw new AppError('This case is closed', 400)
    await prisma.grievanceMessage.create({ data: { grievanceId: g.id, authorUserId: g.anonymous ? null : user.userId, authorRole: 'raiser', body } })
    const handlers = g.assignedToUserId ? [g.assignedToUserId] : await userIdsWithRole(user.tenantId, 'hr_admin')
    await notify({ tenantId: user.tenantId, userIds: handlers, type: 'grievance.reply', title: `New message on ${g.ticketNo}`, body: g.subject, link: `/grievances/${g.id}`, entityType: 'grievance', entityId: g.id })
    return { sent: true }
  },

  // ─── HR (hr_admin only) ────────────────────────────────────
  async queue(user: AccessUser, filter: { status?: string }) {
    const rows = await prisma.grievance.findMany({
      where: { tenantId: user.tenantId, ...(filter.status === 'active' ? { status: { in: ['open', 'in_review'] } } : filter.status ? { status: filter.status } : {}) },
      include: { _count: { select: { messages: true } } },
      orderBy: [{ createdAt: 'desc' }],
      take: 500,
    })
    const names = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.raisedByUserId, r.assignedToUserId].filter(Boolean) as string[]))] } }, select: { id: true, fullName: true } })
    const name = new Map(names.map((n) => [n.id, n.fullName]))
    const now = new Date()
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>
    return rows.map((g) => ({
      id: g.id, ticketNo: g.ticketNo, category: g.category, subject: g.subject, severity: g.severity, status: g.status, anonymous: g.anonymous,
      raisedBy: g.anonymous ? null : name.get(g.raisedByUserId!) ?? null, assignedTo: g.assignedToUserId ? name.get(g.assignedToUserId) ?? null : null,
      createdAt: g.createdAt, dueAt: g.dueAt, overdue: ['open', 'in_review'].includes(g.status) && g.dueAt < now, messages: g._count.messages,
    })).sort((a, b) => Number(b.overdue) - Number(a.overdue) || rank[a.severity] - rank[b.severity] || +b.createdAt - +a.createdAt)
  },

  async handlerView(user: AccessUser, id: string) {
    const g = await caseForHandler(user, id)
    const people = await prisma.user.findMany({ where: { id: { in: [...new Set([g.raisedByUserId, g.assignedToUserId, ...g.messages.map((m) => m.authorUserId)].filter(Boolean) as string[])] } }, select: { id: true, fullName: true } })
    const name = new Map(people.map((p) => [p.id, p.fullName]))
    return {
      id: g.id, ticketNo: g.ticketNo, category: g.category, subject: g.subject, description: g.description, severity: g.severity, status: g.status,
      anonymous: g.anonymous, raisedBy: g.anonymous ? null : name.get(g.raisedByUserId!) ?? null, assignedToUserId: g.assignedToUserId,
      resolution: g.resolution, createdAt: g.createdAt, dueAt: g.dueAt, resolvedAt: g.resolvedAt,
      messages: g.messages.map((m) => ({ id: m.id, from: m.authorRole === 'raiser' ? (g.anonymous ? 'Anonymous' : name.get(m.authorUserId!) ?? 'Raiser') : name.get(m.authorUserId!) ?? 'HR', role: m.authorRole, internal: m.internal, body: m.body, createdAt: m.createdAt })),
    }
  },

  async handlerReply(user: AccessUser, id: string, body: string, internal: boolean) {
    const g = await caseForHandler(user, id)
    await prisma.grievanceMessage.create({ data: { grievanceId: g.id, authorUserId: user.userId, authorRole: 'handler', body, internal } })
    const data: Record<string, unknown> = {}
    if (g.status === 'open' && !internal) data.status = 'in_review'
    if (!g.assignedToUserId) data.assignedToUserId = user.userId
    if (Object.keys(data).length) await prisma.grievance.update({ where: { id: g.id }, data })
    if (!internal && g.raisedByUserId) {
      await notify({ tenantId: user.tenantId, userIds: [g.raisedByUserId], type: 'grievance.update', title: `HR replied on ${g.ticketNo}`, body: g.subject, link: `/grievances/mine/${g.id}`, entityType: 'grievance', entityId: g.id })
    }
    await audit(user, internal ? 'GRIEVANCE_NOTE_ADDED' : 'GRIEVANCE_REPLIED', g.id)
    return { sent: true }
  },

  async update(user: AccessUser, id: string, body: { status?: Status; severity?: Severity; assignedToUserId?: string | null; resolution?: string }) {
    const g = await caseForHandler(user, id)
    if (body.assignedToUserId) {
      const ok = await prisma.user.findFirst({ where: { id: body.assignedToUserId, tenantId: user.tenantId, active: true, userRoles: { some: { role: { name: 'hr_admin' } } } } })
      if (!ok) throw new AppError('Cases can only be assigned to an HR admin', 400)
    }
    if ((body.status === 'resolved' || body.status === 'closed') && !(body.resolution ?? g.resolution)) throw new AppError('Write a resolution before resolving or closing the case', 400)
    const data: Record<string, unknown> = {}
    for (const k of ['status', 'severity', 'assignedToUserId', 'resolution'] as const) if (body[k] !== undefined) data[k] = body[k]
    if (body.severity && body.severity !== g.severity) data.dueAt = new Date(g.createdAt.getTime() + SLA_DAYS[body.severity] * 86_400_000)
    if ((body.status === 'resolved' || body.status === 'closed') && !g.resolvedAt) data.resolvedAt = new Date()
    if (body.status && ['open', 'in_review'].includes(body.status)) data.resolvedAt = null
    const updated = await prisma.grievance.update({ where: { id }, data })
    if (body.status && body.status !== g.status && g.raisedByUserId) {
      await notify({ tenantId: user.tenantId, userIds: [g.raisedByUserId], type: 'grievance.update', title: `${g.ticketNo} is now ${body.status.replace('_', ' ')}`, body: g.subject, link: `/grievances/mine/${g.id}`, entityType: 'grievance', entityId: g.id })
    }
    await audit(user, 'GRIEVANCE_UPDATED', id, data)
    return updated
  },

  async handlers(user: AccessUser) {
    return prisma.user.findMany({ where: { tenantId: user.tenantId, active: true, userRoles: { some: { role: { name: 'hr_admin' } } } }, select: { id: true, fullName: true }, orderBy: { fullName: 'asc' } })
  },

  isHandler,
}

import { prisma } from '../../infrastructure/database/prisma'
import { eventBus } from '../../infrastructure/events/eventBus'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { assertTargets, audienceUsers, inAudience, scopeOf } from '../../shared/utils/audience'

export interface AnnouncementIn {
  title: string; body: string; departmentIds?: string[]; workLocationIds?: string[]
  pinned?: boolean; requiresAck?: boolean; publishAt?: string | null; expiresAt?: string | null
}

const live = (now = new Date()) => ({ active: true, publishAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] })

async function find(user: AccessUser, id: string) {
  const a = await prisma.announcement.findFirst({ where: { id, tenantId: user.tenantId, active: true } })
  if (!a) throw new AppError('Announcement not found', 404)
  return a
}

function times(body: Partial<AnnouncementIn>) {
  const publishAt = body.publishAt ? new Date(body.publishAt) : undefined
  const expiresAt = body.expiresAt === null ? null : body.expiresAt ? new Date(body.expiresAt) : undefined
  if (expiresAt && expiresAt <= (publishAt ?? new Date())) throw new AppError('The end date must be after it is published', 400)
  return { publishAt, expiresAt }
}

// Notify the audience once it is live (now, or when the events sweep reaches a scheduled one)
async function publishIfDue(tenantId: string, id: string) {
  const claimed = await prisma.announcement.updateMany({ where: { id, tenantId, notifiedAt: null, ...live() }, data: { notifiedAt: new Date() } })
  if (claimed.count) await eventBus.publish(tenantId, 'announcement.published', { announcementId: id })
}

export const announcementService = {
  // The feed: live announcements this person is in the audience of; pinned first, newest first
  async feed(user: AccessUser, limit = 50) {
    const [rows, scope] = await Promise.all([
      prisma.announcement.findMany({
        where: { tenantId: user.tenantId, ...live() },
        include: { reads: { where: { userId: user.userId } } },
        orderBy: [{ pinned: 'desc' }, { publishAt: 'desc' }],
        take: 200,
      }),
      scopeOf(user.tenantId, user.employeeId),
    ])
    const authors = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, fullName: true, avatarUrl: true } })
    const by = new Map(authors.map((a) => [a.id, a]))
    return rows.filter((a) => inAudience(a, scope)).slice(0, limit).map((a) => ({
      id: a.id, title: a.title, body: a.body, pinned: a.pinned, requiresAck: a.requiresAck, publishAt: a.publishAt, expiresAt: a.expiresAt,
      author: by.get(a.createdById)?.fullName ?? 'HR', authorAvatar: by.get(a.createdById)?.avatarUrl ?? null,
      read: !!a.reads[0], acknowledged: !!a.reads[0]?.acknowledgedAt,
    }))
  },

  async unreadCount(user: AccessUser) {
    return (await announcementService.feed(user, 200)).filter((a) => !a.read || (a.requiresAck && !a.acknowledged)).length
  },

  // HR: everything incl. scheduled and expired, with reach
  async manage(user: AccessUser) {
    const rows = await prisma.announcement.findMany({
      where: { tenantId: user.tenantId, active: true },
      include: { reads: { select: { userId: true, acknowledgedAt: true } } },
      orderBy: { publishAt: 'desc' },
      take: 200,
    })
    const now = new Date()
    return Promise.all(rows.map(async (a) => {
      const audience = await audienceUsers(user.tenantId, a)
      const ids = new Set(audience.map((u) => u.id))
      const reads = a.reads.filter((r) => ids.has(r.userId))
      return {
        id: a.id, title: a.title, body: a.body, pinned: a.pinned, requiresAck: a.requiresAck, publishAt: a.publishAt, expiresAt: a.expiresAt,
        departmentIds: a.departmentIds, workLocationIds: a.workLocationIds,
        status: a.publishAt > now ? 'scheduled' : a.expiresAt && a.expiresAt <= now ? 'expired' : 'live',
        audience: audience.length, read: reads.length, acknowledged: reads.filter((r) => r.acknowledgedAt).length,
      }
    }))
  },

  async create(user: AccessUser, body: AnnouncementIn) {
    if (!(await assertTargets(user.tenantId, body))) throw new AppError('Unknown department or office', 404)
    const { publishAt, expiresAt } = times(body)
    const a = await prisma.announcement.create({
      data: {
        tenantId: user.tenantId, title: body.title, body: body.body, departmentIds: body.departmentIds ?? [], workLocationIds: body.workLocationIds ?? [],
        pinned: body.pinned ?? false, requiresAck: body.requiresAck ?? false, publishAt: publishAt ?? new Date(), expiresAt: expiresAt ?? null, createdById: user.userId,
      },
    })
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action: 'ANNOUNCEMENT_CREATED', entityType: 'announcement', entityId: a.id, newValue: { title: a.title, publishAt: a.publishAt } } })
    await publishIfDue(user.tenantId, a.id)
    return a
  },

  async update(user: AccessUser, id: string, body: Partial<AnnouncementIn>) {
    const before = await find(user, id)
    if ((body.departmentIds || body.workLocationIds) && !(await assertTargets(user.tenantId, body))) throw new AppError('Unknown department or office', 404)
    const { publishAt, expiresAt } = times({ publishAt: body.publishAt ?? before.publishAt.toISOString(), expiresAt: body.expiresAt === undefined ? before.expiresAt?.toISOString() ?? null : body.expiresAt })
    if (before.notifiedAt && body.publishAt) throw new AppError('Already published; the publish time can no longer change', 400)
    const data: Record<string, unknown> = {}
    for (const k of ['title', 'body', 'departmentIds', 'workLocationIds', 'pinned', 'requiresAck'] as const) if (body[k] !== undefined) data[k] = body[k]
    if (body.publishAt) data.publishAt = publishAt
    if (body.expiresAt !== undefined) data.expiresAt = expiresAt
    const a = await prisma.announcement.update({ where: { id }, data })
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action: 'ANNOUNCEMENT_UPDATED', entityType: 'announcement', entityId: id, newValue: data as any } })
    await publishIfDue(user.tenantId, id)
    return a
  },

  async archive(user: AccessUser, id: string) {
    await find(user, id)
    await prisma.announcement.update({ where: { id }, data: { active: false } })
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action: 'ANNOUNCEMENT_ARCHIVED', entityType: 'announcement', entityId: id } })
    return { archived: true }
  },

  // Opening marks it read; "acknowledge" is the explicit "I have read and understood" for ones that ask for it
  async markRead(user: AccessUser, id: string, acknowledge: boolean) {
    const a = await prisma.announcement.findFirst({ where: { id, tenantId: user.tenantId, ...live() } })
    if (!a || !inAudience(a, await scopeOf(user.tenantId, user.employeeId))) throw new AppError('Announcement not found', 404)
    if (acknowledge && !a.requiresAck) throw new AppError('This announcement does not ask for acknowledgement', 400)
    const now = new Date()
    const r = await prisma.announcementRead.upsert({
      where: { announcementId_userId: { announcementId: id, userId: user.userId } },
      create: { announcementId: id, userId: user.userId, ...(acknowledge && { acknowledgedAt: now }) },
      update: acknowledge ? { acknowledgedAt: now } : {},
    })
    return { read: true, acknowledged: !!r.acknowledgedAt }
  },

  // HR: who in the audience has / hasn't read or acknowledged
  async readers(user: AccessUser, id: string) {
    const a = await find(user, id)
    const [audience, reads] = await Promise.all([audienceUsers(user.tenantId, a), prisma.announcementRead.findMany({ where: { announcementId: id } })])
    const r = new Map(reads.map((x) => [x.userId, x]))
    return audience.map((u) => ({ userId: u.id, name: u.fullName, readAt: r.get(u.id)?.readAt ?? null, acknowledgedAt: r.get(u.id)?.acknowledgedAt ?? null }))
      .sort((x, y) => Number(!!x.readAt) - Number(!!y.readAt) || x.name.localeCompare(y.name))
  },

  // events-sweep: scheduled announcements whose time has come
  async publishDue() {
    const due = await prisma.announcement.findMany({ where: { notifiedAt: null, ...live(), tenant: { active: true } }, select: { id: true, tenantId: true }, take: 200 })
    for (const a of due) await publishIfDue(a.tenantId, a.id)
    return due.length
  },
}

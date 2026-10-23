import { randomUUID } from 'crypto'
import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { notify } from '../../infrastructure/notifications/notify'
import { storage, storageConfigured } from '../../infrastructure/storage/storage'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, getReportingSubtreeIds } from '../../shared/utils/access'
import { audienceUsers, scopeOf } from '../../shared/utils/audience'
import { sniff } from '../employees/documents.service'

// Community, beyond spaces/threads/comments:
// - who sees a space: company and news spaces everyone; a team space the manager and everyone below them; a
//   department space the people in that unit and below; HR and the space's moderators always
// - blocked words, tags and follows, attachments, an event calendar, engagement numbers, news auto-posted

export const isHRMod = (u: AccessUser) => u.roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
type Space = { id: string; kind: string; ownerEmployeeId: string | null; orgUnitId: string | null; moderatorUserIds: string[]; active?: boolean }

// The managers above a person, nearest first
async function managerChain(tenantId: string, employeeId?: string | null) {
  const out: string[] = []
  let id = employeeId
  for (let i = 0; id && i < 20; i++) {
    const e = await prisma.employee.findFirst({ where: { id, tenantId }, select: { managerId: true } })
    if (!e?.managerId || out.includes(e.managerId)) break
    out.push(e.managerId)
    id = e.managerId
  }
  return out
}

export async function viewer(u: AccessUser) {
  const [chain, scope] = await Promise.all([managerChain(u.tenantId, u.employeeId), scopeOf(u.tenantId, u.employeeId)])
  return { chain: new Set(chain), units: scope.units }
}
export const canModerate = (u: AccessUser, s: Space) => isHRMod(u) || s.moderatorUserIds.includes(u.userId)
export function canSee(u: AccessUser, s: Space, v: { chain: Set<string>; units: Set<string> }) {
  if (canModerate(u, s)) return true
  if (s.kind === 'team') return !!s.ownerEmployeeId && (s.ownerEmployeeId === u.employeeId || v.chain.has(s.ownerEmployeeId))
  if (s.kind === 'department') return !!s.orgUnitId && v.units.has(s.orgUnitId)
  return true
}
export async function visibleSpaceIds(u: AccessUser) {
  const [spaces, v] = await Promise.all([prisma.forumSpace.findMany({ where: { tenantId: u.tenantId, active: true } }), viewer(u)])
  return spaces.filter((s) => canSee(u, s, v)).map((s) => s.id)
}
// Everyone who can read a space (for pinned posts and events)
export async function spaceAudience(tenantId: string, s: Space | null) {
  if (!s || s.kind === 'company' || s.kind === 'news') return (await prisma.user.findMany({ where: { tenantId, active: true }, select: { id: true } })).map((x) => x.id)
  if (s.kind === 'department' && s.orgUnitId) return [...(await audienceUsers(tenantId, { departmentIds: [s.orgUnitId], workLocationIds: [] })).map((x) => x.id), ...s.moderatorUserIds]
  if (s.kind === 'team' && s.ownerEmployeeId) {
    const ids = [s.ownerEmployeeId, ...(await getReportingSubtreeIds(s.ownerEmployeeId, tenantId))]
    return (await prisma.employee.findMany({ where: { tenantId, id: { in: ids }, active: true }, select: { userId: true } })).map((e) => e.userId).filter((x): x is string => !!x)
  }
  return s.moderatorUserIds
}

// ─── Settings and the word filter ───────────────────────────────────────────────────────────────────────
export async function forumSettings(tenantId: string) {
  const s = await prisma.forumSettings.findUnique({ where: { tenantId } })
  return { blockedWords: s?.blockedWords ?? [], autoNews: s?.autoNews ?? true }
}
export async function assertClean(tenantId: string, ...texts: (string | undefined)[]) {
  const { blockedWords } = await forumSettings(tenantId)
  if (!blockedWords.length) return
  const text = texts.filter(Boolean).join(' ').toLowerCase()
  const hit = blockedWords.find((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(text))
  if (hit) throw new AppError(`Please rephrase: “${hit}” is not allowed in Community`, 400)
}
export const cleanTags = (tags?: string[]) => [...new Set((tags ?? []).map((t) => t.trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')).filter((t) => t.length >= 2))].slice(0, 5)

// ─── Attachments ────────────────────────────────────────────────────────────────────────────────────────
export const FORUM_MAX_BYTES = 5 * 1024 * 1024
export async function attachments(u: AccessUser, ids?: string[]) {
  if (!ids?.length) return []
  const rows = await prisma.forumAttachment.findMany({ where: { tenantId: u.tenantId, id: { in: ids }, uploadedBy: u.userId } })
  if (rows.length !== new Set(ids).size) throw new AppError('Attachment not found', 404)
  return rows.map((r) => ({ id: r.id, fileName: r.fileName, mimeType: r.mimeType, size: r.size }))
}

export const forumExtras = {
  async settings(u: AccessUser) {
    if (!isHRMod(u)) throw new AppError('Only HR changes Community settings', 403)
    return forumSettings(u.tenantId)
  },
  async saveSettings(u: AccessUser, b: { blockedWords?: string[]; autoNews?: boolean }) {
    if (!isHRMod(u)) throw new AppError('Only HR changes Community settings', 403)
    const data = { ...(b.blockedWords && { blockedWords: [...new Set(b.blockedWords.map((w) => w.trim()).filter(Boolean))].slice(0, 200) }), ...(b.autoNews !== undefined && { autoNews: b.autoNews }) }
    await prisma.forumSettings.upsert({ where: { tenantId: u.tenantId }, update: data, create: { tenantId: u.tenantId, ...data } })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'FORUM_SETTINGS_UPDATED', entityType: 'forum_settings', entityId: u.tenantId, newValue: data } })
    return forumSettings(u.tenantId)
  },

  async upload(u: AccessUser, file?: { buffer: Buffer; originalname: string; size: number }) {
    if (!storageConfigured()) throw new AppError('File storage is not set up yet', 503)
    if (!file) throw new AppError('Choose a file', 400)
    if (file.size > FORUM_MAX_BYTES) throw new AppError('Attachments can be up to 5 MB', 400)
    const mimeType = sniff(file.buffer, file.originalname)
    if (!mimeType) throw new AppError('Attach a PDF, JPG, PNG, WebP or Word document', 400)
    const id = randomUUID()
    const fileName = file.originalname.normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').slice(-120) || 'file'
    const fileKey = `${u.tenantId}/forum/${id}/${fileName}`
    await storage().put(fileKey, file.buffer, mimeType)
    const a = await prisma.forumAttachment.create({ data: { id, tenantId: u.tenantId, fileKey, fileName, mimeType, size: file.size, uploadedBy: u.userId } })
    return { id: a.id, fileName: a.fileName, mimeType: a.mimeType, size: a.size }
  },
  // A short-lived link, only if the post carrying the file is visible to the person (or they uploaded it)
  async download(u: AccessUser, id: string) {
    const a = await prisma.forumAttachment.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!a) throw new AppError('Not found', 404)
    if (a.uploadedBy !== u.userId) {
      const needle = [{ id }]
      const thread = await prisma.forumThread.findFirst({ where: { tenantId: u.tenantId, attachments: { array_contains: needle } }, include: { space: true } })
        ?? (await prisma.forumComment.findFirst({ where: { tenantId: u.tenantId, attachments: { array_contains: needle } }, include: { thread: { include: { space: true } } } }))?.thread
      if (!thread || (thread.hidden && !canModerate(u, thread.space)) || !canSee(u, thread.space, await viewer(u))) throw new AppError('Not found', 404)
    }
    return { url: await storage().signedUrl(a.fileKey, 300, a.fileName), fileName: a.fileName }
  },

  // ─── Follows ────────────────────────────────────────────────────────────────────────────────────────────
  async follows(u: AccessUser) {
    return prisma.forumFollow.findMany({ where: { tenantId: u.tenantId, userId: u.userId }, select: { kind: true, key: true } })
  },
  async follow(u: AccessUser, b: { kind: 'tag' | 'user' | 'space'; key: string; on: boolean }) {
    const key = b.kind === 'tag' ? cleanTags([b.key])[0] : b.key
    if (!key) throw new AppError('Give a tag of 2 or more letters', 400)
    if (b.kind === 'user' && !(await prisma.user.findFirst({ where: { id: key, tenantId: u.tenantId } }))) throw new AppError('Person not found', 404)
    if (b.kind === 'space' && !(await visibleSpaceIds(u)).includes(key)) throw new AppError('Space not found', 404)
    if (b.on) await prisma.forumFollow.upsert({ where: { tenantId_userId_kind_key: { tenantId: u.tenantId, userId: u.userId, kind: b.kind, key } }, update: {}, create: { tenantId: u.tenantId, userId: u.userId, kind: b.kind, key } })
    else await prisma.forumFollow.deleteMany({ where: { tenantId: u.tenantId, userId: u.userId, kind: b.kind, key } })
    return { following: b.on }
  },

  // ─── Events ─────────────────────────────────────────────────────────────────────────────────────────────
  async events(u: AccessUser, from: string, to: string) {
    const visible = new Set(await visibleSpaceIds(u))
    const rows = await prisma.forumEvent.findMany({ where: { tenantId: u.tenantId, startsAt: { gte: new Date(from), lte: new Date(`${to}T23:59:59Z`) } }, include: { rsvps: true }, orderBy: { startsAt: 'asc' } })
    const spaces = await prisma.forumSpace.findMany({ where: { tenantId: u.tenantId, id: { in: rows.map((r) => r.spaceId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })
    return rows.filter((e) => !e.spaceId || visible.has(e.spaceId)).map((e) => ({
      id: e.id, title: e.title, description: e.description, kind: e.kind, startsAt: e.startsAt, endsAt: e.endsAt, location: e.location, cancelled: e.cancelled,
      space: spaces.find((s) => s.id === e.spaceId)?.name ?? null, spaceId: e.spaceId, mine: e.createdBy === u.userId,
      going: e.rsvps.filter((r) => r.status === 'going').length, maybe: e.rsvps.filter((r) => r.status === 'maybe').length, myRsvp: e.rsvps.find((r) => r.userId === u.userId)?.status ?? null,
    }))
  },
  async createEvent(u: AccessUser, b: z.infer<typeof EventBody>) {
    let space: Space | null = null
    if (b.spaceId) {
      space = await prisma.forumSpace.findFirst({ where: { id: b.spaceId, tenantId: u.tenantId, active: true } })
      if (!space) throw new AppError('Space not found', 404)
      if (!canModerate(u, space)) throw new AppError('Only the space’s moderators add its events', 403)
    } else if (!isHRMod(u)) throw new AppError('Only HR adds company events', 403)
    if (b.endsAt && b.endsAt < b.startsAt) throw new AppError('The event ends before it starts', 400)
    await assertClean(u.tenantId, b.title, b.description)
    const e = await prisma.forumEvent.create({ data: { tenantId: u.tenantId, title: b.title, description: b.description ?? '', kind: b.kind, startsAt: new Date(b.startsAt), endsAt: b.endsAt ? new Date(b.endsAt) : null, location: b.location ?? '', spaceId: b.spaceId ?? null, createdBy: u.userId } })
    const when = new Date(b.startsAt).toUTCString().slice(0, 22)
    await notify({ tenantId: u.tenantId, userIds: (await spaceAudience(u.tenantId, space)).filter((x) => x !== u.userId), type: 'forum.event', title: `New event: ${b.title}`, body: `${when} UTC${b.location ? ` · ${b.location}` : ''}`, link: '/community?tab=events', entityType: 'forum_event', entityId: e.id })
    return e
  },
  async cancelEvent(u: AccessUser, id: string) {
    const e = await prisma.forumEvent.findFirst({ where: { id, tenantId: u.tenantId }, include: { rsvps: true } })
    if (!e) throw new AppError('Event not found', 404)
    const space = e.spaceId ? await prisma.forumSpace.findFirst({ where: { id: e.spaceId } }) : null
    if (e.createdBy !== u.userId && !isHRMod(u) && !(space && canModerate(u, space))) throw new AppError('Only its organiser or HR cancels it', 403)
    await prisma.forumEvent.update({ where: { id }, data: { cancelled: true } })
    await notify({ tenantId: u.tenantId, userIds: e.rsvps.filter((r) => r.status !== 'no').map((r) => r.userId), type: 'forum.event', title: `Cancelled: ${e.title}`, body: 'The organiser cancelled this event.', link: '/community?tab=events', entityType: 'forum_event', entityId: e.id })
    return { cancelled: true }
  },
  async rsvp(u: AccessUser, id: string, status: 'going' | 'maybe' | 'no') {
    const e = await prisma.forumEvent.findFirst({ where: { id, tenantId: u.tenantId, cancelled: false } })
    if (!e || (e.spaceId && !(await visibleSpaceIds(u)).includes(e.spaceId))) throw new AppError('Event not found', 404)
    await prisma.forumEventRsvp.upsert({ where: { eventId_userId: { eventId: id, userId: u.userId } }, update: { status }, create: { eventId: id, userId: u.userId, status } })
    return { status }
  },

  // ─── Engagement (HR) ────────────────────────────────────────────────────────────────────────────────────
  async analytics(u: AccessUser, days: number) {
    if (!isHRMod(u)) throw new AppError('Only HR sees Community analytics', 403)
    const since = new Date(Date.now() - days * 86_400_000)
    const where = { tenantId: u.tenantId, createdAt: { gte: since } }
    const [threads, comments, kudos, votes, people, spaces] = await Promise.all([
      prisma.forumThread.findMany({ where, select: { authorUserId: true, spaceId: true, tags: true, createdAt: true } }),
      prisma.forumComment.findMany({ where, select: { authorUserId: true, createdAt: true } }),
      prisma.kudos.findMany({ where, select: { fromUserId: true, createdAt: true } }),
      prisma.forumVote.count({ where: { createdAt: { gte: since }, poll: { thread: { tenantId: u.tenantId } } } }),
      prisma.user.count({ where: { tenantId: u.tenantId, active: true } }),
      prisma.forumSpace.findMany({ where: { tenantId: u.tenantId }, select: { id: true, name: true } }),
    ])
    const posters = new Set([...threads.map((t) => t.authorUserId), ...comments.map((c) => c.authorUserId), ...kudos.map((k) => k.fromUserId)])
    const count = <T,>(xs: T[], key: (x: T) => string) => Object.entries(xs.reduce((a, x) => ({ ...a, [key(x)]: (a[key(x)] ?? 0) + 1 }), {} as Record<string, number>)).sort((a, b) => b[1] - a[1])
    const weekOf = (d: Date) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10) }
    const weeks = count([...threads, ...comments, ...kudos], (x) => weekOf(x.createdAt)).sort((a, b) => a[0].localeCompare(b[0]))
    return {
      days, threads: threads.length, comments: comments.length, kudos: kudos.length, votes, activePeople: posters.size, people,
      participation: people ? Math.round((posters.size / people) * 100) : 0,
      topSpaces: count(threads, (t) => spaces.find((s) => s.id === t.spaceId)?.name ?? '?').slice(0, 5).map(([name, n]) => ({ name, threads: n })),
      topTags: count(threads.flatMap((t) => t.tags.filter((x) => !x.startsWith('event-')).map((tag) => ({ tag }))), (x) => x.tag).slice(0, 10).map(([tag, n]) => ({ tag, threads: n })),
      weekly: weeks.map(([week, n]) => ({ week, posts: n })),
    }
  },
}

export const EventBody = z.object({
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().max(2000).optional(),
  kind: z.enum(['townhall', 'celebration', 'training', 'other']).default('townhall'),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  location: z.string().trim().max(200).optional(),
  spaceId: z.string().uuid().optional(),
}).strict()

// Policy and payroll news for everyone, posted in the News space (made the first time) by the person who acted
// Idempotent per event (events are retried): the event id is kept as a hidden tag
export async function postNews(tenantId: string, authorUserId: string | undefined | null, title: string, body: string, tags: string[], eventId: string) {
  if (!authorUserId || !(await forumSettings(tenantId)).autoNews) return
  if (await prisma.forumThread.findFirst({ where: { tenantId, tags: { has: `event-${eventId}` } } })) return
  let space = await prisma.forumSpace.findFirst({ where: { tenantId, kind: 'news' } })
  if (!space) space = await prisma.forumSpace.upsert({ where: { tenantId_name: { tenantId, name: 'News' } }, update: { kind: 'news', active: true }, create: { tenantId, name: 'News', description: 'Company news, posted automatically when a policy or payroll is published', kind: 'news', createdBy: authorUserId } })
  await prisma.forumThread.create({ data: { tenantId, spaceId: space.id, authorUserId, title: title.slice(0, 160), body, tags: [...tags, `event-${eventId}`] } })
}

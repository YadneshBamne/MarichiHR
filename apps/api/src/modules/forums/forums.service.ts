import { randomUUID } from 'crypto'
import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { awardKudosPoints } from '../incentives/incentive-extras.service'
import { assertClean, attachments, canModerate, canSee, cleanTags, isHRMod, spaceAudience, viewer, visibleSpaceIds } from './forum-extras.service'

// Community: spaces → threads (with an optional poll) → comments; a recognition wall of kudos; reports that HR
// moderates. Hidden content disappears for everyone but moderators. @mentions notify the people mentioned.

export const BADGES = ['teamwork', 'customer', 'innovation', 'leadership', 'above_and_beyond'] as const
const isMod = isHRMod
const mentions = z.array(z.string().uuid()).max(10).optional()

export const ThreadBody = z.object({
  spaceId: z.string().uuid(),
  title: z.string().trim().min(3).max(160),
  body: z.string().trim().min(1).max(10000), // Markdown: **bold**, _italic_, lists, links
  mentions,
  tags: z.array(z.string().trim().max(30)).max(5).optional(),
  attachmentIds: z.array(z.string().uuid()).max(5).optional(),
  poll: z.object({
    question: z.string().trim().min(3).max(200),
    options: z.array(z.string().trim().min(1).max(120)).min(2).max(10),
    multi: z.boolean().default(false),
    closesAt: z.string().datetime({ offset: true }).optional(),
  }).strict().optional(),
}).strict()
export const CommentBody = z.object({ body: z.string().trim().min(1).max(5000), mentions, attachmentIds: z.array(z.string().uuid()).max(5).optional() }).strict()
export const KudosBody = z.object({ toEmployeeId: z.string().uuid(), badge: z.enum(BADGES), message: z.string().trim().min(3).max(500) }).strict()
export const ReportBody = z.object({ targetType: z.enum(['thread', 'comment', 'kudos']), targetId: z.string().uuid(), reason: z.string().trim().min(3).max(500) }).strict()

async function names(userIds: string[]) {
  const rows = await prisma.user.findMany({ where: { id: { in: [...new Set(userIds)] } }, select: { id: true, fullName: true, avatarUrl: true } })
  return new Map(rows.map((r) => [r.id, r]))
}

async function notifyMentions(u: AccessUser, employeeIds: string[] | undefined, title: string, link: string, entityId: string) {
  if (!employeeIds?.length) return
  const users = await prisma.employee.findMany({ where: { tenantId: u.tenantId, id: { in: employeeIds }, active: true }, select: { userId: true } })
  const ids = users.map((x) => x.userId).filter((x): x is string => !!x && x !== u.userId)
  const me = await prisma.user.findUnique({ where: { id: u.userId }, select: { fullName: true } })
  await notify({ tenantId: u.tenantId, userIds: ids, type: 'forum.mention', title: `${me?.fullName ?? 'Someone'} mentioned you`, body: title, link, entityType: 'forum_thread', entityId })
}

async function loadThread(u: AccessUser, id: string) {
  const t = await prisma.forumThread.findFirst({ where: { id, tenantId: u.tenantId }, include: { space: true, poll: { include: { votes: true } } } })
  if (!t || !t.space.active || (t.hidden && !canModerate(u, t.space)) || !canSee(u, t.space, await viewer(u))) throw new AppError('Thread not found', 404)
  return t
}

function pollView(p: any, userId: string) {
  if (!p) return null
  const counts: Record<string, number> = {}
  for (const v of p.votes) for (const o of v.optionIds) counts[o] = (counts[o] ?? 0) + 1
  const mine = p.votes.find((v: any) => v.userId === userId)?.optionIds ?? []
  const closed = !!p.closesAt && p.closesAt < new Date()
  return { id: p.id, question: p.question, multi: p.multi, closesAt: p.closesAt, closed, voters: p.votes.length, options: (p.options as { id: string; label: string }[]).map((o) => ({ ...o, votes: counts[o.id] ?? 0 })), mine }
}

export const forumsService = {
  // ─── Spaces ───────────────────────────────────────────────
  async spaces(u: AccessUser) {
    // Every company starts with a General space
    if (!(await prisma.forumSpace.count({ where: { tenantId: u.tenantId } }))) {
      await prisma.forumSpace.create({ data: { tenantId: u.tenantId, name: 'General', description: 'Anything about work and life here', createdBy: u.userId } }).catch(() => {})
    }
    const [rows, v, follows] = await Promise.all([
      prisma.forumSpace.findMany({ where: { tenantId: u.tenantId, active: true }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { threads: { where: { hidden: false } } } } } }),
      viewer(u),
      prisma.forumFollow.findMany({ where: { tenantId: u.tenantId, userId: u.userId, kind: 'space' }, select: { key: true } }),
    ])
    return rows.filter((s) => canSee(u, s, v)).map((s) => ({ id: s.id, name: s.name, description: s.description, kind: s.kind, threads: s._count.threads, canModerate: canModerate(u, s), following: follows.some((f) => f.key === s.id) }))
  },
  // HR makes company, department or team spaces; a manager makes one space for their own team, which they moderate
  async createSpace(u: AccessUser, b: { name: string; description?: string; kind?: 'company' | 'team' | 'department'; orgUnitId?: string; ownerEmployeeId?: string; moderatorUserIds?: string[] }) {
    const kind = b.kind ?? 'company'
    const hr = isMod(u)
    if (!hr && !(kind === 'team' && u.roleIds.includes('manager'))) throw new AppError('Only HR creates spaces; managers can create one for their team', 403)
    const ownerEmployeeId = kind === 'team' ? (hr ? b.ownerEmployeeId : u.employeeId) : null
    if (kind === 'team' && !ownerEmployeeId) throw new AppError('Choose the team’s manager', 400)
    if (kind === 'team' && !hr && (await prisma.forumSpace.findFirst({ where: { tenantId: u.tenantId, kind: 'team', ownerEmployeeId, active: true } }))) throw new AppError('Your team already has a space', 409)
    if (kind === 'department' && !(b.orgUnitId && (await prisma.orgUnit.findFirst({ where: { id: b.orgUnitId, tenantId: u.tenantId } })))) throw new AppError('Choose the department', 400)
    const owner = ownerEmployeeId ? await prisma.employee.findFirst({ where: { id: ownerEmployeeId, tenantId: u.tenantId }, select: { userId: true } }) : null
    if (ownerEmployeeId && !owner) throw new AppError('Manager not found', 404)
    if (b.moderatorUserIds?.length && (await prisma.user.count({ where: { tenantId: u.tenantId, id: { in: b.moderatorUserIds } } })) !== new Set(b.moderatorUserIds).size) throw new AppError('Moderator not found', 404)
    if (await prisma.forumSpace.findFirst({ where: { tenantId: u.tenantId, name: b.name } })) throw new AppError('A space with that name exists', 409)
    const moderatorUserIds = [...new Set([...(owner?.userId ? [owner.userId] : []), ...(hr ? b.moderatorUserIds ?? [] : [])])]
    return prisma.forumSpace.create({ data: { tenantId: u.tenantId, name: b.name, description: b.description ?? '', kind, ownerEmployeeId, orgUnitId: kind === 'department' ? b.orgUnitId : null, moderatorUserIds, createdBy: u.userId } })
  },
  async archiveSpace(u: AccessUser, id: string) {
    const space = await prisma.forumSpace.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!space || !(isMod(u) || (space.kind === 'team' && canModerate(u, space)))) throw new AppError('Only HR (or the team’s manager) archives a space', 403)
    const r = await prisma.forumSpace.updateMany({ where: { id, tenantId: u.tenantId }, data: { active: false } })
    if (!r.count) throw new AppError('Space not found', 404)
    return { archived: true }
  },

  // ─── Threads ──────────────────────────────────────────────
  async threads(u: AccessUser, spaceId?: string, q?: string, tag?: string, feed?: 'following') {
    const visible = await visibleSpaceIds(u)
    const modSpaces = isMod(u) ? visible : (await prisma.forumSpace.findMany({ where: { tenantId: u.tenantId, id: { in: visible }, moderatorUserIds: { has: u.userId } }, select: { id: true } })).map((x) => x.id)
    const follows = feed === 'following' ? await prisma.forumFollow.findMany({ where: { tenantId: u.tenantId, userId: u.userId } }) : []
    const by = (k: string) => follows.filter((f) => f.kind === k).map((f) => f.key)
    const rows = await prisma.forumThread.findMany({
      where: {
        tenantId: u.tenantId, space: { active: true }, spaceId: spaceId ? (visible.includes(spaceId) ? spaceId : '00000000-0000-0000-0000-000000000000') : { in: visible },
        OR: [{ hidden: false }, { spaceId: { in: modSpaces } }],
        ...(tag && { tags: { has: tag.toLowerCase() } }),
        ...(feed === 'following' && { AND: [{ OR: [{ tags: { hasSome: by('tag') } }, { authorUserId: { in: by('user') } }, { spaceId: { in: by('space') } }] }] }),
        ...(q && { AND: [{ OR: [{ title: { contains: q, mode: 'insensitive' } }, { body: { contains: q, mode: 'insensitive' } }, { tags: { has: q.toLowerCase() } }] }] }),
      },
      orderBy: [{ pinned: 'desc' }, { lastActivityAt: 'desc' }], take: 100,
      include: { space: { select: { name: true } }, poll: { select: { id: true } }, _count: { select: { comments: { where: { hidden: false } } } } },
    })
    const n = await names(rows.map((t) => t.authorUserId))
    return rows.map((t) => ({ id: t.id, spaceId: t.spaceId, space: t.space.name, title: t.title, excerpt: t.body.slice(0, 200), author: n.get(t.authorUserId)?.fullName ?? null, authorUserId: t.authorUserId, tags: t.tags.filter((x) => !x.startsWith('event-')), attachments: (t.attachments as any[]).length, pinned: t.pinned, locked: t.locked, hidden: t.hidden, hasPoll: !!t.poll, comments: t._count.comments, lastActivityAt: t.lastActivityAt, createdAt: t.createdAt }))
  },
  async thread(u: AccessUser, id: string) {
    const t = await loadThread(u, id)
    const mod = canModerate(u, t.space)
    const comments = await prisma.forumComment.findMany({ where: { threadId: id, ...(mod ? {} : { hidden: false }) }, orderBy: { createdAt: 'asc' } })
    const n = await names([t.authorUserId, ...comments.map((c) => c.authorUserId)])
    const person = (id: string) => ({ name: n.get(id)?.fullName ?? null, avatarUrl: n.get(id)?.avatarUrl ?? null })
    return {
      id: t.id, spaceId: t.spaceId, space: t.space.name, title: t.title, body: t.body, author: person(t.authorUserId), authorUserId: t.authorUserId, mine: t.authorUserId === u.userId, tags: t.tags.filter((x) => !x.startsWith('event-')), attachments: t.attachments,
      pinned: t.pinned, locked: t.locked, hidden: t.hidden, createdAt: t.createdAt, canModerate: mod, poll: pollView(t.poll, u.userId),
      comments: comments.map((c) => ({ id: c.id, body: c.body, author: person(c.authorUserId), mine: c.authorUserId === u.userId, hidden: c.hidden, attachments: c.attachments, createdAt: c.createdAt })),
    }
  },
  async createThread(u: AccessUser, b: z.infer<typeof ThreadBody>) {
    const space = await prisma.forumSpace.findFirst({ where: { id: b.spaceId, tenantId: u.tenantId, active: true } })
    if (!space || !canSee(u, space, await viewer(u))) throw new AppError('Space not found', 404)
    if (space.kind === 'news' && !canModerate(u, space)) throw new AppError('Only HR posts in News', 403)
    await assertClean(u.tenantId, b.title, b.body, ...(b.poll ? [b.poll.question, ...b.poll.options] : []))
    const tags = cleanTags(b.tags)
    const files = await attachments(u, b.attachmentIds)
    const t = await prisma.forumThread.create({
      data: {
        tenantId: u.tenantId, spaceId: space.id, authorUserId: u.userId, title: b.title, body: b.body, tags, attachments: files,
        ...(b.poll && { poll: { create: { question: b.poll.question, multi: b.poll.multi, closesAt: b.poll.closesAt ? new Date(b.poll.closesAt) : null, options: b.poll.options.map((label) => ({ id: randomUUID().slice(0, 8), label })) } } }),
      },
    })
    await notifyMentions(u, b.mentions, t.title, `/community/${t.id}`, t.id)
    // People following the space, a tag on it or the author hear about it (if they can see the space)
    const follows = await prisma.forumFollow.findMany({ where: { tenantId: u.tenantId, OR: [{ kind: 'space', key: space.id }, { kind: 'user', key: u.userId }, ...(tags.length ? [{ kind: 'tag', key: { in: tags } }] : [])] }, select: { userId: true } })
    const readers = new Set(await spaceAudience(u.tenantId, space))
    const me = await prisma.user.findUnique({ where: { id: u.userId }, select: { fullName: true } })
    await notify({ tenantId: u.tenantId, userIds: [...new Set(follows.map((f) => f.userId))].filter((x) => x !== u.userId && readers.has(x)), type: 'forum.followed', title: `New in ${space.name}: ${t.title}`, body: `${me?.fullName ?? 'Someone'}${tags.length ? ` · #${tags.join(' #')}` : ''}`, link: `/community/${t.id}`, entityType: 'forum_thread', entityId: t.id })
    return t
  },
  async comment(u: AccessUser, threadId: string, b: z.infer<typeof CommentBody>) {
    const t = await loadThread(u, threadId)
    if (t.locked) throw new AppError('This thread is locked', 400)
    await assertClean(u.tenantId, b.body)
    const files = await attachments(u, b.attachmentIds)
    const c = await prisma.forumComment.create({ data: { tenantId: u.tenantId, threadId, authorUserId: u.userId, body: b.body, attachments: files } })
    await prisma.forumThread.update({ where: { id: threadId }, data: { lastActivityAt: new Date() } })
    // The thread's author hears about replies; mentioned people hear they were mentioned
    if (t.authorUserId !== u.userId) await notify({ tenantId: u.tenantId, userIds: [t.authorUserId], type: 'forum.reply', title: `New reply: ${t.title}`, body: b.body.slice(0, 160), link: `/community/${t.id}`, entityType: 'forum_thread', entityId: t.id })
    await notifyMentions(u, b.mentions, t.title, `/community/${t.id}`, t.id)
    return c
  },
  async vote(u: AccessUser, threadId: string, optionIds: string[]) {
    const t = await loadThread(u, threadId)
    const p = t.poll
    if (!p) throw new AppError('This thread has no poll', 400)
    if (p.closesAt && p.closesAt < new Date()) throw new AppError('The poll is closed', 400)
    const valid = new Set((p.options as { id: string }[]).map((o) => o.id))
    const picked = [...new Set(optionIds)]
    if (!picked.length || picked.some((o) => !valid.has(o))) throw new AppError('Choose one of the options', 400)
    if (!p.multi && picked.length > 1) throw new AppError('Choose only one option', 400)
    await prisma.forumVote.upsert({ where: { pollId_userId: { pollId: p.id, userId: u.userId } }, create: { pollId: p.id, userId: u.userId, optionIds: picked }, update: { optionIds: picked } })
    return pollView(await prisma.forumPoll.findUnique({ where: { id: p.id }, include: { votes: true } }), u.userId)
  },
  // HR moderates everywhere; a team space's manager (or named moderators) moderate that space. Authors are told when
  // their post is hidden; pinning tells everyone who can read the space.
  async moderateThread(u: AccessUser, id: string, b: { pinned?: boolean; locked?: boolean; hidden?: boolean; reason?: string }) {
    const t = await prisma.forumThread.findFirst({ where: { id, tenantId: u.tenantId }, include: { space: true } })
    if (!t) throw new AppError('Thread not found', 404)
    if (!canModerate(u, t.space)) throw new AppError('Only HR or this space’s moderators moderate', 403)
    const { reason, ...data } = b
    await prisma.forumThread.update({ where: { id }, data })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'FORUM_MODERATED', entityType: 'forum_thread', entityId: id, newValue: b } })
    if (b.hidden === true && !t.hidden && t.authorUserId !== u.userId) await notify({ tenantId: u.tenantId, userIds: [t.authorUserId], type: 'forum.moderated', title: `Your post was hidden: ${t.title}`, body: reason || 'A moderator hid it. Ask HR if you think this is a mistake.', link: '/community', entityType: 'forum_thread', entityId: id })
    if (b.locked === true && !t.locked && t.authorUserId !== u.userId) await notify({ tenantId: u.tenantId, userIds: [t.authorUserId], type: 'forum.moderated', title: `Replies closed: ${t.title}`, body: reason || 'A moderator closed this thread to new replies.', link: `/community/${id}`, entityType: 'forum_thread', entityId: id })
    if (b.pinned === true && !t.pinned && !t.hidden) await notify({ tenantId: u.tenantId, userIds: (await spaceAudience(u.tenantId, t.space)).filter((x) => x !== u.userId), type: 'forum.pinned', title: `Pinned in ${t.space.name}: ${t.title}`, body: t.body.slice(0, 160), link: `/community/${id}`, entityType: 'forum_thread', entityId: id })
    return data
  },
  async hideComment(u: AccessUser, id: string, hidden: boolean, reason?: string) {
    const c = await prisma.forumComment.findFirst({ where: { id, tenantId: u.tenantId }, include: { thread: { include: { space: true } } } })
    if (!c) throw new AppError('Comment not found', 404)
    if (!canModerate(u, c.thread.space)) throw new AppError('Only HR or this space’s moderators moderate', 403)
    await prisma.forumComment.update({ where: { id }, data: { hidden } })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'FORUM_MODERATED', entityType: 'forum_comment', entityId: id, newValue: { hidden } } })
    if (hidden && !c.hidden && c.authorUserId !== u.userId) await notify({ tenantId: u.tenantId, userIds: [c.authorUserId], type: 'forum.moderated', title: `Your reply was hidden in “${c.thread.title}”`, body: reason || 'A moderator hid it. Ask HR if you think this is a mistake.', link: `/community/${c.threadId}`, entityType: 'forum_thread', entityId: c.threadId })
    return { hidden }
  },

  // ─── Recognition wall ─────────────────────────────────────
  async wall(u: AccessUser) {
    const rows = await prisma.kudos.findMany({ where: { tenantId: u.tenantId, ...(isMod(u) ? {} : { hidden: false }) }, orderBy: { createdAt: 'desc' }, take: 100 })
    const [n, emps] = await Promise.all([
      names(rows.map((k) => k.fromUserId)),
      prisma.employee.findMany({ where: { id: { in: rows.map((k) => k.toEmployeeId) } }, select: { id: true, firstName: true, lastName: true, user: { select: { avatarUrl: true } } } }),
    ])
    const e = new Map(emps.map((x) => [x.id, x]))
    return rows.map((k) => ({ id: k.id, badge: k.badge, message: k.message, hidden: k.hidden, createdAt: k.createdAt, from: n.get(k.fromUserId)?.fullName ?? null, mine: k.fromUserId === u.userId, to: e.get(k.toEmployeeId) ? `${e.get(k.toEmployeeId)!.firstName} ${e.get(k.toEmployeeId)!.lastName}` : null, toEmployeeId: k.toEmployeeId, toAvatar: e.get(k.toEmployeeId)?.user?.avatarUrl ?? null }))
  },
  async giveKudos(u: AccessUser, b: z.infer<typeof KudosBody>) {
    if (b.toEmployeeId === u.employeeId) throw new AppError('Kudos are for someone else', 400)
    const to = await prisma.employee.findFirst({ where: { id: b.toEmployeeId, tenantId: u.tenantId, active: true } })
    if (!to) throw new AppError('Person not found', 404)
    const k = await prisma.kudos.create({ data: { tenantId: u.tenantId, fromUserId: u.userId, toEmployeeId: to.id, badge: b.badge, message: b.message } })
    await awardKudosPoints(u.tenantId, k.id, to.id)
    const uid = await userIdOfEmployee(u.tenantId, to.id)
    const me = await prisma.user.findUnique({ where: { id: u.userId }, select: { fullName: true } })
    if (uid) await notify({ tenantId: u.tenantId, userIds: [uid], type: 'kudos.received', title: `${me?.fullName ?? 'Someone'} gave you kudos`, body: b.message, link: '/community?tab=wall', entityType: 'kudos', entityId: k.id })
    return k
  },
  async hideKudos(u: AccessUser, id: string, hidden: boolean) {
    if (!isMod(u)) throw new AppError('Only HR moderates', 403)
    const r = await prisma.kudos.updateMany({ where: { id, tenantId: u.tenantId }, data: { hidden } })
    // ponytail: hiding removes the points even if already redeemed (balance can dip); restoring gives them back
    if (r.count && hidden) await prisma.kudosPoint.deleteMany({ where: { tenantId: u.tenantId, kudosId: id } })
    if (r.count && !hidden) { const k = await prisma.kudos.findFirst({ where: { id, tenantId: u.tenantId } }); if (k) await awardKudosPoints(u.tenantId, k.id, k.toEmployeeId) }
    if (!r.count) throw new AppError('Kudos not found', 404)
    return { hidden }
  },

  // ─── Reports ──────────────────────────────────────────────
  async report(u: AccessUser, b: z.infer<typeof ReportBody>) {
    const exists = b.targetType === 'thread' ? await prisma.forumThread.count({ where: { id: b.targetId, tenantId: u.tenantId } })
      : b.targetType === 'comment' ? await prisma.forumComment.count({ where: { id: b.targetId, tenantId: u.tenantId } })
        : await prisma.kudos.count({ where: { id: b.targetId, tenantId: u.tenantId } })
    if (!exists) throw new AppError('Not found', 404)
    const r = await prisma.forumReport.create({ data: { tenantId: u.tenantId, targetType: b.targetType, targetId: b.targetId, reporterUserId: u.userId, reason: b.reason } })
    const { userIdsWithRole } = await import('../../infrastructure/notifications/notify')
    await notify({ tenantId: u.tenantId, userIds: (await userIdsWithRole(u.tenantId, 'hr_admin')).filter((x) => x !== u.userId), type: 'forum.report', title: 'A post was reported', body: b.reason, link: '/community?tab=moderation', entityType: 'forum_report', entityId: r.id })
    return { reported: true }
  },
  async reports(u: AccessUser) {
    if (!isMod(u)) throw new AppError('Only HR moderates', 403)
    const rows = await prisma.forumReport.findMany({ where: { tenantId: u.tenantId, status: 'open' }, orderBy: { createdAt: 'asc' } })
    const ids = (t: string) => rows.filter((r) => r.targetType === t).map((r) => r.targetId)
    const [threads, comments, kudos, n] = await Promise.all([
      prisma.forumThread.findMany({ where: { id: { in: ids('thread') } }, select: { id: true, title: true, body: true, hidden: true } }),
      prisma.forumComment.findMany({ where: { id: { in: ids('comment') } }, select: { id: true, body: true, threadId: true, hidden: true } }),
      prisma.kudos.findMany({ where: { id: { in: ids('kudos') } }, select: { id: true, message: true, hidden: true } }),
      names(rows.map((r) => r.reporterUserId)),
    ])
    const text = (r: { targetType: string; targetId: string }) => r.targetType === 'thread' ? threads.find((t) => t.id === r.targetId) : r.targetType === 'comment' ? comments.find((c) => c.id === r.targetId) : kudos.find((k) => k.id === r.targetId)
    return rows.map((r) => {
      const t: any = text(r)
      return { id: r.id, targetType: r.targetType, targetId: r.targetId, reason: r.reason, reporter: n.get(r.reporterUserId)?.fullName ?? null, createdAt: r.createdAt, content: t ? (t.title ? `${t.title}: ${t.body}` : t.body ?? t.message) : null, threadId: r.targetType === 'thread' ? r.targetId : t?.threadId ?? null, hidden: !!t?.hidden }
    })
  },
  // Resolve: hide the content, or keep it
  async resolve(u: AccessUser, id: string, hide: boolean) {
    if (!isMod(u)) throw new AppError('Only HR moderates', 403)
    const r = await prisma.forumReport.findFirst({ where: { id, tenantId: u.tenantId, status: 'open' } })
    if (!r) throw new AppError('Report not found', 404)
    if (hide) {
      if (r.targetType === 'thread') await prisma.forumThread.updateMany({ where: { id: r.targetId, tenantId: u.tenantId }, data: { hidden: true } })
      if (r.targetType === 'comment') await prisma.forumComment.updateMany({ where: { id: r.targetId, tenantId: u.tenantId }, data: { hidden: true } })
      if (r.targetType === 'kudos') { await prisma.kudos.updateMany({ where: { id: r.targetId, tenantId: u.tenantId }, data: { hidden: true } }); await prisma.kudosPoint.deleteMany({ where: { tenantId: u.tenantId, kudosId: r.targetId } }) }
    }
    // Every open report about the same content is settled together
    await prisma.forumReport.updateMany({ where: { tenantId: u.tenantId, targetType: r.targetType, targetId: r.targetId, status: 'open' }, data: { status: 'resolved', resolution: hide ? 'hidden' : 'kept', resolvedBy: u.userId, resolvedAt: new Date() } })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'FORUM_REPORT_RESOLVED', entityType: `forum_${r.targetType}`, entityId: r.targetId, newValue: { hide } } })
    // Whoever reported it hears the outcome
    const reporters = await prisma.forumReport.findMany({ where: { tenantId: u.tenantId, targetType: r.targetType, targetId: r.targetId, resolvedAt: { not: null } }, select: { reporterUserId: true } })
    await notify({ tenantId: u.tenantId, userIds: [...new Set(reporters.map((x) => x.reporterUserId))].filter((x) => x !== u.userId), type: 'forum.moderated', title: 'Thanks for your report', body: hide ? 'A moderator reviewed it and hid the post.' : 'A moderator reviewed it and decided to keep the post.', link: '/community', entityType: 'forum_report', entityId: r.id })
    return { resolution: hide ? 'hidden' : 'kept' }
  },
}

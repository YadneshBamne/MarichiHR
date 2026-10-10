import { prisma } from '../../infrastructure/database/prisma'
import { eventBus } from '../../infrastructure/events/eventBus'
import { notify } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { assertTargets, audienceUsers, inAudience, scopeOf } from '../../shared/utils/audience'
import { normaliseDateInput } from '../../shared/utils/businessDate'

export interface PolicyIn {
  title: string; category?: string; body: string; changeNote?: string
  departmentIds?: string[]; workLocationIds?: string[]; requiresAcceptance?: boolean; acceptWithinDays?: number
}

const DAY = 86_400_000
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
const dueOf = (publishedAt: Date | null, days: number) => (publishedAt ? new Date(publishedAt.getTime() + days * DAY) : null)

async function find(user: AccessUser, id: string) {
  const p = await prisma.policy.findFirst({ where: { id, tenantId: user.tenantId, active: true }, include: { versions: { orderBy: { version: 'desc' } } } })
  if (!p) throw new AppError('Policy not found', 404)
  return p
}
const published = <V extends { status: string }>(p: { versions: V[] }) => p.versions.find((v) => v.status === 'published') ?? null
const draft = <V extends { status: string }>(p: { versions: V[] }) => p.versions.find((v) => v.status === 'draft') ?? null
const audit = (user: AccessUser, action: string, entityId: string, newValue?: any) =>
  prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action, entityType: 'policy', entityId, newValue } })

export const policyService = {
  // My policies: published ones whose audience includes me, with my acceptance of the current version
  async mine(user: AccessUser) {
    const [rows, scope] = await Promise.all([
      prisma.policy.findMany({
        where: { tenantId: user.tenantId, active: true, versions: { some: { status: 'published' } } },
        include: { versions: { where: { status: 'published' }, include: { acceptances: { where: { userId: user.userId } } } } },
        orderBy: [{ category: 'asc' }, { title: 'asc' }],
      }),
      scopeOf(user.tenantId, user.employeeId),
    ])
    const now = new Date()
    return rows.filter((p) => inAudience(p, scope)).map((p) => {
      const v = p.versions[0]
      const acceptedAt = v.acceptances[0]?.acceptedAt ?? null
      const due = p.requiresAcceptance ? dueOf(v.publishedAt, p.acceptWithinDays) : null
      return {
        id: p.id, title: p.title, category: p.category, version: v.version, effectiveFrom: ymd(v.effectiveFrom), publishedAt: v.publishedAt,
        requiresAcceptance: p.requiresAcceptance, acceptedAt, dueDate: ymd(due),
        status: !p.requiresAcceptance ? 'info' : acceptedAt ? 'accepted' : due && due < now ? 'overdue' : 'pending',
      }
    })
  },

  async pendingCount(user: AccessUser) {
    return (await policyService.mine(user)).filter((p) => p.status === 'pending' || p.status === 'overdue').length
  },

  // One policy: the current version (and earlier published ones) for its audience; HR also gets the draft
  async get(user: AccessUser, id: string, isHR: boolean) {
    const p = await find(user, id)
    if (!isHR && !inAudience(p, await scopeOf(user.tenantId, user.employeeId))) throw new AppError('Policy not found', 404)
    const cur = published(p)
    if (!isHR && !cur) throw new AppError('Policy not found', 404)
    const mineAcc = cur ? await prisma.policyAcceptance.findUnique({ where: { policyVersionId_userId: { policyVersionId: cur.id, userId: user.userId } } }) : null
    const show = (v: typeof p.versions[number]) => ({ id: v.id, version: v.version, body: v.body, changeNote: v.changeNote, status: v.status, effectiveFrom: ymd(v.effectiveFrom), publishedAt: v.publishedAt })
    return {
      id: p.id, title: p.title, category: p.category, requiresAcceptance: p.requiresAcceptance, acceptWithinDays: p.acceptWithinDays,
      departmentIds: p.departmentIds, workLocationIds: p.workLocationIds,
      current: cur ? show(cur) : null,
      draft: isHR && draft(p) ? show(draft(p)!) : null,
      history: p.versions.filter((v) => v.status !== 'draft').map(show),
      acceptedAt: mineAcc?.acceptedAt ?? null,
      dueDate: cur && p.requiresAcceptance ? ymd(dueOf(cur.publishedAt, p.acceptWithinDays)) : null,
    }
  },

  // HR overview: every policy with its draft state and acceptance progress on the current version
  async manage(user: AccessUser) {
    const rows = await prisma.policy.findMany({
      where: { tenantId: user.tenantId, active: true },
      include: { versions: { orderBy: { version: 'desc' }, include: { acceptances: { select: { userId: true } } } } },
      orderBy: [{ category: 'asc' }, { title: 'asc' }],
    })
    const now = new Date()
    return Promise.all(rows.map(async (p) => {
      const cur = published(p)
      const audience = await audienceUsers(user.tenantId, p)
      const ids = new Set(audience.map((u) => u.id))
      const accepted = cur ? cur.acceptances.filter((a) => ids.has(a.userId)).length : 0
      const due = cur ? dueOf(cur.publishedAt, p.acceptWithinDays) : null
      return {
        id: p.id, title: p.title, category: p.category, requiresAcceptance: p.requiresAcceptance,
        version: cur?.version ?? null, publishedAt: cur?.publishedAt ?? null, hasDraft: !!draft(p),
        audience: audience.length, accepted, pending: p.requiresAcceptance && cur ? audience.length - accepted : 0,
        overdue: !!(p.requiresAcceptance && cur && due && due < now && accepted < audience.length), dueDate: ymd(due),
      }
    }))
  },

  async create(user: AccessUser, body: PolicyIn) {
    if (!(await assertTargets(user.tenantId, body))) throw new AppError('Unknown department or office', 404)
    const p = await prisma.policy.create({
      data: {
        tenantId: user.tenantId, title: body.title, category: body.category || 'General', departmentIds: body.departmentIds ?? [], workLocationIds: body.workLocationIds ?? [],
        requiresAcceptance: body.requiresAcceptance ?? true, acceptWithinDays: body.acceptWithinDays ?? 7, createdById: user.userId,
        versions: { create: { version: 1, body: body.body, changeNote: body.changeNote ?? null } },
      },
    })
    await audit(user, 'POLICY_CREATED', p.id, { title: p.title })
    return p
  },

  async update(user: AccessUser, id: string, body: Partial<Omit<PolicyIn, 'body' | 'changeNote'>>) {
    await find(user, id)
    if ((body.departmentIds || body.workLocationIds) && !(await assertTargets(user.tenantId, body))) throw new AppError('Unknown department or office', 404)
    const data: Record<string, unknown> = {}
    for (const k of ['title', 'category', 'departmentIds', 'workLocationIds', 'requiresAcceptance', 'acceptWithinDays'] as const) if (body[k] !== undefined) data[k] = body[k]
    const p = await prisma.policy.update({ where: { id }, data })
    await audit(user, 'POLICY_UPDATED', id, data)
    return p
  },

  // Write (or rewrite) the next version; it stays a draft until published
  async saveDraft(user: AccessUser, id: string, body: { body: string; changeNote?: string }) {
    const p = await find(user, id)
    const d = draft(p)
    const v = d
      ? await prisma.policyVersion.update({ where: { id: d.id }, data: { body: body.body, changeNote: body.changeNote ?? d.changeNote } })
      : await prisma.policyVersion.create({ data: { policyId: id, version: (p.versions[0]?.version ?? 0) + 1, body: body.body, changeNote: body.changeNote ?? null } })
    await audit(user, 'POLICY_DRAFT_SAVED', id, { version: v.version })
    return v
  },

  async publish(user: AccessUser, id: string, effectiveFrom?: string) {
    const p = await find(user, id)
    const d = draft(p)
    if (!d) throw new AppError('There is no draft to publish', 400)
    const now = new Date()
    await prisma.$transaction([
      prisma.policyVersion.updateMany({ where: { policyId: id, status: 'published' }, data: { status: 'superseded' } }),
      prisma.policyVersion.update({ where: { id: d.id }, data: { status: 'published', publishedAt: now, publishedById: user.userId, effectiveFrom: effectiveFrom ? normaliseDateInput(effectiveFrom) : normaliseDateInput(now.toISOString().slice(0, 10)) } }),
    ])
    await audit(user, 'POLICY_PUBLISHED', id, { version: d.version })
    await eventBus.publish(user.tenantId, 'policy.published', { policyId: id, version: d.version })
    return { published: true, version: d.version }
  },

  async accept(user: AccessUser, id: string) {
    const p = await find(user, id)
    const cur = published(p)
    if (!cur || !inAudience(p, await scopeOf(user.tenantId, user.employeeId))) throw new AppError('Policy not found', 404)
    if (!p.requiresAcceptance) throw new AppError('This policy does not ask for acceptance', 400)
    const a = await prisma.policyAcceptance.upsert({
      where: { policyVersionId_userId: { policyVersionId: cur.id, userId: user.userId } },
      create: { policyVersionId: cur.id, userId: user.userId },
      update: {},
    })
    return { accepted: true, version: cur.version, acceptedAt: a.acceptedAt }
  },

  // HR: the audience and who has accepted the current version
  async acceptances(user: AccessUser, id: string) {
    const p = await find(user, id)
    const cur = published(p)
    const [audience, acc] = await Promise.all([
      audienceUsers(user.tenantId, p),
      cur ? prisma.policyAcceptance.findMany({ where: { policyVersionId: cur.id } }) : [],
    ])
    const at = new Map(acc.map((a) => [a.userId, a.acceptedAt]))
    return audience.map((u) => ({ userId: u.id, name: u.fullName, acceptedAt: at.get(u.id) ?? null }))
      .sort((a, b) => Number(!!a.acceptedAt) - Number(!!b.acceptedAt) || a.name.localeCompare(b.name))
  },

  // HR: nudge everyone who still has to accept the current version
  async remind(user: AccessUser, id: string) {
    const p = await find(user, id)
    const cur = published(p)
    if (!cur || !p.requiresAcceptance) throw new AppError('Nothing to remind about', 400)
    const pending = (await policyService.acceptances(user, id)).filter((x) => !x.acceptedAt).map((x) => x.userId)
    await notify({ tenantId: user.tenantId, userIds: pending, type: 'policy.reminder', title: 'Please accept a company policy', body: `${p.title} (version ${cur.version})`, link: `/policies/${p.id}`, entityType: 'policy', entityId: p.id })
    await audit(user, 'POLICY_REMINDER_SENT', id, { recipients: pending.length })
    return { reminded: pending.length }
  },

  async archive(user: AccessUser, id: string) {
    await find(user, id)
    await prisma.policy.update({ where: { id }, data: { active: false } })
    await audit(user, 'POLICY_ARCHIVED', id)
    return { archived: true }
  },
}

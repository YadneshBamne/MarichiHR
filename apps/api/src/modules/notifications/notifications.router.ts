import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { prisma } from '../../infrastructure/database/prisma'
import { JOBS, getCronQueue } from '../../infrastructure/jobs/jobs'
import { CATEGORIES, Prefs } from '../../infrastructure/notifications/preferences'

// ─── IN-APP NOTIFICATIONS (/notifications) ─────────────────────
export const notificationsRouter = Router()
notificationsRouter.use(authenticate)

notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const { userId, tenantId } = req.user!
  const where = { userId, tenantId, ...(req.query.unread === 'true' && { readAt: null }) }
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where, orderBy: { createdAt: 'desc' }, take: Math.min(Number(req.query.limit) || 30, 100),
      select: { id: true, type: true, title: true, body: true, link: true, entityType: true, entityId: true, readAt: true, createdAt: true },
    }),
    prisma.notification.count({ where: { userId, tenantId, readAt: null } }),
  ])
  res.json({ success: true, data: { items, unread } })
}))

// Each person's delivery choices per category (the bell always gets everything)
notificationsRouter.get('/preferences', asyncHandler(async (req, res) => {
  const u = await prisma.user.findFirst({ where: { id: req.user!.userId, tenantId: req.user!.tenantId }, select: { notifyPrefs: true } })
  const prefs = (u?.notifyPrefs ?? {}) as Prefs
  const on = (process.env.NOTIFY_CHANNELS || 'email').split(',').map((c) => c.trim())
  res.json({ success: true, data: {
    channels: { email: on.includes('email'), whatsapp: on.includes('whatsapp') },
    categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label, hint: c.hint, mandatory: c.mandatory, email: c.mandatory || prefs[c.key]?.email !== false, whatsapp: c.mandatory || prefs[c.key]?.whatsapp !== false })),
  } })
}))

const Channel = z.object({ email: z.boolean().optional(), whatsapp: z.boolean().optional() }).strict()
const PrefsBody = z.object({ prefs: z.object(Object.fromEntries(CATEGORIES.map((c) => [c.key, Channel.optional()]))).strict() }).strict()
notificationsRouter.put('/preferences', validate(z.object({ body: PrefsBody })), asyncHandler(async (req, res) => {
  const { userId, tenantId } = req.user!
  const u = await prisma.user.findFirst({ where: { id: userId, tenantId }, select: { notifyPrefs: true } })
  if (!u) throw new AppError('User not found', 404)
  const merged: Record<string, unknown> = { ...((u.notifyPrefs ?? {}) as object) }
  for (const [k, v] of Object.entries(req.body.prefs as Record<string, object | undefined>)) {
    if (!v || CATEGORIES.find((c) => c.key === k)?.mandatory) continue // mandatory categories cannot be switched off
    merged[k] = { ...((merged[k] as object) ?? {}), ...v }
  }
  await prisma.user.update({ where: { id: userId }, data: { notifyPrefs: merged as any } })
  res.json({ success: true, data: merged })
}))

notificationsRouter.post('/read-all', asyncHandler(async (req, res) => {
  const { userId, tenantId } = req.user!
  const r = await prisma.notification.updateMany({ where: { userId, tenantId, readAt: null }, data: { readAt: new Date() } })
  res.json({ success: true, data: { updated: r.count } })
}))

notificationsRouter.post('/:id/read', validate(z.object({ params: z.object({ id: z.string().uuid() }) })), asyncHandler(async (req, res) => {
  const { userId, tenantId } = req.user!
  const n = await prisma.notification.findFirst({ where: { id: String(req.params.id), userId, tenantId } })
  if (!n) throw new AppError('Notification not found', 404)
  const updated = n.readAt ? n : await prisma.notification.update({ where: { id: n.id }, data: { readAt: new Date() } })
  res.json({ success: true, data: updated })
}))

// ─── SCHEDULED JOBS (/system/jobs) ─────────────────────────────
export const systemRouter = Router()
systemRouter.use(authenticate, requirePermission('system:configure'))

systemRouter.get('/jobs', asyncHandler(async (_req, res) => {
  const schedulers = await getCronQueue().getJobSchedulers()
  res.json({
    success: true,
    data: Object.entries(JOBS).map(([name, def]) => {
      const s = schedulers.find((x) => x.key === name)
      return { name, description: def.description, pattern: def.pattern, scheduled: !!s, nextRunAt: s?.next ? new Date(s.next).toISOString() : null }
    }),
  })
}))

// Runs a job now, in this request, and returns its result (jobs are idempotent)
systemRouter.post('/jobs/:name/run', asyncHandler(async (req, res) => {
  const def = JOBS[String(req.params.name)]
  if (!def) throw new AppError('Unknown job', 404)
  res.json({ success: true, data: await def.run(req.user!.tenantId) })
}))

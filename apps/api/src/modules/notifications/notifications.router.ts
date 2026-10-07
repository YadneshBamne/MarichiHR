import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { prisma } from '../../infrastructure/database/prisma'
import { JOBS, getCronQueue } from '../../infrastructure/jobs/jobs'

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

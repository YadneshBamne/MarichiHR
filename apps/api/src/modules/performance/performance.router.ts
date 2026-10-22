import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { performanceService, GoalBody } from './performance.service'

export const performanceRouter = Router()
performanceRouter.use(authenticate)
const id = z.object({ id: z.string().uuid() })
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data })

performanceRouter.get('/cycles', asyncHandler(async (req, res) => ok(res, await performanceService.cycles(req.user!))))
performanceRouter.post('/cycles', validate(z.object({ body: z.object({ name: z.string().trim().min(2).max(60), period: z.enum(['quarterly', 'yearly']), startDate: date, endDate: date }).strict() })), asyncHandler(async (req, res) => ok(res, await performanceService.createCycle(req.user!, req.body), 201)))
performanceRouter.post('/cycles/this-year', asyncHandler(async (req, res) => ok(res, await performanceService.createYear(req.user!), 201)))
performanceRouter.post('/cycles/:id/status', validate(z.object({ params: id, body: z.object({ status: z.enum(['open', 'closed']) }).strict() })), asyncHandler(async (req, res) => ok(res, await performanceService.setCycleStatus(req.user!, String(req.params.id), req.body.status))))

performanceRouter.get('/goals', validate(z.object({ query: z.object({ scope: z.enum(['mine', 'team', 'all']).default('mine'), cycleId: z.string().uuid().optional() }) })), asyncHandler(async (req, res) => ok(res, await performanceService.list(req.user!, req.query.scope as any, req.query.cycleId as string | undefined))))
performanceRouter.post('/goals', validate(z.object({ body: GoalBody })), asyncHandler(async (req, res) => ok(res, await performanceService.create(req.user!, req.body), 201)))
performanceRouter.put('/goals/:id', validate(z.object({ params: id, body: z.object({ title: z.string().trim().min(3).max(160), description: z.string().trim().max(2000).optional(), kpis: GoalBody.shape.kpis, send: z.boolean().default(false) }).strict() })), asyncHandler(async (req, res) => ok(res, await performanceService.update(req.user!, String(req.params.id), req.body))))
performanceRouter.post('/goals/:id/send', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await performanceService.send(req.user!, String(req.params.id)))))
performanceRouter.post('/goals/:id/accept', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await performanceService.respond(req.user!, String(req.params.id), true))))
performanceRouter.post('/goals/:id/return', validate(z.object({ params: id, body: z.object({ note: z.string().trim().min(3).max(1000) }).strict() })), asyncHandler(async (req, res) => ok(res, await performanceService.respond(req.user!, String(req.params.id), false, req.body.note))))
performanceRouter.post('/goals/:id/review', validate(z.object({ params: id, body: z.object({ achieved: z.record(z.string().uuid(), z.number().min(0).max(1e12)), comment: z.string().trim().max(2000).optional() }).strict() })), asyncHandler(async (req, res) => ok(res, await performanceService.review(req.user!, String(req.params.id), req.body))))
performanceRouter.post('/goals/:id/acknowledge', validate(z.object({ params: id, body: z.object({ comment: z.string().trim().max(2000).optional() }).strict() })), asyncHandler(async (req, res) => ok(res, await performanceService.acknowledge(req.user!, String(req.params.id), req.body.comment))))

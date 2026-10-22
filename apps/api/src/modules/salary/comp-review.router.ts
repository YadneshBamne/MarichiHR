import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { compReviewService as svc, CycleBody, RecommendBody } from './comp-review.service'

// Mounted at /api/v1/comp-reviews behind authentication and the payroll app
export const compReviewRouter = Router()
const id = z.object({ id: z.string().uuid() })
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data })
const p = (req: any) => String(req.params.id)

compReviewRouter.get('/', asyncHandler(async (req, res) => ok(res, await svc.cycles(req.user!))))
compReviewRouter.get('/team-cost', asyncHandler(async (req, res) => ok(res, await svc.teamCost(req.user!))))
compReviewRouter.post('/', validate(z.object({ body: CycleBody })), asyncHandler(async (req, res) => ok(res, await svc.create(req.user!, req.body), 201)))
compReviewRouter.get('/:id/my-team', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await svc.myTeam(req.user!, p(req)))))
compReviewRouter.post('/:id/recommend', validate(z.object({ params: id, body: RecommendBody })), asyncHandler(async (req, res) => ok(res, await svc.recommend(req.user!, p(req), req.body))))
compReviewRouter.get('/:id/review', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await svc.review(req.user!, p(req)))))
compReviewRouter.post('/recommendations/:id/decide', validate(z.object({ params: id, body: z.object({ approve: z.boolean() }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.decide(req.user!, p(req), req.body.approve))))
compReviewRouter.post('/:id/apply', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await svc.apply(req.user!, p(req)))))
compReviewRouter.post('/:id/close', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await svc.close(req.user!, p(req)))))

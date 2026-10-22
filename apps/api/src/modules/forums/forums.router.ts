import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { forumsService as svc, ThreadBody, CommentBody, KudosBody, ReportBody } from './forums.service'

export const forumsRouter = Router()
forumsRouter.use(authenticate)
const id = z.object({ id: z.string().uuid() })
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data })
const p = (req: any) => String(req.params.id)

forumsRouter.get('/spaces', asyncHandler(async (req, res) => ok(res, await svc.spaces(req.user!))))
forumsRouter.post('/spaces', validate(z.object({ body: z.object({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).optional() }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.createSpace(req.user!, req.body), 201)))
forumsRouter.post('/spaces/:id/archive', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await svc.archiveSpace(req.user!, p(req)))))

forumsRouter.get('/threads', validate(z.object({ query: z.object({ spaceId: z.string().uuid().optional(), q: z.string().trim().max(100).optional() }) })), asyncHandler(async (req, res) => ok(res, await svc.threads(req.user!, req.query.spaceId as string | undefined, (req.query.q as string | undefined) || undefined))))
forumsRouter.post('/threads', validate(z.object({ body: ThreadBody })), asyncHandler(async (req, res) => ok(res, await svc.createThread(req.user!, req.body), 201)))
forumsRouter.get('/threads/:id', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await svc.thread(req.user!, p(req)))))
forumsRouter.post('/threads/:id/comments', validate(z.object({ params: id, body: CommentBody })), asyncHandler(async (req, res) => ok(res, await svc.comment(req.user!, p(req), req.body), 201)))
forumsRouter.post('/threads/:id/vote', validate(z.object({ params: id, body: z.object({ optionIds: z.array(z.string().min(1).max(20)).min(1).max(10) }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.vote(req.user!, p(req), req.body.optionIds))))
forumsRouter.post('/threads/:id/moderate', validate(z.object({ params: id, body: z.object({ pinned: z.boolean().optional(), locked: z.boolean().optional(), hidden: z.boolean().optional() }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.moderateThread(req.user!, p(req), req.body))))
forumsRouter.post('/comments/:id/hide', validate(z.object({ params: id, body: z.object({ hidden: z.boolean() }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.hideComment(req.user!, p(req), req.body.hidden))))

forumsRouter.get('/kudos', asyncHandler(async (req, res) => ok(res, await svc.wall(req.user!))))
forumsRouter.post('/kudos', validate(z.object({ body: KudosBody })), asyncHandler(async (req, res) => ok(res, await svc.giveKudos(req.user!, req.body), 201)))
forumsRouter.post('/kudos/:id/hide', validate(z.object({ params: id, body: z.object({ hidden: z.boolean() }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.hideKudos(req.user!, p(req), req.body.hidden))))

forumsRouter.post('/reports', validate(z.object({ body: ReportBody })), asyncHandler(async (req, res) => ok(res, await svc.report(req.user!, req.body), 201)))
forumsRouter.get('/reports', asyncHandler(async (req, res) => ok(res, await svc.reports(req.user!))))
forumsRouter.post('/reports/:id/resolve', validate(z.object({ params: id, body: z.object({ hide: z.boolean() }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.resolve(req.user!, p(req), req.body.hide))))

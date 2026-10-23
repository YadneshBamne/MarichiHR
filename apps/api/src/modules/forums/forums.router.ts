import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import multer from 'multer'
import { forumsService as svc, ThreadBody, CommentBody, KudosBody, ReportBody } from './forums.service'
import { forumExtras as fx, EventBody, FORUM_MAX_BYTES } from './forum-extras.service'

export const forumsRouter = Router()
forumsRouter.use(authenticate)
const id = z.object({ id: z.string().uuid() })
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data })
const p = (req: any) => String(req.params.id)

forumsRouter.get('/spaces', asyncHandler(async (req, res) => ok(res, await svc.spaces(req.user!))))
forumsRouter.post('/spaces', validate(z.object({ body: z.object({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).optional(), kind: z.enum(['company', 'team', 'department']).optional(), orgUnitId: z.string().uuid().optional(), ownerEmployeeId: z.string().uuid().optional(), moderatorUserIds: z.array(z.string().uuid()).max(10).optional() }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.createSpace(req.user!, req.body), 201)))
forumsRouter.post('/spaces/:id/archive', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await svc.archiveSpace(req.user!, p(req)))))

forumsRouter.get('/threads', validate(z.object({ query: z.object({ spaceId: z.string().uuid().optional(), q: z.string().trim().max(100).optional(), tag: z.string().trim().max(30).optional(), feed: z.enum(['following']).optional() }) })), asyncHandler(async (req, res) => ok(res, await svc.threads(req.user!, req.query.spaceId as string | undefined, (req.query.q as string | undefined) || undefined, (req.query.tag as string | undefined) || undefined, req.query.feed as 'following' | undefined))))
forumsRouter.post('/threads', validate(z.object({ body: ThreadBody })), asyncHandler(async (req, res) => ok(res, await svc.createThread(req.user!, req.body), 201)))
forumsRouter.get('/threads/:id', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await svc.thread(req.user!, p(req)))))
forumsRouter.post('/threads/:id/comments', validate(z.object({ params: id, body: CommentBody })), asyncHandler(async (req, res) => ok(res, await svc.comment(req.user!, p(req), req.body), 201)))
forumsRouter.post('/threads/:id/vote', validate(z.object({ params: id, body: z.object({ optionIds: z.array(z.string().min(1).max(20)).min(1).max(10) }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.vote(req.user!, p(req), req.body.optionIds))))
forumsRouter.post('/threads/:id/moderate', validate(z.object({ params: id, body: z.object({ pinned: z.boolean().optional(), locked: z.boolean().optional(), hidden: z.boolean().optional(), reason: z.string().trim().max(300).optional() }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.moderateThread(req.user!, p(req), req.body))))
forumsRouter.post('/comments/:id/hide', validate(z.object({ params: id, body: z.object({ hidden: z.boolean(), reason: z.string().trim().max(300).optional() }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.hideComment(req.user!, p(req), req.body.hidden, req.body.reason))))

forumsRouter.get('/kudos', asyncHandler(async (req, res) => ok(res, await svc.wall(req.user!))))
forumsRouter.post('/kudos', validate(z.object({ body: KudosBody })), asyncHandler(async (req, res) => ok(res, await svc.giveKudos(req.user!, req.body), 201)))
forumsRouter.post('/kudos/:id/hide', validate(z.object({ params: id, body: z.object({ hidden: z.boolean() }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.hideKudos(req.user!, p(req), req.body.hidden))))

forumsRouter.post('/reports', validate(z.object({ body: ReportBody })), asyncHandler(async (req, res) => ok(res, await svc.report(req.user!, req.body), 201)))
forumsRouter.get('/reports', asyncHandler(async (req, res) => ok(res, await svc.reports(req.user!))))
forumsRouter.post('/reports/:id/resolve', validate(z.object({ params: id, body: z.object({ hide: z.boolean() }).strict() })), asyncHandler(async (req, res) => ok(res, await svc.resolve(req.user!, p(req), req.body.hide))))

// Settings (blocked words, news), follows, attachments, events, analytics
const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: FORUM_MAX_BYTES, files: 1 } })
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
forumsRouter.get('/settings', asyncHandler(async (req, res) => ok(res, await fx.settings(req.user!))))
forumsRouter.put('/settings', validate(z.object({ body: z.object({ blockedWords: z.array(z.string().trim().min(2).max(40)).max(200).optional(), autoNews: z.boolean().optional() }).strict() })), asyncHandler(async (req, res) => ok(res, await fx.saveSettings(req.user!, req.body))))
forumsRouter.get('/follows', asyncHandler(async (req, res) => ok(res, await fx.follows(req.user!))))
forumsRouter.post('/follows', validate(z.object({ body: z.object({ kind: z.enum(['tag', 'user', 'space']), key: z.string().trim().min(1).max(60), on: z.boolean() }).strict() })), asyncHandler(async (req, res) => ok(res, await fx.follow(req.user!, req.body))))
forumsRouter.post('/attachments', memory.single('file'), asyncHandler(async (req, res) => ok(res, await fx.upload(req.user!, req.file as any), 201)))
forumsRouter.get('/attachments/:id', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await fx.download(req.user!, p(req)))))
forumsRouter.get('/events', validate(z.object({ query: z.object({ from: day, to: day }) })), asyncHandler(async (req, res) => ok(res, await fx.events(req.user!, String(req.query.from), String(req.query.to)))))
forumsRouter.post('/events', validate(z.object({ body: EventBody })), asyncHandler(async (req, res) => ok(res, await fx.createEvent(req.user!, req.body), 201)))
forumsRouter.post('/events/:id/cancel', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await fx.cancelEvent(req.user!, p(req)))))
forumsRouter.post('/events/:id/rsvp', validate(z.object({ params: id, body: z.object({ status: z.enum(['going', 'maybe', 'no']) }).strict() })), asyncHandler(async (req, res) => ok(res, await fx.rsvp(req.user!, p(req), req.body.status))))
forumsRouter.get('/analytics', validate(z.object({ query: z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }) })), asyncHandler(async (req, res) => ok(res, await fx.analytics(req.user!, Number(req.query.days) || 30))))

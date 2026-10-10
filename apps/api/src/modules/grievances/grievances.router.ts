import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { CATEGORIES, SEVERITIES, grievanceService } from './grievances.service'

const id = z.object({ id: z.string().uuid() })
const message = z.string().trim().min(1).max(5000)
const caseKey = z.string().trim().min(10).max(40)
const Raise = z.object({ body: z.object({ category: z.enum(CATEGORIES), subject: z.string().trim().min(3).max(140), description: z.string().trim().min(10).max(10_000), severity: z.enum(SEVERITIES).optional(), anonymous: z.boolean().optional() }).strict() })
const KeyOnly = z.object({ body: z.object({ caseKey }).strict() })
const KeyReply = z.object({ body: z.object({ caseKey, body: message }).strict() })
const Reply = z.object({ params: id, body: z.object({ body: message }).strict() })
const HandlerReply = z.object({ params: id, body: z.object({ body: message, internal: z.boolean().optional() }).strict() })
const Update = z.object({ params: id, body: z.object({ status: z.enum(['open', 'in_review', 'resolved', 'closed']).optional(), severity: z.enum(SEVERITIES).optional(), assignedToUserId: z.string().uuid().nullable().optional(), resolution: z.string().trim().min(1).max(5000).optional() }).strict() })

export const grievancesRouter = Router()
grievancesRouter.use(authenticate)
const hr = requireRoles('hr_admin')

// ─── Anyone in the company ─────────────────────────────────
grievancesRouter.post('/', validate(Raise), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await grievanceService.raise(req.user!, req.body) })
}))
grievancesRouter.get('/mine', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await grievanceService.mine(req.user!) })
}))
grievancesRouter.get('/mine/:id', validate(z.object({ params: id })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await grievanceService.mineOne(req.user!, String(req.params.id)) })
}))
grievancesRouter.post('/mine/:id/messages', validate(Reply), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await grievanceService.raiserReply(req.user!, { id: String(req.params.id) }, req.body.body) })
}))
// Anonymous cases are found by their key (sent in the body, never in a URL)
grievancesRouter.post('/anonymous/view', validate(KeyOnly), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await grievanceService.byKey(req.user!, req.body.caseKey) })
}))
grievancesRouter.post('/anonymous/messages', validate(KeyReply), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await grievanceService.raiserReply(req.user!, { caseKey: req.body.caseKey }, req.body.body) })
}))

// ─── HR admins only ────────────────────────────────────────
grievancesRouter.get('/', hr, validate(z.object({ query: z.object({ status: z.enum(['active', 'open', 'in_review', 'resolved', 'closed']).optional() }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await grievanceService.queue(req.user!, { status: req.query.status as string | undefined }) })
}))
grievancesRouter.get('/handlers', hr, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await grievanceService.handlers(req.user!) })
}))
grievancesRouter.get('/:id', hr, validate(z.object({ params: id })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await grievanceService.handlerView(req.user!, String(req.params.id)) })
}))
grievancesRouter.post('/:id/messages', hr, validate(HandlerReply), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await grievanceService.handlerReply(req.user!, String(req.params.id), req.body.body, !!req.body.internal) })
}))
grievancesRouter.patch('/:id', hr, validate(Update), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await grievanceService.update(req.user!, String(req.params.id), req.body) })
}))

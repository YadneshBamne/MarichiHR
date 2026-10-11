import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { requestService, REQUEST_SECTIONS } from './requests.service'

const id = z.string().uuid()
const section = z.enum(REQUEST_SECTIONS)

export const requestsRouter = Router()
requestsRouter.use(authenticate)
const p = (req: any, k = 'id') => String(req.params[k])

requestsRouter.get('/', validate(z.object({ query: z.object({ status: z.enum(['open', 'completed', 'cancelled']).optional(), mine: z.enum(['1']).optional(), employeeId: id.optional() }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await requestService.list(req.user!, { status: req.query.status as string | undefined, mine: req.query.mine === '1', employeeId: req.query.employeeId as string | undefined }) })
}))
requestsRouter.post('/', requireRoles('hr_admin', 'system_admin'), validate(z.object({ body: z.object({
  employeeIds: z.array(id).min(1).max(500), sections: z.array(section).min(1), kind: z.enum(['onboarding', 'update']),
  note: z.string().trim().max(500).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict() })), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await requestService.create(req.user!, req.body) })
}))
requestsRouter.get('/:id', validate(z.object({ params: z.object({ id }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await requestService.get(req.user!, p(req)) })
}))
requestsRouter.post('/:id/sections/:section/submit', validate(z.object({ params: z.object({ id, section }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await requestService.submit(req.user!, p(req), p(req, 'section')) })
}))
requestsRouter.post('/:id/sections/:section/review', validate(z.object({ params: z.object({ id, section }), body: z.object({ accept: z.boolean(), note: z.string().trim().min(1).max(500).optional() }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await requestService.review(req.user!, p(req), p(req, 'section'), req.body.accept, req.body.note) })
}))
requestsRouter.post('/:id/cancel', validate(z.object({ params: z.object({ id }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await requestService.cancel(req.user!, p(req)) })
}))

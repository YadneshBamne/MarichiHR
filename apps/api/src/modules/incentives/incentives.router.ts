import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { incentiveService } from './incentives.service'

const id = z.object({ id: z.string().uuid() })
const money = z.number().positive().max(100_000_000)
const typeFields = {
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,29}$/, 'Use capitals, digits and _'),
  description: z.string().trim().max(300).nullable(),
  defaultAmount: money.nullable(),
  maxAmount: money.nullable(),
  payrollInputTypeId: z.string().uuid().nullable(),
  active: z.boolean(),
}
const CreateType = z.object({ body: z.object({ name: typeFields.name, code: typeFields.code, description: typeFields.description.optional(), defaultAmount: typeFields.defaultAmount.optional(), maxAmount: typeFields.maxAmount.optional(), payrollInputTypeId: typeFields.payrollInputTypeId.optional() }).strict() })
const UpdateType = z.object({ params: id, body: z.object({ name: typeFields.name.optional(), description: typeFields.description.optional(), defaultAmount: typeFields.defaultAmount.optional(), maxAmount: typeFields.maxAmount.optional(), payrollInputTypeId: typeFields.payrollInputTypeId.optional(), active: typeFields.active.optional() }).strict() })
const Nominate = z.object({ body: z.object({ employeeId: z.string().uuid(), typeId: z.string().uuid(), amount: money, reason: z.string().trim().min(5).max(500) }).strict() })
const Decide = z.object({ params: id, body: z.object({ note: z.string().trim().min(1).max(500).optional() }).strict() })
const Post = z.object({ body: z.object({ cycleId: z.string().uuid(), incentiveIds: z.array(z.string().uuid()).min(1).max(500) }).strict() })

export const incentivesRouter = Router()
incentivesRouter.use(authenticate)
const hr = requireRoles('hr_admin')
const nominators = requireRoles('hr_admin', 'manager')

incentivesRouter.get('/types', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await incentiveService.types(req.user!) })
}))
incentivesRouter.post('/types', hr, validate(CreateType), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await incentiveService.saveType(req.user!, null, req.body) })
}))
incentivesRouter.patch('/types/:id', hr, validate(UpdateType), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await incentiveService.saveType(req.user!, String(req.params.id), req.body) })
}))
incentivesRouter.get('/', validate(z.object({ query: z.object({ status: z.enum(['nominated', 'approved', 'rejected', 'posted', 'cancelled']).optional() }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await incentiveService.list(req.user!, { status: req.query.status as string | undefined }) })
}))
incentivesRouter.post('/', nominators, validate(Nominate), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await incentiveService.nominate(req.user!, req.body) })
}))
incentivesRouter.post('/post', requireRoles('hr_admin', 'payroll_admin'), validate(Post), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await incentiveService.post(req.user!, req.body.cycleId, req.body.incentiveIds) })
}))
incentivesRouter.post('/:id/approve', hr, validate(Decide), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await incentiveService.decide(req.user!, String(req.params.id), true, req.body.note) })
}))
incentivesRouter.post('/:id/reject', hr, validate(Decide), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await incentiveService.decide(req.user!, String(req.params.id), false, req.body.note) })
}))
incentivesRouter.post('/:id/cancel', validate(z.object({ params: id })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await incentiveService.cancel(req.user!, String(req.params.id)) })
}))

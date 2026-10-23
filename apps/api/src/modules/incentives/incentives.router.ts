import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { incentiveService } from './incentives.service'
import { incentiveExtras, SchemeBody, RunBody } from './incentive-extras.service'

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
// Schemes (HR), budgets (HR sets; managers see theirs), ratings -> variable pay (Payroll), kudos points (everyone)
incentivesRouter.get('/settings', hr, asyncHandler(async (req, res) => { res.json({ success: true, data: await incentiveExtras.settings(req.user!) }) }))
incentivesRouter.put('/settings', hr, validate(z.object({ body: z.object({ ratingPayout: z.record(z.string(), z.number().min(0).max(500)).optional(), kudosPoints: z.number().int().min(0).max(1000).optional(), pointValue: z.number().min(0).max(1e6).optional(), pointsExpireMonths: z.number().int().min(0).max(120).optional(), minRedeem: z.number().int().min(1).max(1e6).optional() }).strict() })), asyncHandler(async (req, res) => { res.json({ success: true, data: await incentiveExtras.saveSettings(req.user!, req.body) }) }))
incentivesRouter.get('/schemes', hr, asyncHandler(async (req, res) => { res.json({ success: true, data: await incentiveExtras.schemes(req.user!) }) }))
incentivesRouter.post('/schemes', hr, validate(z.object({ body: SchemeBody })), asyncHandler(async (req, res) => { res.status(201).json({ success: true, data: await incentiveExtras.saveScheme(req.user!, null, req.body) }) }))
incentivesRouter.put('/schemes/:id', hr, validate(z.object({ params: id, body: SchemeBody })), asyncHandler(async (req, res) => { res.json({ success: true, data: await incentiveExtras.saveScheme(req.user!, String(req.params.id), req.body) }) }))
incentivesRouter.post('/schemes/:id/run', hr, validate(z.object({ params: id, body: RunBody })), asyncHandler(async (req, res) => { res.json({ success: true, data: await incentiveExtras.runScheme(req.user!, String(req.params.id), req.body) }) }))
incentivesRouter.get('/budgets', nominators, asyncHandler(async (req, res) => { res.json({ success: true, data: await incentiveExtras.budgets(req.user!) }) }))
incentivesRouter.post('/budgets', hr, validate(z.object({ body: z.object({ managerEmployeeId: z.string().uuid(), periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amount: z.number().min(0).max(1e10) }).strict() })), asyncHandler(async (req, res) => { res.status(201).json({ success: true, data: await incentiveExtras.saveBudget(req.user!, req.body) }) }))
incentivesRouter.get('/ratings/:id', requireRoles('payroll_admin'), validate(z.object({ params: id })), asyncHandler(async (req, res) => { res.json({ success: true, data: await incentiveExtras.ratingSuggestions(req.user!, String(req.params.id)) }) }))
incentivesRouter.post('/ratings/:id/nominate', requireRoles('payroll_admin'), validate(z.object({ params: id, body: z.object({ employeeIds: z.array(z.string().uuid()).min(1).max(500) }).strict() })), asyncHandler(async (req, res) => { res.json({ success: true, data: await incentiveExtras.nominateFromRatings(req.user!, String(req.params.id), req.body.employeeIds) }) }))
incentivesRouter.get('/points', asyncHandler(async (req, res) => { res.json({ success: true, data: await incentiveExtras.points(req.user!) }) }))
incentivesRouter.get('/points/leaderboard', asyncHandler(async (req, res) => { res.json({ success: true, data: await incentiveExtras.leaderboard(req.user!) }) }))
incentivesRouter.post('/points/redeem', validate(z.object({ body: z.object({ points: z.number().int().positive().max(1e7) }).strict() })), asyncHandler(async (req, res) => { res.status(201).json({ success: true, data: await incentiveExtras.redeem(req.user!, req.body.points) }) }))

incentivesRouter.get('/', validate(z.object({ query: z.object({ status: z.enum(['nominated', 'approved', 'rejected', 'posted', 'cancelled']).optional() }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await incentiveService.list(req.user!, { status: req.query.status as string | undefined }) })
}))
incentivesRouter.post('/', nominators, validate(Nominate), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await incentiveService.nominate(req.user!, req.body) })
}))
incentivesRouter.post('/post', requireRoles('payroll_admin'), validate(Post), asyncHandler(async (req, res) => {
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

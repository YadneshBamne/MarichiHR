import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { revisionService } from './revisions.service'

const id = z.string().uuid()
const money = z.number().positive().max(1e10)

// Mounted at /api/v1/salary-revisions behind authentication and the payroll app
export const revisionsRouter = Router()
revisionsRouter.get('/', validate(z.object({ query: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), employeeId: id.optional() }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await revisionService.list(req.user!, { status: req.query.status as string | undefined, employeeId: req.query.employeeId as string | undefined }) })
}))
revisionsRouter.post('/', validate(z.object({ body: z.object({ employeeId: id, newCtcAnnual: money, newWageMonthly: money, newSalaryStructureId: id.optional(), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().trim().min(3).max(300) }).strict() })), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await revisionService.create(req.user!, req.body) })
}))
revisionsRouter.post('/:id/approve', validate(z.object({ params: z.object({ id }), body: z.object({ note: z.string().trim().max(300).optional() }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await revisionService.decide(req.user!, String(req.params.id), true, req.body.note) })
}))
revisionsRouter.post('/:id/reject', validate(z.object({ params: z.object({ id }), body: z.object({ note: z.string().trim().min(2).max(300) }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await revisionService.decide(req.user!, String(req.params.id), false, req.body.note) })
}))
revisionsRouter.post('/:id/cancel', validate(z.object({ params: z.object({ id }) })), asyncHandler(async (req, res) => res.json({ success: true, data: await revisionService.cancel(req.user!, String(req.params.id)) })))
revisionsRouter.post('/:id/post-arrears', validate(z.object({ params: z.object({ id }), body: z.object({ cycleId: id }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await revisionService.postArrears(req.user!, String(req.params.id), req.body.cycleId) })
}))

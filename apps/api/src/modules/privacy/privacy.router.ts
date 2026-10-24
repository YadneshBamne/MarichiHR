import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { privacyService } from './privacy.service'

// Personal data: export a copy, ask for erasure (HR decides)
export const privacyRouter = Router()
privacyRouter.use(authenticate)
const id = z.object({ id: z.string().uuid() })

privacyRouter.get('/export/:id', validate(z.object({ params: id })), asyncHandler(async (req, res) => {
  const data = await privacyService.exportData(req.user!, String(req.params.id))
  res.setHeader('Content-Disposition', `attachment; filename="my-data-${data.profile.employeeCode}.json"`)
  res.json({ success: true, data })
}))
privacyRouter.get('/requests', validate(z.object({ query: z.object({ scope: z.enum(['mine', 'all']).default('mine') }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await privacyService.requests(req.user!, (req.query.scope as 'mine' | 'all') || 'mine') })
}))
privacyRouter.post('/erasure', validate(z.object({ body: z.object({ employeeId: z.string().uuid(), reason: z.string().trim().max(500).optional() }).strict() })), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await privacyService.requestErasure(req.user!, req.body.employeeId, req.body.reason) })
}))
privacyRouter.post('/requests/:id/decide', validate(z.object({ params: id, body: z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await privacyService.decide(req.user!, String(req.params.id), req.body.approve, req.body.note) })
}))

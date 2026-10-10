import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { policyService } from './policies.service'

const id = z.object({ id: z.string().uuid() })
const meta = {
  title: z.string().trim().min(2).max(140),
  category: z.string().trim().min(1).max(60),
  departmentIds: z.array(z.string().uuid()).max(100),
  workLocationIds: z.array(z.string().uuid()).max(100),
  requiresAcceptance: z.boolean(),
  acceptWithinDays: z.number().int().min(1).max(365),
}
const text = { body: z.string().trim().min(1).max(100_000), changeNote: z.string().trim().max(500).optional() }
const Create = z.object({ body: z.object({ ...text, title: meta.title, category: meta.category.optional(), departmentIds: meta.departmentIds.optional(), workLocationIds: meta.workLocationIds.optional(), requiresAcceptance: meta.requiresAcceptance.optional(), acceptWithinDays: meta.acceptWithinDays.optional() }).strict() })
const Update = z.object({ params: id, body: z.object(Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.optional()]))).strict() })
const Draft = z.object({ params: id, body: z.object(text).strict() })
const Publish = z.object({ params: id, body: z.object({ effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict() })
const IdOnly = z.object({ params: id })

export const policiesRouter = Router()
policiesRouter.use(authenticate)
const ADMIN = ['hr_admin', 'system_admin']
const admins = requireRoles(...ADMIN)
const isHR = (roles: string[]) => roles.some((r) => ADMIN.includes(r))

policiesRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await policyService.mine(req.user!) })
}))
policiesRouter.get('/manage', admins, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await policyService.manage(req.user!) })
}))
policiesRouter.post('/', admins, validate(Create), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await policyService.create(req.user!, req.body) })
}))
policiesRouter.get('/:id', validate(IdOnly), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await policyService.get(req.user!, String(req.params.id), isHR(req.user!.roleIds)) })
}))
policiesRouter.patch('/:id', admins, validate(Update), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await policyService.update(req.user!, String(req.params.id), req.body) })
}))
policiesRouter.put('/:id/draft', admins, validate(Draft), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await policyService.saveDraft(req.user!, String(req.params.id), req.body) })
}))
policiesRouter.post('/:id/publish', admins, validate(Publish), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await policyService.publish(req.user!, String(req.params.id), req.body.effectiveFrom) })
}))
policiesRouter.post('/:id/accept', validate(IdOnly), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await policyService.accept(req.user!, String(req.params.id)) })
}))
policiesRouter.get('/:id/acceptances', admins, validate(IdOnly), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await policyService.acceptances(req.user!, String(req.params.id)) })
}))
policiesRouter.post('/:id/remind', admins, validate(IdOnly), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await policyService.remind(req.user!, String(req.params.id)) })
}))
policiesRouter.post('/:id/archive', admins, validate(IdOnly), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await policyService.archive(req.user!, String(req.params.id)) })
}))

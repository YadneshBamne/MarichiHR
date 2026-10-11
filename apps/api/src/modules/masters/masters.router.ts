import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { mastersService } from './masters.service'
import { LIST_KEYS } from './masters.catalog'

const list = z.enum(LIST_KEYS as [string, ...string[]])
const label = z.string().trim().min(1).max(80)
const meta = z.record(z.string(), z.union([z.string().max(80), z.boolean(), z.number()])).optional()

export const mastersRouter = Router()
mastersRouter.use(authenticate)
const admins = requireRoles('hr_admin', 'system_admin')

// Everyone reads active values (every dropdown needs them); admins can include retired ones
mastersRouter.get('/', validate(z.object({ query: z.object({ all: z.enum(['1']).optional() }) })), asyncHandler(async (req, res) => {
  const all = req.query.all === '1' && req.user!.roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
  res.json({ success: true, data: await mastersService.all(req.user!.tenantId, all) })
}))
mastersRouter.post('/:list', admins, validate(z.object({ params: z.object({ list }), body: z.object({ label, code: z.string().trim().regex(/^[A-Za-z0-9_]{1,40}$/, 'Letters, digits and _ only').optional(), meta }).strict() })), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await mastersService.add(req.user!, String(req.params.list), req.body) })
}))
mastersRouter.patch('/:list/:id', admins, validate(z.object({ params: z.object({ list, id: z.string().uuid() }), body: z.object({ label: label.optional(), active: z.boolean().optional(), meta }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await mastersService.update(req.user!, String(req.params.list), String(req.params.id), req.body) })
}))
mastersRouter.put('/:list/order', admins, validate(z.object({ params: z.object({ list }), body: z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await mastersService.reorder(req.user!, String(req.params.list), req.body.ids) })
}))

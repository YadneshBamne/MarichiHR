import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { announcementService } from './announcements.service'

const id = z.object({ id: z.string().uuid() })
const when = z.string().datetime({ offset: true })
const fields = {
  title: z.string().trim().min(2).max(140),
  body: z.string().trim().min(1).max(10_000),
  departmentIds: z.array(z.string().uuid()).max(100),
  workLocationIds: z.array(z.string().uuid()).max(100),
  pinned: z.boolean(),
  requiresAck: z.boolean(),
  publishAt: when.nullable(),
  expiresAt: when.nullable(),
}
const Create = z.object({ body: z.object({ title: fields.title, body: fields.body, departmentIds: fields.departmentIds.optional(), workLocationIds: fields.workLocationIds.optional(), pinned: fields.pinned.optional(), requiresAck: fields.requiresAck.optional(), publishAt: fields.publishAt.optional(), expiresAt: fields.expiresAt.optional() }).strict() })
const Update = z.object({ params: id, body: z.object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()]))).strict() })

export const announcementsRouter = Router()
announcementsRouter.use(authenticate)
const admins = requireRoles('hr_admin', 'system_admin')

announcementsRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await announcementService.feed(req.user!, Math.min(50, Number(req.query.limit) || 50)) })
}))
announcementsRouter.get('/manage', admins, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await announcementService.manage(req.user!) })
}))
announcementsRouter.post('/', admins, validate(Create), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await announcementService.create(req.user!, req.body) })
}))
announcementsRouter.patch('/:id', admins, validate(Update), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await announcementService.update(req.user!, String(req.params.id), req.body) })
}))
announcementsRouter.post('/:id/archive', admins, validate(z.object({ params: id })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await announcementService.archive(req.user!, String(req.params.id)) })
}))
announcementsRouter.get('/:id/readers', admins, validate(z.object({ params: id })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await announcementService.readers(req.user!, String(req.params.id)) })
}))
announcementsRouter.post('/:id/read', validate(z.object({ params: id, body: z.object({ acknowledge: z.boolean().optional() }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await announcementService.markRead(req.user!, String(req.params.id), !!req.body.acknowledge) })
}))

import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { holidayService } from './holidays.service'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const id = z.object({ id: z.string().uuid() })
const holidayBody = {
  name: z.string().trim().min(1).max(80),
  date,
  type: z.enum(['national', 'regional', 'religious', 'company']).optional(),
  isOptional: z.boolean().optional(),
}
const calendarBody = {
  name: z.string().trim().min(1).max(80),
  year: z.number().int().min(2000).max(2100),
  countryCode: z.string().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()).nullable().optional(),
  workLocationId: z.string().uuid().nullable().optional(),
}

const CreateCalendar = z.object({ body: z.object({ ...calendarBody, holidays: z.array(z.object(holidayBody).strict()).max(100).optional() }).strict() })
const UpdateCalendar = z.object({ params: id, body: z.object({ name: calendarBody.name.optional(), countryCode: calendarBody.countryCode, workLocationId: calendarBody.workLocationId }).strict() })
const AddHolidays = z.object({ params: id, body: z.object({ holidays: z.array(z.object(holidayBody).strict()).min(1).max(100) }).strict() })
const UpdateHoliday = z.object({ params: id, body: z.object({ name: holidayBody.name.optional(), date: date.optional(), type: holidayBody.type, isOptional: holidayBody.isOptional }).strict() })
const CopyCalendar = z.object({ params: id, body: z.object({ year: calendarBody.year }).strict() })
const ListQuery = z.object({ query: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }) })
const RangeQuery = z.object({ query: z.object({ from: date, to: date }) })

export const holidaysRouter = Router()
holidaysRouter.use(authenticate)
const admins = requireRoles('hr_admin', 'system_admin')

// Everyone: the company's calendars for a year (holidays aren't private), with the ones that apply to the viewer marked
holidaysRouter.get('/', validate(ListQuery), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await holidayService.list(req.user!, Number(req.query.year) || new Date().getUTCFullYear()) })
}))
holidaysRouter.get('/mine', validate(RangeQuery), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await holidayService.mine(req.user!, String(req.query.from), String(req.query.to)) })
}))

holidaysRouter.post('/calendars', admins, validate(CreateCalendar), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await holidayService.createCalendar(req.user!, req.body) })
}))
holidaysRouter.patch('/calendars/:id', admins, validate(UpdateCalendar), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await holidayService.updateCalendar(req.user!, String(req.params.id), req.body) })
}))
holidaysRouter.post('/calendars/:id/archive', admins, validate(z.object({ params: id })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await holidayService.archiveCalendar(req.user!, String(req.params.id)) })
}))
holidaysRouter.post('/calendars/:id/copy', admins, validate(CopyCalendar), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await holidayService.copyCalendar(req.user!, String(req.params.id), req.body.year) })
}))
holidaysRouter.post('/calendars/:id/holidays', admins, validate(AddHolidays), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await holidayService.addHolidays(req.user!, String(req.params.id), req.body.holidays) })
}))
holidaysRouter.patch('/:id', admins, validate(UpdateHoliday), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await holidayService.updateHoliday(req.user!, String(req.params.id), req.body) })
}))
holidaysRouter.post('/:id/archive', admins, validate(z.object({ params: id })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await holidayService.archiveHoliday(req.user!, String(req.params.id)) })
}))

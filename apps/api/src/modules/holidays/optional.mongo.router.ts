import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { businessToday } from '../../shared/utils/businessDate'
import { calendarApplies, holidayTargetOf } from '../../shared/utils/holidays'
import { AuditLog } from '../../infrastructure/mongo/mongo'

// Optional holidays (MongoDB API only). Each calendar has a yearly quota (calendar field optionalQuota, default 2; 0 = nobody can pick).
// A person picks up to the quota from the optional holidays of a calendar that applies to them, and can change a pick until the day
// before the holiday. A pick is a day off for that person only (see shared/utils/optional-holidays.ts for where that is honoured).
// ponytail: no manager notice or approval on a pick; add an approval step if a company wants to cap how many people are off together.
export const optionalHolidaysRouter = Router()
optionalHolidaysRouter.use(authenticate)

const ADMINS = ['hr_admin', 'system_admin']
const col = (n: string) => mongoose.connection.collection(n)
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const quotaOf = (c: any) => (typeof c?.optionalQuota === 'number' ? c.optionalQuota : 2)
const idp = z.object({ id: z.string().uuid() })
const me = (req: any) => { if (!req.user.employeeId) throw new AppError('Optional holidays are for employees', 403); return req.user.employeeId as string }

let indexed = false
async function ready() {
  if (indexed) return
  await col('optional_holiday_picks').createIndex({ tenantId: 1, employeeId: 1, holidayId: 1 }, { unique: true })
  indexed = true
}
const audit = (req: any, action: string, entityId: string, newValue: any) => AuditLog.create({ tenantId: req.user.tenantId, userId: req.user.userId, action, entityType: 'optional_holiday', entityId, newValue })

// The calendars of a year with their optional holidays, the quota, and what the viewer has picked
optionalHolidaysRouter.get('/', validate(z.object({ query: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }) })), asyncHandler(async (req, res) => {
  const { tenantId, employeeId } = req.user!
  const today = ymd(await businessToday(tenantId))
  const year = Number(req.query.year) || Number(today.slice(0, 4))
  const cals: any[] = await col('holiday_calendars').find({ tenantId, year, active: true } as any).sort({ name: 1 }).toArray()
  const hols: any[] = cals.length ? await col('holidays').find({ calendarId: { $in: cals.map((c) => c._id) }, active: true, isOptional: true } as any).sort({ date: 1 }).toArray() : []
  const target = employeeId ? await holidayTargetOf(employeeId) : null
  const mine = new Set<string>(employeeId && hols.length ? (await col('optional_holiday_picks').find({ tenantId, employeeId, holidayId: { $in: hols.map((h) => h._id) } } as any).project({ holidayId: 1 }).toArray()).map((p: any) => p.holidayId) : [])
  res.json({
    success: true,
    data: {
      year,
      calendars: cals.map((c) => {
        const list = hols.filter((h) => h.calendarId === c._id)
        return {
          id: c._id, name: c.name, quota: quotaOf(c), appliesToMe: target ? calendarApplies(c, target) : false,
          picked: list.filter((h) => mine.has(h._id)).length,
          holidays: list.map((h) => ({ id: h._id, name: h.name, date: ymd(h.date), pickedByMe: mine.has(h._id), canChange: ymd(h.date) > today })),
        }
      }),
    },
  })
}))

optionalHolidaysRouter.put('/calendars/:id/quota', requireRoles(...ADMINS), validate(z.object({ params: idp, body: z.object({ quota: z.number().int().min(0).max(30) }).strict() })), asyncHandler(async (req, res) => {
  const r = await col('holiday_calendars').updateOne({ _id: String(req.params.id), tenantId: req.user!.tenantId, active: true } as any, { $set: { optionalQuota: req.body.quota } })
  if (!r.matchedCount) throw new AppError('Holiday calendar not found', 404)
  await audit(req, 'OPTIONAL_HOLIDAY_QUOTA_SET', String(req.params.id), { quota: req.body.quota })
  res.json({ success: true, data: { quota: req.body.quota } })
}))

async function holidayOf(tenantId: string, holidayId: string) {
  const h: any = await col('holidays').findOne({ _id: holidayId, active: true, isOptional: true } as any)
  const cal: any = h && (await col('holiday_calendars').findOne({ _id: h.calendarId, tenantId, active: true } as any))
  if (!h || !cal) throw new AppError('Optional holiday not found', 404)
  return { h, cal }
}

optionalHolidaysRouter.post('/picks', validate(z.object({ body: z.object({ holidayId: z.string().uuid() }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId } = req.user!
  const employeeId = me(req)
  await ready()
  const { h, cal } = await holidayOf(tenantId, req.body.holidayId)
  if (!calendarApplies(cal, await holidayTargetOf(employeeId))) throw new AppError('This holiday is not in your calendar', 403)
  const quota = quotaOf(cal)
  if (quota <= 0) throw new AppError('Optional holidays cannot be picked in this calendar', 400)
  const date = ymd(h.date)
  if (date <= ymd(await businessToday(tenantId))) throw new AppError('Picks close the day before the holiday', 400)
  if (await col('optional_holiday_picks').findOne({ tenantId, employeeId, holidayId: h._id } as any)) return res.json({ success: true, data: { picked: true } })
  const onLeave = await col('leave_requests').findOne({ employeeId, status: { $in: ['pending', 'approved'] }, startDate: { $lte: h.date }, endDate: { $gte: h.date } } as any)
  if (onLeave) throw new AppError('You already have leave on that day. Cancel it first if you want the holiday instead.', 409)
  // insert first, then count: two quick picks can never both slip past the quota
  const pick = { _id: crypto.randomUUID(), tenantId, employeeId, holidayId: h._id, createdAt: new Date() }
  await col('optional_holiday_picks').insertOne(pick as any)
  const ids = (await col('holidays').find({ calendarId: cal._id, active: true, isOptional: true } as any).project({ _id: 1 }).toArray()).map((x: any) => x._id)
  const used = await col('optional_holiday_picks').countDocuments({ tenantId, employeeId, holidayId: { $in: ids } } as any)
  if (used > quota) {
    await col('optional_holiday_picks').deleteOne({ _id: pick._id } as any)
    throw new AppError(`You have already picked all ${quota} optional holiday${quota === 1 ? '' : 's'} for this calendar. Unpick one first.`, 409)
  }
  await audit(req, 'OPTIONAL_HOLIDAY_PICKED', h._id, { name: h.name, date })
  res.status(201).json({ success: true, data: { picked: true, used, quota } })
}))

optionalHolidaysRouter.delete('/picks/:id', validate(z.object({ params: idp })), asyncHandler(async (req, res) => {
  const { tenantId } = req.user!
  const employeeId = me(req)
  const { h } = await holidayOf(tenantId, String(req.params.id))
  if (ymd(h.date) <= ymd(await businessToday(tenantId))) throw new AppError('Picks close the day before the holiday', 400)
  const r = await col('optional_holiday_picks').deleteOne({ tenantId, employeeId, holidayId: h._id } as any)
  if (r.deletedCount) await audit(req, 'OPTIONAL_HOLIDAY_UNPICKED', h._id, { name: h.name, date: ymd(h.date) })
  res.json({ success: true, data: { picked: false } })
}))

// HR: who picked which optional holiday on a date
optionalHolidaysRouter.get('/picks', requireRoles(...ADMINS), validate(z.object({ query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) })), asyncHandler(async (req, res) => {
  const { tenantId } = req.user!
  const date = new Date(`${String(req.query.date)}T00:00:00.000Z`)
  const cals: any[] = await col('holiday_calendars').find({ tenantId, active: true } as any).project({ _id: 1, name: 1 }).toArray()
  const hols: any[] = cals.length ? await col('holidays').find({ calendarId: { $in: cals.map((c) => c._id) }, active: true, isOptional: true, date } as any).toArray() : []
  const picks: any[] = hols.length ? await col('optional_holiday_picks').find({ tenantId, holidayId: { $in: hols.map((h) => h._id) } } as any).toArray() : []
  const emps: any[] = picks.length ? await col('employees').find({ tenantId, _id: { $in: picks.map((p) => p.employeeId) } } as any).project({ firstName: 1, lastName: 1, employeeCode: 1 }).toArray() : []
  const who = new Map(emps.map((e) => [e._id, { id: e._id, name: `${e.firstName} ${e.lastName}`, employeeCode: e.employeeCode }]))
  res.json({
    success: true,
    data: hols.map((h) => ({ id: h._id, name: h.name, calendar: cals.find((c) => c._id === h.calendarId)?.name ?? null, people: picks.filter((p) => p.holidayId === h._id).map((p) => who.get(p.employeeId)).filter(Boolean) })),
  })
}))

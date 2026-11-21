import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { requireFeature } from '../../middleware/module.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { getReportingSubtreeIds } from '../../shared/utils/access'
import { getTenantTimezone, localTimeString } from '../../shared/utils/businessDate'
import { Employee, AuditLog } from '../../infrastructure/mongo/mongo'

// GPS live tracking for field staff (MongoDB mode only). Built to be fair to the people tracked:
//  - HR names who is tracked and the working hours; nobody else is ever tracked;
//  - the person starts each tracking session themselves after reading what is shared and with whom;
//  - the phone reports only inside the working hours; a ping outside them ends the session;
//  - only their managers and HR can see them; the person always sees their own trail;
//  - points are deleted after the retention period (default 30 days) by the tracking-purge job.
// The web app reports while it is open and awake; a native app would keep reporting in the background (not built).
export const trackingRouter = Router()
trackingRouter.use(authenticate, requireFeature('gpsTracking'))

const isHR = (roleIds: string[]) => roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data })
const uuid = () => crypto.randomUUID()
const col = (n: string) => mongoose.connection.collection(n)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const MIN_GAP_MS = 10_000

type Settings = { enabled: boolean; startTime: string; endTime: string; intervalSeconds: number; retentionDays: number; employeeIds: string[] }
const DEFAULTS: Settings = { enabled: false, startTime: '08:00', endTime: '18:00', intervalSeconds: 60, retentionDays: 30, employeeIds: [] }
async function settings(tenantId: string): Promise<Settings> { return { ...DEFAULTS, ...((await col('gps_settings').findOne({ _id: tenantId } as any)) ?? {}) } }
async function inHours(tenantId: string, s: Settings) {
  const now = localTimeString(new Date(), await getTenantTimezone(tenantId))
  return now >= s.startTime && now <= s.endTime
}
const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const R = 6371000, rad = (x: number) => (x * Math.PI) / 180
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}
const needEmployee = (req: any) => { if (!req.user.employeeId) throw new AppError('Only employees can be tracked', 403); return req.user.employeeId as string }

// HR picks who is tracked: names only
trackingRouter.get('/people', validate(z.object({ query: z.object({ q: z.string().trim().min(2).max(40) }) })), asyncHandler(async (req, res) => {
  if (!isHR(req.user!.roleIds)) throw new AppError('Only HR can do this', 403)
  const q = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rows: any[] = await Employee.find({ tenantId: req.user!.tenantId, active: true, employmentStatus: { $ne: 'terminated' }, $or: [{ firstName: new RegExp(q, 'i') }, { lastName: new RegExp(q, 'i') }] }).select('firstName lastName employeeCode').limit(15).lean()
  ok(res, rows.map((e) => ({ id: e._id, name: `${e.firstName} ${e.lastName}`, code: e.employeeCode })))
}))

trackingRouter.get('/settings', asyncHandler(async (req, res) => {
  const { tenantId, employeeId, roleIds } = req.user!
  const s = await settings(tenantId)
  const session: any = employeeId ? await col('gps_sessions').findOne({ tenantId, employeeId, endedAt: null } as any) : null
  const people: any[] = isHR(roleIds) && s.employeeIds.length ? await Employee.find({ _id: { $in: s.employeeIds } }).select('firstName lastName employeeCode').lean() : []
  ok(res, { ...s, tracked: !!employeeId && s.employeeIds.includes(employeeId), hoursOpenNow: await inHours(tenantId, s), session: session ? { id: session._id, startedAt: session.startedAt } : null, ...(isHR(roleIds) && { people: people.map((p) => ({ id: p._id, name: `${p.firstName} ${p.lastName}`, code: p.employeeCode })) }) })
}))

trackingRouter.put('/settings', validate(z.object({ body: z.object({ enabled: z.boolean(), startTime: time, endTime: time, intervalSeconds: z.number().int().min(30).max(600), retentionDays: z.number().int().min(1).max(365), employeeIds: z.array(z.string().uuid()).max(2000) }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId, roleIds } = req.user!
  if (!isHR(roleIds)) throw new AppError('Only HR can change this', 403)
  const b = req.body
  if (b.endTime <= b.startTime) throw new AppError('The working hours must end after they start', 400)
  const ids = [...new Set(b.employeeIds as string[])]
  if (ids.length && (await Employee.countDocuments({ tenantId, active: true, _id: { $in: ids } })) !== ids.length) throw new AppError('Employee not found', 404)
  const next = { ...b, employeeIds: ids }
  await col('gps_settings').updateOne({ _id: tenantId } as any, { $set: { ...next, updatedBy: userId, updatedAt: new Date() } }, { upsert: true })
  // Anyone no longer tracked has their open session closed at once
  await col('gps_sessions').updateMany({ tenantId, endedAt: null, ...(b.enabled ? { employeeId: { $nin: ids } } : {}) } as any, { $set: { endedAt: new Date(), endedBy: 'settings' } })
  await AuditLog.create({ tenantId, userId, action: 'GPS_TRACKING_SETTINGS', entityType: 'tracking', entityId: tenantId, newValue: { enabled: b.enabled, people: ids.length, hours: `${b.startTime}-${b.endTime}` } })
  ok(res, next)
}))

// The person starts tracking themselves, after agreeing to what is shared
trackingRouter.post('/start', validate(z.object({ body: z.object({ consent: z.literal(true) }).strict() })), asyncHandler(async (req, res) => {
  const employeeId = needEmployee(req)
  const { tenantId } = req.user!
  const s = await settings(tenantId)
  if (!s.enabled || !s.employeeIds.includes(employeeId)) throw new AppError('Location tracking is not set up for you', 403)
  if (!(await inHours(tenantId, s))) throw new AppError(`Tracking runs only between ${s.startTime} and ${s.endTime}`, 400)
  await col('gps_sessions').updateMany({ tenantId, employeeId, endedAt: null } as any, { $set: { endedAt: new Date(), endedBy: 'restart' } })
  const session = { _id: uuid(), tenantId, employeeId, startedAt: new Date(), consentAt: new Date(), endedAt: null, lastPing: null }
  await col('gps_sessions').insertOne(session as any)
  ok(res, { sessionId: session._id, intervalSeconds: s.intervalSeconds }, 201)
}))

trackingRouter.post('/ping', validate(z.object({ body: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100000).optional(), speed: z.number().min(0).max(500).nullable().optional() }).strict() })), asyncHandler(async (req, res) => {
  const employeeId = needEmployee(req)
  const { tenantId } = req.user!
  const s = await settings(tenantId)
  const session: any = await col('gps_sessions').findOne({ tenantId, employeeId, endedAt: null } as any)
  if (!session) throw new AppError('Start tracking first', 409)
  if (!s.enabled || !s.employeeIds.includes(employeeId) || !(await inHours(tenantId, s))) {
    await col('gps_sessions').updateOne({ _id: session._id } as any, { $set: { endedAt: new Date(), endedBy: 'hours' } })
    throw new AppError('Tracking has ended for today', 409)
  }
  if (session.lastPing && Date.now() - new Date(session.lastPing).getTime() < MIN_GAP_MS) return ok(res, { stored: false })
  const at = new Date()
  await col('gps_points').insertOne({ _id: uuid(), tenantId, employeeId, sessionId: session._id, at, lat: req.body.latitude, lng: req.body.longitude, accuracy: req.body.accuracy ?? null, speed: req.body.speed ?? null } as any)
  await col('gps_sessions').updateOne({ _id: session._id } as any, { $set: { lastPing: at } })
  ok(res, { stored: true })
}))

trackingRouter.post('/stop', asyncHandler(async (req, res) => {
  const employeeId = needEmployee(req)
  await col('gps_sessions').updateMany({ tenantId: req.user!.tenantId, employeeId, endedAt: null } as any, { $set: { endedAt: new Date(), endedBy: 'self' } })
  ok(res, { stopped: true })
}))

// Who can see whom: HR everyone, a manager their reporting line, anyone themselves
async function visible(req: any): Promise<string[] | null> {
  if (isHR(req.user.roleIds)) return null
  if (req.user.employeeId && req.user.roleIds.includes('manager')) return getReportingSubtreeIds(req.user.employeeId, req.user.tenantId)
  throw new AppError('Only managers and HR can see live locations', 403)
}
trackingRouter.get('/live', asyncHandler(async (req, res) => {
  const team = await visible(req)
  const { tenantId } = req.user!
  const s = await settings(tenantId)
  const sessions: any[] = await col('gps_sessions').find({ tenantId, endedAt: null, ...(team && { employeeId: { $in: team } }) } as any).toArray()
  const nm = new Map(((await Employee.find({ _id: { $in: sessions.map((x) => x.employeeId) } }).select('firstName lastName employeeCode').lean()) as any[]).map((e) => [e._id, `${e.firstName} ${e.lastName}`]))
  const out = []
  for (const x of sessions) {
    const p: any = await col('gps_points').findOne({ sessionId: x._id } as any, { sort: { at: -1 } })
    out.push({ employeeId: x.employeeId, name: nm.get(x.employeeId) ?? null, since: x.startedAt, last: p ? { latitude: p.lat, longitude: p.lng, accuracy: p.accuracy, at: p.at } : null, stale: !p || Date.now() - new Date(p.at).getTime() > s.intervalSeconds * 3000 })
  }
  ok(res, out)
}))

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
trackingRouter.get('/trail', validate(z.object({ query: z.object({ employeeId: z.string().uuid().optional(), date: day }) })), asyncHandler(async (req, res) => {
  const { tenantId, employeeId: me } = req.user!
  const who = String(req.query.employeeId ?? me ?? '')
  if (who !== me) { const team = await visible(req); if (team && !team.includes(who)) throw new AppError('Not found', 404) }
  const from = new Date(`${req.query.date}T00:00:00Z`), to = new Date(from.getTime() + 86400000)
  const pts: any[] = await col('gps_points').find({ tenantId, employeeId: who, at: { $gte: from, $lt: to } } as any).sort({ at: 1 }).limit(3000).toArray()
  let km = 0
  for (let i = 1; i < pts.length; i++) km += metres({ lat: pts[i - 1].lat, lng: pts[i - 1].lng }, { lat: pts[i].lat, lng: pts[i].lng })
  if (who !== me) await AuditLog.create({ tenantId, userId: req.user!.userId, action: 'GPS_TRAIL_VIEWED', entityType: 'employee', entityId: who, newValue: { date: req.query.date } })
  ok(res, { points: pts.map((p) => ({ latitude: p.lat, longitude: p.lng, accuracy: p.accuracy, at: p.at })), distanceKm: Math.round(km / 100) / 10 })
}))

// Deletes points past each company's retention period and closes sessions left open overnight (run daily by the tracking-purge job)
export async function purgeTracking(only?: string) {
  const all: any[] = await col('gps_settings').find(only ? { _id: only } : {} as any).toArray()
  let removed = 0
  for (const s of all) {
    const r = await col('gps_points').deleteMany({ tenantId: s._id, at: { $lt: new Date(Date.now() - (s.retentionDays ?? DEFAULTS.retentionDays) * 86400000) } } as any)
    removed += r.deletedCount ?? 0
  }
  await col('gps_sessions').updateMany({ endedAt: null, startedAt: { $lt: new Date(Date.now() - 20 * 3600000) } } as any, { $set: { endedAt: new Date(), endedBy: 'purge' } })
  return removed
}

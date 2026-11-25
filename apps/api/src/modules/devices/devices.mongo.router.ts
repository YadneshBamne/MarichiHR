import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { requireFeature, requireModule } from '../../middleware/module.middleware.mongo'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { Employee, AuditLog } from '../../infrastructure/mongo/mongo'
import { deviceIndexes, replayUnknown, serialOf } from './adms.router'

// Biometric terminals: HR registers each terminal by its serial number and gives every person the ID they use on it (the PIN); the
// terminal then pushes punches to /iclock (adms.router.ts). Punches land in attendance like any other. Terminals nobody has registered
// are refused. Only HR sees or changes any of this. MongoDB mode only.
export const devicesRouter = Router()
devicesRouter.use(authenticate, requireFeature('biometricDevices'), requireModule('attendance'))
const HR = ['hr_admin', 'system_admin']
devicesRouter.use((req, _res, next) => { if (!req.user!.roleIds.some((r: string) => HR.includes(r))) return next(new AppError('Only HR can manage terminals', 403)); next() })

const col = (n: string) => mongoose.connection.collection(n)
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data })
const uuid = () => crypto.randomUUID()
const idp = z.object({ id: z.string().uuid() })
const audit = (req: any, action: string, entityId: string, newValue?: object) => AuditLog.create({ tenantId: req.user.tenantId, userId: req.user.userId, action, entityType: 'device', entityId, newValue })
const validZone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true } catch { return false } }
const Pin = z.string().trim().regex(/^[A-Za-z0-9]{1,24}$/, 'Use letters and digits only, up to 24 characters')
const Body = z.object({ name: z.string().trim().min(2).max(80), workLocationId: z.string().uuid().nullable().optional(), timezone: z.string().trim().max(60).nullable().optional() }).strict()

async function checkBody(tenantId: string, b: z.infer<typeof Body>) {
  if (b.timezone && !validZone(b.timezone)) throw new AppError('That timezone is not recognised (use a name like Africa/Lusaka)', 400)
  if (b.workLocationId && !(await col('work_locations').findOne({ _id: b.workLocationId, tenantId } as any))) throw new AppError('Work location not found', 404)
}
const view = (d: any, punchesToday = 0) => ({ id: d._id, name: d.name, serial: d.serial, workLocationId: d.workLocationId ?? null, timezone: d.timezone ?? null, active: d.active !== false, firmware: d.firmware ?? null, lastSeenAt: d.lastSeenAt ?? null, lastPunchAt: d.lastPunchAt ?? null, online: !!d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < 5 * 60000, punchesToday })

// How to point a terminal at this server. DEVICE_PUSH_HOST and DEVICE_PUSH_PORT name a plain-http entry for terminals that cannot use https.
devicesRouter.get('/setup', asyncHandler(async (_req, res) => {
  const host = process.env.DEVICE_PUSH_HOST || null
  ok(res, { host, port: host ? Number(process.env.DEVICE_PUSH_PORT) || 80 : null, plainHttpReady: !!host, path: '/iclock/cdata' })
}))

devicesRouter.get('/', asyncHandler(async (req, res) => {
  await deviceIndexes()
  const tenantId = req.user!.tenantId
  const rows: any[] = await col('biometric_devices').find({ tenantId } as any).sort({ name: 1 }).toArray()
  const since = new Date(Date.now() - 86400000)
  const counts: any[] = await col('device_punches').aggregate([{ $match: { tenantId, receivedAt: { $gte: since } } }, { $group: { _id: '$deviceId', n: { $sum: 1 } } }]).toArray()
  const n = new Map(counts.map((c) => [c._id, c.n]))
  ok(res, rows.map((d) => view(d, n.get(d._id) ?? 0)))
}))
devicesRouter.post('/', validate(z.object({ body: Body.extend({ serial: z.string().transform(serialOf).pipe(z.string().regex(/^[A-Z0-9._-]{4,40}$/, 'The serial number is on the label on the back of the terminal')) }).strict() })), asyncHandler(async (req, res) => {
  await deviceIndexes()
  const { tenantId } = req.user!
  const b = req.body
  await checkBody(tenantId, b)
  const taken: any = await col('biometric_devices').findOne({ serial: b.serial } as any)
  if (taken) throw new AppError(taken.tenantId === tenantId ? 'This terminal is already registered' : 'This serial number is already registered by another company', 409)
  const d = { _id: uuid(), tenantId, name: b.name, serial: b.serial, workLocationId: b.workLocationId ?? null, timezone: b.timezone ?? null, active: true, createdAt: new Date(), acceptFrom: new Date(Date.now() - 2 * 86400000), lastSeenAt: null, lastPunchAt: null }
  await col('biometric_devices').insertOne(d as any)
  await audit(req, 'DEVICE_REGISTERED', d._id, { name: d.name, serial: d.serial })
  ok(res, view(d), 201)
}))
devicesRouter.put('/:id', validate(z.object({ params: idp, body: Body.extend({ active: z.boolean() }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId } = req.user!
  await checkBody(tenantId, req.body)
  const { name, workLocationId, timezone, active } = req.body
  const r = await col('biometric_devices').findOneAndUpdate({ _id: String(req.params.id), tenantId } as any, { $set: { name, workLocationId: workLocationId ?? null, timezone: timezone ?? null, active } }, { returnDocument: 'after' })
  if (!r) throw new AppError('Terminal not found', 404)
  await audit(req, 'DEVICE_UPDATED', String(req.params.id), { name, active })
  ok(res, view(r))
}))
devicesRouter.delete('/:id', validate(z.object({ params: idp })), asyncHandler(async (req, res) => {
  const r = await col('biometric_devices').deleteOne({ _id: String(req.params.id), tenantId: req.user!.tenantId } as any)
  if (!r.deletedCount) throw new AppError('Terminal not found', 404)
  await audit(req, 'DEVICE_REMOVED', String(req.params.id))
  ok(res, { removed: true })
}))

// ─── The ID each person uses on the terminals ───
devicesRouter.get('/people', asyncHandler(async (req, res) => {
  const { tenantId } = req.user!
  const q = String(req.query.q ?? '').trim()
  const where: any = { tenantId, employmentStatus: { $ne: 'terminated' }, ...(q && { $or: ['firstName', 'lastName', 'employeeCode'].map((f) => ({ [f]: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } })) }) }
  const emps: any[] = await Employee.find(where).select('firstName lastName employeeCode').sort({ firstName: 1 }).limit(100).lean()
  const maps: any[] = await col('device_users').find({ tenantId, employeeId: { $in: emps.map((e) => e._id) } } as any).toArray()
  const pin = new Map(maps.map((m) => [m.employeeId, m.pin]))
  ok(res, emps.map((e) => ({ id: e._id, name: `${e.firstName} ${e.lastName}`, code: e.employeeCode, pin: pin.get(e._id) ?? null })))
}))
devicesRouter.put('/people/:id', validate(z.object({ params: idp, body: z.object({ pin: Pin.nullable() }).strict() })), asyncHandler(async (req, res) => {
  await deviceIndexes()
  const { tenantId } = req.user!
  const emp = await Employee.findOne({ _id: String(req.params.id), tenantId }).select('_id').lean()
  if (!emp) throw new AppError('Employee not found', 404)
  const { pin } = req.body
  if (pin === null) { await col('device_users').deleteOne({ tenantId, employeeId: String(req.params.id) } as any); await audit(req, 'DEVICE_ID_CLEARED', String(req.params.id)); return ok(res, { pin: null, applied: 0 }) }
  const other: any = await col('device_users').findOne({ tenantId, pin } as any)
  if (other && other.employeeId !== String(req.params.id)) throw new AppError('Another person already has this terminal ID', 409)
  await col('device_users').updateOne({ tenantId, employeeId: String(req.params.id) } as any, { $set: { pin, updatedAt: new Date() }, $setOnInsert: { _id: uuid() } }, { upsert: true })
  await audit(req, 'DEVICE_ID_SET', String(req.params.id), { pin })
  ok(res, { pin, applied: await replayUnknown(tenantId, pin) })
}))
// Give everyone without an ID the number in their employee code (EMP0007 becomes 7), skipping any that would clash
devicesRouter.post('/people/use-codes', asyncHandler(async (req, res) => {
  await deviceIndexes()
  const { tenantId } = req.user!
  const emps: any[] = await Employee.find({ tenantId, employmentStatus: { $ne: 'terminated' } }).select('employeeCode').lean()
  const have = new Set(((await col('device_users').find({ tenantId } as any).toArray()) as any[]).flatMap((m) => [m.employeeId, 'pin:' + m.pin]))
  let set = 0, skipped = 0, applied = 0
  for (const e of emps) {
    const pin = String(e.employeeCode ?? '').replace(/\D/g, '').replace(/^0+/, '')
    if (have.has(e._id)) continue
    if (!pin || have.has('pin:' + pin)) { skipped++; continue }
    await col('device_users').insertOne({ _id: uuid(), tenantId, employeeId: e._id, pin, updatedAt: new Date() } as any)
    have.add('pin:' + pin); set++
    applied += await replayUnknown(tenantId, pin)
  }
  await audit(req, 'DEVICE_IDS_FROM_CODES', tenantId, { set, skipped })
  ok(res, { set, skipped, applied })
}))

// ─── Punches that need a person to look: no ID matched, or the attendance rules refused them ───
devicesRouter.get('/punches', validate(z.object({ query: z.object({ status: z.enum(['attention', 'all']).default('attention') }) })), asyncHandler(async (req, res) => {
  const { tenantId } = req.user!
  const rows: any[] = await col('device_punches').find({ tenantId, ...(req.query.status === 'all' ? {} : { status: { $in: ['unknown_user', 'rejected'] } }) } as any).sort({ at: -1 }).limit(100).toArray()
  const dev = new Map(((await col('biometric_devices').find({ _id: { $in: rows.map((r) => r.deviceId) } } as any).toArray()) as any[]).map((d) => [d._id, d.name]))
  const nm = new Map(((await Employee.find({ _id: { $in: rows.map((r) => r.employeeId).filter(Boolean) } }).select('firstName lastName').lean()) as any[]).map((e) => [e._id, `${e.firstName} ${e.lastName}`]))
  ok(res, rows.map((r) => ({ id: r._id, device: dev.get(r.deviceId) ?? null, pin: r.pin, employee: nm.get(r.employeeId) ?? null, at: r.at, status: r.status, direction: r.direction ?? null, reason: r.reason ?? null })))
}))
devicesRouter.post('/punches/:id/dismiss', validate(z.object({ params: idp })), asyncHandler(async (req, res) => {
  const r = await col('device_punches').updateOne({ _id: String(req.params.id), tenantId: req.user!.tenantId, status: { $in: ['unknown_user', 'rejected'] } } as any, { $set: { status: 'dismissed', dismissedBy: req.user!.userId, processedAt: new Date() } })
  if (!r.matchedCount) throw new AppError('Punch not found', 404)
  ok(res, { dismissed: true })
}))

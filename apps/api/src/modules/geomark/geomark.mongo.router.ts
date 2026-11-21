import { Router, RequestHandler } from 'express'
import multer from 'multer'
import { z } from 'zod'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { requireFeature, requireModule } from '../../middleware/module.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { getReportingSubtreeIds } from '../../shared/utils/access'
import { storage, storageConfigured } from '../../infrastructure/storage/storage'
import { Employee, AuditLog, Notification } from '../../infrastructure/mongo/mongo'
import { attendanceService } from '../attendance/attendance.service'

// GeoMark+ and Visage: clock in with proof. The person takes a selfie and shares their location at the moment they punch; the API checks
// the location against the office geo-fences, keeps the selfie in private storage and flags anything odd (outside the fence, a vague
// location) for a manager or HR to look at. HR can require this for everyone (then the plain clock-in is refused).
// Face matching: people enrol a reference photo that HR approves; every proof is shown next to it for review. Automatic matching needs a
// face-recognition service, which is not bundled: GEOMARK_FACE_PROVIDER is the hook (none today), so reviewers decide.
// Privacy: a face photo is biometric data. Enrolling needs explicit consent, people can erase their photo at any time, and proofs are
// deleted after the retention period (default 90 days) by the geomark-purge job.
// MongoDB mode only.
export const geomarkRouter = Router()
geomarkRouter.use(authenticate, requireFeature('geomark'), requireModule('attendance'))

const STAFF = ['hr_admin', 'system_admin']
const isHR = (roleIds: string[]) => roleIds.some((r) => STAFF.includes(r))
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data })
const uuid = () => crypto.randomUUID()
const idp = z.object({ id: z.string().uuid() })
const MAX_PHOTO = 2 * 1024 * 1024
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const col = (n: string) => mongoose.connection.collection(n)
const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO, files: 1 } })
const accept = (mw: RequestHandler): RequestHandler => (req, res, next) => mw(req, res, (err: any) => {
  if (!err) return next()
  next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 'The photo can be up to 2 MB' : 'The photo could not be read', 400))
})

type Settings = { tenantId: string; enabled: boolean; requireProof: boolean; requireSelfie: boolean; requireLocation: boolean; maxAccuracyMeters: number; retentionDays: number }
const DEFAULTS = { enabled: false, requireProof: false, requireSelfie: true, requireLocation: true, maxAccuracyMeters: 100, retentionDays: 90 }
export async function geomarkSettings(tenantId: string): Promise<Settings> {
  const s: any = await col('geomark_settings').findOne({ _id: tenantId } as any)
  return { tenantId, ...DEFAULTS, ...(s ?? {}) }
}
// Used by the plain clock-in: when proof is required, only this module's punch may clock someone in
export async function proofRequired(tenantId: string) { const s = await geomarkSettings(tenantId); return s.enabled && s.requireProof }

function metres(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000, rad = (x: number) => (x * Math.PI) / 180
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
// ponytail: the hook for an outside face-recognition service. null = no automatic score; reviewers compare the two photos.
async function faceScore(_reference: Buffer, _selfie: Buffer): Promise<number | null> { return null }

async function putPhoto(tenantId: string, employeeId: string, kind: 'ref' | 'proof', file: { buffer: Buffer; mimetype: string } | undefined) {
  if (!storageConfigured()) throw new AppError('Photo storage is not set up yet. Ask your administrator.', 503)
  if (!file) throw new AppError('Take a photo first', 400)
  const ext = TYPES[file.mimetype]
  if (!ext) throw new AppError('Use a JPEG, PNG or WebP photo', 400)
  const key = `geomark/${tenantId}/${employeeId}/${kind}-${uuid()}.${ext}`
  await storage().put(key, file.buffer, file.mimetype)
  return key
}
const link = async (key?: string | null) => (key ? storage().signedUrl(key, 300).catch(() => null) : null)
const audit = (req: any, action: string, entityId: string, newValue?: object) => AuditLog.create({ tenantId: req.user.tenantId, userId: req.user.userId, action, entityType: 'geomark', entityId, newValue })
async function tell(tenantId: string, employeeId: string, title: string, body: string) {
  const e: any = await Employee.findOne({ _id: employeeId, tenantId }).select('userId').lean()
  if (e?.userId) await Notification.create({ _id: uuid(), tenantId, userId: e.userId, type: 'geomark', title, body, link: '/attendance', read: false } as any)
}
const needEmployee = (req: any) => { if (!req.user.employeeId) throw new AppError('Only employees clock in', 403); return req.user.employeeId as string }

// ─── Settings ───
geomarkRouter.get('/settings', asyncHandler(async (req, res) => {
  const { tenantId, employeeId } = req.user!
  const s = await geomarkSettings(tenantId)
  const enrol: any = employeeId ? await col('geomark_enrolments').findOne({ tenantId, employeeId } as any) : null
  ok(res, { enabled: s.enabled, requireProof: s.requireProof, requireSelfie: s.requireSelfie, requireLocation: s.requireLocation, maxAccuracyMeters: s.maxAccuracyMeters, retentionDays: s.retentionDays, enrolment: enrol ? { status: enrol.status, note: enrol.note ?? null } : null, storageReady: storageConfigured() })
}))
geomarkRouter.put('/settings', validate(z.object({ body: z.object({ enabled: z.boolean(), requireProof: z.boolean(), requireSelfie: z.boolean(), requireLocation: z.boolean(), maxAccuracyMeters: z.number().int().min(10).max(2000), retentionDays: z.number().int().min(7).max(730) }).strict() })), asyncHandler(async (req, res) => {
  if (!isHR(req.user!.roleIds)) throw new AppError('Only HR can change this', 403)
  const b = req.body
  await col('geomark_settings').updateOne({ _id: req.user!.tenantId } as any, { $set: { ...b, updatedBy: req.user!.userId, updatedAt: new Date() } }, { upsert: true })
  await audit(req, 'GEOMARK_SETTINGS', req.user!.tenantId, b)
  ok(res, b)
}))

// ─── Reference photo ───
geomarkRouter.post('/enrol', accept(memory.single('selfie')), asyncHandler(async (req, res) => {
  const employeeId = needEmployee(req)
  const { tenantId } = req.user!
  if (req.body?.consent !== 'true') throw new AppError('Your photo is biometric data: you must agree to its use before it is saved', 400)
  const key = await putPhoto(tenantId, employeeId, 'ref', (req as any).file)
  const old: any = await col('geomark_enrolments').findOne({ tenantId, employeeId } as any)
  await col('geomark_enrolments').updateOne({ tenantId, employeeId } as any, { $set: { tenantId, employeeId, photoKey: key, status: 'pending', consentAt: new Date(), note: null, updatedAt: new Date() }, $setOnInsert: { _id: uuid() } }, { upsert: true })
  if (old?.photoKey) await storage().remove(old.photoKey).catch(() => undefined)
  const hr: any[] = await mongoose.connection.collection('users').find({ tenantId, active: true, 'userRoles.roleName': 'hr_admin' } as any).project({ _id: 1 }).toArray()
  if (hr.length) await Notification.insertMany(hr.map((u) => ({ _id: uuid(), tenantId, userId: u._id, type: 'geomark.enrolment', title: 'A face photo needs your approval', body: 'Check that it is the right person.', link: '/geomark', read: false })) as any)
  ok(res, { status: 'pending' }, 201)
}))
// Erase my own photo (and with it the ability to be matched)
geomarkRouter.delete('/enrol', asyncHandler(async (req, res) => {
  const employeeId = needEmployee(req)
  const e: any = await col('geomark_enrolments').findOne({ tenantId: req.user!.tenantId, employeeId } as any)
  if (e?.photoKey) await storage().remove(e.photoKey).catch(() => undefined)
  await col('geomark_enrolments').deleteOne({ tenantId: req.user!.tenantId, employeeId } as any)
  ok(res, { erased: true })
}))
geomarkRouter.get('/enrolments', asyncHandler(async (req, res) => {
  if (!isHR(req.user!.roleIds)) throw new AppError('Only HR can see these', 403)
  const rows: any[] = await col('geomark_enrolments').find({ tenantId: req.user!.tenantId, status: String(req.query.status ?? 'pending') } as any).sort({ updatedAt: 1 }).limit(100).toArray()
  const nm = new Map(((await Employee.find({ _id: { $in: rows.map((r) => r.employeeId) } }).select('firstName lastName employeeCode').lean()) as any[]).map((e) => [e._id, `${e.firstName} ${e.lastName} (${e.employeeCode})`]))
  ok(res, await Promise.all(rows.map(async (r) => ({ id: r._id, employee: nm.get(r.employeeId) ?? null, status: r.status, photoUrl: await link(r.photoKey), at: r.updatedAt }))))
}))
geomarkRouter.post('/enrolments/:id/decision', validate(z.object({ params: idp, body: z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }).strict() })), asyncHandler(async (req, res) => {
  if (!isHR(req.user!.roleIds)) throw new AppError('Only HR can decide', 403)
  const e: any = await col('geomark_enrolments').findOne({ _id: req.params.id, tenantId: req.user!.tenantId } as any)
  if (!e) throw new AppError('Enrolment not found', 404)
  if (!req.body.approve && !req.body.note) throw new AppError('Say why the photo was not accepted', 400)
  await col('geomark_enrolments').updateOne({ _id: e._id } as any, { $set: { status: req.body.approve ? 'approved' : 'rejected', note: req.body.note ?? null, decidedBy: req.user!.userId, decidedAt: new Date() } })
  await audit(req, req.body.approve ? 'GEOMARK_ENROLMENT_APPROVED' : 'GEOMARK_ENROLMENT_REJECTED', e._id)
  await tell(req.user!.tenantId, e.employeeId, req.body.approve ? 'Your face photo is approved' : 'Your face photo was not accepted', req.body.note ?? 'You can clock in with a selfie now.')
  ok(res, { status: req.body.approve ? 'approved' : 'rejected' })
}))

// ─── Clock in or out with proof ───
const Punch = z.object({ type: z.enum(['in', 'out']), latitude: z.coerce.number().min(-90).max(90).optional(), longitude: z.coerce.number().min(-180).max(180).optional(), accuracy: z.coerce.number().min(0).max(100000).optional() })
geomarkRouter.post('/punch', accept(memory.single('selfie')), asyncHandler(async (req, res) => {
  const employeeId = needEmployee(req)
  const { tenantId } = req.user!
  const s = await geomarkSettings(tenantId)
  if (!s.enabled) throw new AppError('Check-in with proof is not switched on', 400)
  const b = Punch.parse(req.body)
  const file = (req as any).file
  const hasLoc = b.latitude != null && b.longitude != null
  if (s.requireLocation && !hasLoc) throw new AppError('Share your location to clock in', 400)
  if (s.requireSelfie && !file) throw new AppError('Take a selfie to clock in', 400)
  const flags: string[] = []
  // Location: against the office fences (the person's own location first)
  let locationId: string | undefined, distance: number | null = null, within: boolean | null = null
  if (hasLoc) {
    const emp: any = await Employee.findOne({ _id: employeeId, tenantId }).select('workLocationId').lean()
    const fenced: any[] = await col('work_locations').find({ tenantId, active: { $ne: false }, latitude: { $ne: null }, longitude: { $ne: null }, geoFenceRadiusMeters: { $gt: 0 } } as any).toArray()
    if (fenced.length) {
      const ranked = fenced.map((l) => ({ l, d: metres(b.latitude!, b.longitude!, l.latitude, l.longitude) })).sort((x, y) => x.d - y.d)
      const mine = ranked.find((r) => r.l._id === emp?.workLocationId) ?? ranked[0]
      distance = Math.round(mine.d); within = mine.d <= mine.l.geoFenceRadiusMeters
      if (within) locationId = mine.l._id; else flags.push('outside_fence')
    }
    if (b.accuracy != null && b.accuracy > s.maxAccuracyMeters) flags.push('low_accuracy')
  }
  // Face: against the approved reference, when an outside service is plugged in
  let faceMatch: number | null = null
  const enrol: any = await col('geomark_enrolments').findOne({ tenantId, employeeId, status: 'approved' } as any)
  if (file && enrol?.photoKey && process.env.GEOMARK_FACE_PROVIDER) { faceMatch = await faceScore(Buffer.alloc(0), file.buffer); if (faceMatch != null && faceMatch < 0.8) flags.push('face_mismatch') }
  const photoKey = file ? await putPhoto(tenantId, employeeId, 'proof', file) : null
  // The clock-in itself: the same rules as the plain button (policy, locks, double punches)
  const data: any = { latitude: b.latitude, longitude: b.longitude, method: 'mobile', ...(locationId && { locationId }) }
  let record: any
  try { record = b.type === 'in' ? await attendanceService.clockIn(employeeId, tenantId, data) : await attendanceService.clockOut(employeeId, tenantId, data) } catch (e) { if (photoKey) await storage().remove(photoKey).catch(() => undefined); throw e }
  const check = { _id: uuid(), tenantId, employeeId, kind: b.type, photoKey, latitude: b.latitude ?? null, longitude: b.longitude ?? null, accuracy: b.accuracy ?? null, locationId: locationId ?? null, distance, withinFence: within, faceMatch, flags, status: flags.length ? 'flagged' : 'verified', at: new Date(), attendanceRecordId: record?.id ?? null }
  await col('geomark_checks').insertOne(check as any)
  if (flags.length) {
    const emp: any = await Employee.findOne({ _id: employeeId, tenantId }).select('managerId firstName lastName').lean()
    const mgr: any = emp?.managerId ? await Employee.findOne({ _id: emp.managerId, tenantId }).select('userId').lean() : null
    if (mgr?.userId) await Notification.create({ _id: uuid(), tenantId, userId: mgr.userId, type: 'geomark.flagged', title: `${emp.firstName} ${emp.lastName}'s clock-in needs a look`, body: flags.map(label).join(', '), link: '/geomark', read: false } as any)
  }
  ok(res, { status: check.status, flags, distance, withinFence: within, record }, 201)
}))
const label = (f: string) => ({ outside_fence: 'outside the office area', low_accuracy: 'location not precise', face_mismatch: 'face did not match' } as any)[f] ?? f

// ─── Review: flagged proofs first, any recent proof for a spot check ───
async function teamIds(req: any): Promise<string[] | null> {
  if (isHR(req.user.roleIds)) return null
  if (!req.user.employeeId || !req.user.roleIds.includes('manager')) throw new AppError('Only managers and HR review proofs', 403)
  return getReportingSubtreeIds(req.user.employeeId, req.user.tenantId)
}
geomarkRouter.get('/checks', validate(z.object({ query: z.object({ status: z.enum(['flagged', 'verified', 'approved', 'rejected', 'all']).default('flagged') }) })), asyncHandler(async (req, res) => {
  const team = await teamIds(req)
  const where: any = { tenantId: req.user!.tenantId, ...(req.query.status !== 'all' && { status: req.query.status }), ...(team && { employeeId: { $in: team } }) }
  const rows: any[] = await col('geomark_checks').find(where).sort({ at: -1 }).limit(60).toArray()
  const nm = new Map(((await Employee.find({ _id: { $in: rows.map((r) => r.employeeId) } }).select('firstName lastName employeeCode').lean()) as any[]).map((e) => [e._id, `${e.firstName} ${e.lastName} (${e.employeeCode})`]))
  const refs: any[] = await col('geomark_enrolments').find({ tenantId: req.user!.tenantId, employeeId: { $in: rows.map((r) => r.employeeId) }, status: 'approved' } as any).toArray()
  const refBy = new Map(refs.map((r) => [r.employeeId, r.photoKey]))
  ok(res, await Promise.all(rows.map(async (r) => ({ id: r._id, employee: nm.get(r.employeeId) ?? null, kind: r.kind, at: r.at, status: r.status, flags: r.flags, distance: r.distance, withinFence: r.withinFence, accuracy: r.accuracy, latitude: r.latitude, longitude: r.longitude, note: r.note ?? null, photoUrl: await link(r.photoKey), referenceUrl: await link(refBy.get(r.employeeId)) }))))
}))
geomarkRouter.post('/checks/:id/decision', validate(z.object({ params: idp, body: z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }).strict() })), asyncHandler(async (req, res) => {
  const team = await teamIds(req)
  const c: any = await col('geomark_checks').findOne({ _id: req.params.id, tenantId: req.user!.tenantId, ...(team && { employeeId: { $in: team } }) } as any)
  if (!c) throw new AppError('Proof not found', 404)
  if (c.employeeId === req.user!.employeeId) throw new AppError('You cannot review your own clock-in', 403)
  if (!req.body.approve && !req.body.note) throw new AppError('Say what was wrong', 400)
  await col('geomark_checks').updateOne({ _id: c._id } as any, { $set: { status: req.body.approve ? 'approved' : 'rejected', note: req.body.note ?? null, decidedBy: req.user!.userId, decidedAt: new Date() } })
  await audit(req, req.body.approve ? 'GEOMARK_CHECK_APPROVED' : 'GEOMARK_CHECK_REJECTED', c._id, { employeeId: c.employeeId })
  if (!req.body.approve) await tell(req.user!.tenantId, c.employeeId, 'A clock-in was not accepted', `${req.body.note} Raise a regularisation if your time is wrong.`)
  ok(res, { status: req.body.approve ? 'approved' : 'rejected' })
}))

// Deletes proof photos past each company's retention period (run daily by the geomark-purge job)
export async function purgeGeomark(only?: string) {
  const all: any[] = await col('geomark_settings').find(only ? { _id: only } : {} as any).toArray()
  let removed = 0
  for (const s of all) {
    const cutoff = new Date(Date.now() - (s.retentionDays ?? DEFAULTS.retentionDays) * 86400000)
    const old: any[] = await col('geomark_checks').find({ tenantId: s._id, at: { $lt: cutoff }, photoKey: { $ne: null } } as any).limit(2000).toArray()
    for (const c of old) { await storage().remove(c.photoKey).catch(() => undefined); await col('geomark_checks').updateOne({ _id: c._id } as any, { $set: { photoKey: null, photoDeletedAt: new Date() } }); removed++ }
  }
  return removed
}

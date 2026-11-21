import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { requireFeature } from '../../middleware/module.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { storage } from '../../infrastructure/storage/storage'
import { Employee, User, Role, RefreshToken, AuditLog, AlumniAccess, AlumniLetter, Notification, OrgUnit, JobPosition } from '../../infrastructure/mongo/mongo'

// Alumni portal (MongoDB mode only). After someone leaves, HR can keep a restricted login for them: they see their own record,
// download the documents HR filed for them (experience letter, relieving letter, payslips HR shared) and ask for new letters.
// Their account has the single role `alumni`: it carries no permission in the rest of the API, so nothing else opens.
export const alumniRouter = Router()
alumniRouter.use(authenticate, requireFeature('alumni'))

const STAFF = ['hr_admin', 'system_admin']
const isStaff = (roleIds: string[]) => roleIds.some((r) => STAFF.includes(r))
const isAlumni = (roleIds: string[]) => roleIds.length === 1 && roleIds[0] === 'alumni'
const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }
const staffOnly = (req: any) => { if (!isStaff(req.user.roleIds)) throw new AppError('Only HR can do this', 403) }
const alumniOnly = (req: any) => { if (!isAlumni(req.user.roleIds)) throw new AppError('This is for former employees', 403) }
const ymd = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null)
const randomPassword = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const body = Array.from(crypto.randomBytes(14), (b) => alphabet[b % alphabet.length]).join('')
  return body.slice(0, 4) + '-' + body.slice(4, 9) + '-' + body.slice(9) + '7'
}
const LETTER_TYPES = ['experience', 'relieving', 'salary_certificate', 'other'] as const
const empId = z.object({ employeeId: z.string().uuid() })
const idp = z.object({ id: z.string().uuid() })

// ─── HR ───
// Everyone who has left, with whether their alumni login is on
alumniRouter.get('/', asyncHandler(async (req, res) => {
  staffOnly(req)
  const { tenantId } = req.user!
  const left: any[] = await Employee.find({ tenantId, employmentStatus: 'terminated' }).sort({ lastName: 1, firstName: 1 }).limit(500).lean()
  const access: any[] = await AlumniAccess.find({ tenantId }).lean()
  const byEmp = new Map(access.map((a) => [a.employeeId, a]))
  const exits: any[] = await mongoose.connection.collection('employee_exits').find({ tenantId, employeeId: { $in: left.map((e) => e._id) } } as any).toArray()
  const exitBy = new Map(exits.map((x) => [x.employeeId, x]))
  const pending = await AlumniLetter.countDocuments({ tenantId, status: 'requested' })
  res.json({ success: true, data: { pendingLetters: pending, alumni: left.map((e) => {
    const a = byEmp.get(e._id), x = exitBy.get(e._id)
    return { employeeId: e._id, code: e.employeeCode, name: `${e.firstName} ${e.lastName}`, email: e.workEmail ?? null, lastWorkingDate: ymd(x?.lastWorkingDate ?? e.exitDate ?? e.archivedAt), access: a?.active ? 'enabled' : a ? 'disabled' : 'none', enabledAt: a?.enabledAt ?? null }
  }) } })
}))

alumniRouter.post('/:employeeId/enable', validate(z.object({ params: empId })), asyncHandler(async (req, res) => {
  staffOnly(req)
  const { tenantId, userId } = req.user!
  const emp: any = await Employee.findOne({ _id: req.params.employeeId, tenantId }).lean()
  if (!emp) throw new AppError('Employee not found', 404)
  if (emp.employmentStatus !== 'terminated') throw new AppError('Alumni access is for people who have left', 400)
  if (!emp.userId) throw new AppError('This person has no account', 400)
  const role: any = await Role.findOneAndUpdate({ tenantId, name: 'alumni' }, { $setOnInsert: { _id: crypto.randomUUID(), tenantId, name: 'alumni', description: 'Former employee with read-only access to their own letters and records', isSystemRole: true } }, { upsert: true, returnDocument: 'after' }).lean()
  const password = randomPassword()
  await User.updateOne({ _id: emp.userId, tenantId }, { $set: { active: true, userRoles: [{ _id: crypto.randomUUID(), roleId: role._id, roleName: 'alumni', scopeType: 'org', validFrom: new Date(), delegatedBy: userId, createdAt: new Date() }], passwordHash: await bcrypt.hash(password, 12), mustChangePassword: true, mfaEnabled: false } })
  await RefreshToken.updateMany({ userId: emp.userId, revokedAt: null }, { revokedAt: new Date() })
  await AlumniAccess.updateOne({ tenantId, employeeId: emp._id }, { $set: { tenantId, employeeId: emp._id, userId: emp.userId, active: true, enabledBy: userId, enabledAt: new Date() }, $unset: { disabledAt: 1 } }, { upsert: true })
  await AuditLog.create({ tenantId, userId, action: 'ALUMNI_ENABLED', entityType: 'employee', entityId: emp._id })
  // the temporary password is shown once, here
  res.json({ success: true, data: { email: (await User.findById(emp.userId).select('email').lean() as any)?.email, temporaryPassword: password } })
}))

alumniRouter.post('/:employeeId/disable', validate(z.object({ params: empId })), asyncHandler(async (req, res) => {
  staffOnly(req)
  const { tenantId, userId } = req.user!
  const a: any = await AlumniAccess.findOne({ tenantId, employeeId: req.params.employeeId }).lean()
  if (!a) throw new AppError('No alumni access to turn off', 404)
  await User.updateOne({ _id: a.userId, tenantId }, { $set: { active: false } })
  await RefreshToken.updateMany({ userId: a.userId, revokedAt: null }, { revokedAt: new Date() })
  await AlumniAccess.updateOne({ _id: a._id }, { $set: { active: false, disabledAt: new Date() } })
  await AuditLog.create({ tenantId, userId, action: 'ALUMNI_DISABLED', entityType: 'employee', entityId: a.employeeId })
  res.json({ success: true, data: { access: 'disabled' } })
}))

// Letter requests waiting for HR
alumniRouter.get('/letters', asyncHandler(async (req, res) => {
  const { tenantId, roleIds } = req.user!
  if (isAlumni(roleIds)) {
    const mine: any = await AlumniAccess.findOne({ tenantId, userId: req.user!.userId, active: true }).lean()
    if (!mine) throw new AppError('Access not found', 404)
    return res.json({ success: true, data: (await AlumniLetter.find({ tenantId, employeeId: mine.employeeId }).sort({ createdAt: -1 }).lean()).map(ser) })
  }
  staffOnly(req)
  const status = typeof req.query.status === 'string' ? req.query.status : undefined
  const rows: any[] = await AlumniLetter.find({ tenantId, ...(status && { status }) }).sort({ createdAt: -1 }).limit(300).lean()
  const emps = new Map(((await Employee.find({ _id: { $in: rows.map((r) => r.employeeId) } }).select('firstName lastName employeeCode').lean()) as any[]).map((e) => [e._id, e]))
  res.json({ success: true, data: rows.map((r) => ({ ...ser(r), employeeName: emps.get(r.employeeId) ? `${emps.get(r.employeeId).firstName} ${emps.get(r.employeeId).lastName}` : null, employeeCode: emps.get(r.employeeId)?.employeeCode })) })
}))

alumniRouter.post('/letters/:id/issue', validate(z.object({ params: idp, body: z.object({ documentId: z.string().uuid(), note: z.string().trim().max(300).optional() }).strict() })), asyncHandler(async (req, res) => {
  staffOnly(req)
  const { tenantId, userId } = req.user!
  const l: any = await AlumniLetter.findOne({ _id: req.params.id, tenantId }).lean()
  if (!l) throw new AppError('Request not found', 404)
  if (l.status !== 'requested') throw new AppError('This request was already answered', 409)
  // the letter must be a document on this person's record that they can see (upload it first under Documents, visible to the employee)
  const doc: any = await mongoose.connection.collection('employee_documents').findOne({ _id: req.body.documentId, tenantId, employeeId: l.employeeId, active: true, visibility: 'employee' } as any)
  if (!doc) throw new AppError('Upload the letter on their profile first (Documents, visible to the employee)', 400)
  await AlumniLetter.updateOne({ _id: l._id, status: 'requested' }, { $set: { status: 'issued', documentId: doc._id, decidedBy: userId, decidedAt: new Date(), response: req.body.note ?? null } })
  await notifyAlumni(tenantId, l, 'Your letter is ready', `Your ${label(l.type)} is ready to download.`)
  await AuditLog.create({ tenantId, userId, action: 'ALUMNI_LETTER_ISSUED', entityType: 'alumni_letter', entityId: l._id })
  res.json({ success: true, data: { status: 'issued' } })
}))

alumniRouter.post('/letters/:id/decline', validate(z.object({ params: idp, body: z.object({ note: z.string().trim().min(3).max(300) }).strict() })), asyncHandler(async (req, res) => {
  staffOnly(req)
  const { tenantId, userId } = req.user!
  const l: any = await AlumniLetter.findOne({ _id: req.params.id, tenantId }).lean()
  if (!l) throw new AppError('Request not found', 404)
  if (l.status !== 'requested') throw new AppError('This request was already answered', 409)
  await AlumniLetter.updateOne({ _id: l._id, status: 'requested' }, { $set: { status: 'declined', decidedBy: userId, decidedAt: new Date(), response: req.body.note } })
  await notifyAlumni(tenantId, l, 'About your letter request', req.body.note)
  res.json({ success: true, data: { status: 'declined' } })
}))

// ─── The former employee ───
async function mine(req: any) {
  alumniOnly(req)
  const a: any = await AlumniAccess.findOne({ tenantId: req.user.tenantId, userId: req.user.userId, active: true }).lean()
  if (!a) throw new AppError('Your access has ended', 403)
  return a
}
const label = (t: string) => ({ experience: 'experience letter', relieving: 'relieving letter', salary_certificate: 'salary certificate', other: 'letter' } as any)[t] ?? 'letter'
async function notifyAlumni(tenantId: string, l: any, title: string, body: string) {
  const a: any = await AlumniAccess.findOne({ tenantId, employeeId: l.employeeId }).lean()
  if (a?.userId) await Notification.create({ _id: crypto.randomUUID(), tenantId, userId: a.userId, type: 'alumni.letter', title, body, link: '/alumni', read: false } as any)
}

alumniRouter.get('/me', asyncHandler(async (req, res) => {
  const a = await mine(req)
  const e: any = await Employee.findOne({ _id: a.employeeId, tenantId: a.tenantId }).lean()
  const [unit, pos, exit]: any[] = await Promise.all([e.orgUnitId ? OrgUnit.findById(e.orgUnitId).select('name').lean() : null, e.jobPositionId ? JobPosition.findById(e.jobPositionId).select('title').lean() : null,
    mongoose.connection.collection('employee_exits').findOne({ tenantId: a.tenantId, employeeId: e._id } as any)])
  res.json({ success: true, data: { name: `${e.firstName} ${e.lastName}`, code: e.employeeCode, hireDate: ymd(e.hireDate), lastWorkingDate: ymd(exit?.lastWorkingDate ?? e.archivedAt), department: unit?.name ?? null, position: pos?.title ?? null, contact: a.contact ?? {} } })
}))

alumniRouter.patch('/me/contact', validate(z.object({ body: z.object({ email: z.string().email().max(120).optional(), phone: z.string().trim().max(30).optional() }).strict() })), asyncHandler(async (req, res) => {
  const a = await mine(req)
  await AlumniAccess.updateOne({ _id: a._id }, { $set: { contact: { ...(a.contact ?? {}), ...req.body } } })
  res.json({ success: true, data: { ...(a.contact ?? {}), ...req.body } })
}))

alumniRouter.get('/me/documents', asyncHandler(async (req, res) => {
  const a = await mine(req)
  const docs: any[] = await mongoose.connection.collection('employee_documents').find({ tenantId: a.tenantId, employeeId: a.employeeId, active: true, visibility: 'employee' } as any).sort({ createdAt: -1 }).toArray()
  res.json({ success: true, data: docs.map((d) => ({ id: d._id, category: d.category, title: d.title, fileName: d.fileName, size: d.size, createdAt: d.createdAt })) })
}))

alumniRouter.get('/me/documents/:id/download', validate(z.object({ params: idp })), asyncHandler(async (req, res) => {
  const a = await mine(req)
  const d: any = await mongoose.connection.collection('employee_documents').findOne({ _id: req.params.id, tenantId: a.tenantId, employeeId: a.employeeId, active: true, visibility: 'employee' } as any)
  if (!d) throw new AppError('Document not found', 404)
  const url = await storage().signedUrl(d.fileKey, 60, d.fileName)
  await AuditLog.create({ tenantId: a.tenantId, userId: req.user!.userId, action: 'DOCUMENT_DOWNLOADED', entityType: 'employee', entityId: a.employeeId, newValue: { documentId: d._id, via: 'alumni' } })
  res.json({ success: true, data: { url, expiresInSeconds: 60 } })
}))

alumniRouter.post('/me/letters', validate(z.object({ body: z.object({ type: z.enum(LETTER_TYPES), note: z.string().trim().max(500).optional() }).strict() })), asyncHandler(async (req, res) => {
  const a = await mine(req)
  if (await AlumniLetter.countDocuments({ tenantId: a.tenantId, employeeId: a.employeeId, type: req.body.type, status: 'requested' })) throw new AppError('You already asked for this and it is waiting for HR', 409)
  const l: any = await AlumniLetter.create({ _id: crypto.randomUUID(), tenantId: a.tenantId, employeeId: a.employeeId, userId: a.userId, type: req.body.type, note: req.body.note ?? null, status: 'requested' } as any)
  const hr: any[] = await User.find({ tenantId: a.tenantId, active: true, 'userRoles.roleName': 'hr_admin' }).select('_id').lean()
  if (hr.length) await Notification.insertMany(hr.map((u) => ({ _id: crypto.randomUUID(), tenantId: a.tenantId, userId: u._id, type: 'alumni.letter_requested', title: 'A former employee asked for a letter', body: `${label(req.body.type)} requested`, link: '/alumni', read: false })) as any)
  res.status(201).json({ success: true, data: ser(l.toObject()) })
}))

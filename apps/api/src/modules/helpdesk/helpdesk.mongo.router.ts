import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { requireFeature } from '../../middleware/module.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { Counter, HelpdeskCategory, HelpdeskTicket, AuditLog, Employee, User } from '../../infrastructure/mongo/mongo'

// Helpdesk: employees raise queries to HR; HR works them with owners and a response target. MongoDB mode only.
// People see their own tickets; HR admins and system admins see and work all of them. Internal notes never reach the requester.
// ponytail: no email or bell notification yet (events are not wired on the Mongo API); the list is the signal.
export const helpdeskRouter = Router()
helpdeskRouter.use(authenticate, requireFeature('helpdesk'))

const STAFF = ['hr_admin', 'system_admin']
const isStaff = (roleIds: string[]) => roleIds.some((r) => STAFF.includes(r))
const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }
const DEFAULT_CATEGORIES = [
  { name: 'Payroll and payslips', responseHours: 24 }, { name: 'Leave', responseHours: 24 }, { name: 'Attendance', responseHours: 24 },
  { name: 'Documents and letters', responseHours: 48 }, { name: 'Policies', responseHours: 72 }, { name: 'IT and assets', responseHours: 48 }, { name: 'Other', responseHours: 72 },
]
async function categories(tenantId: string) {
  let rows: any[] = await HelpdeskCategory.find({ tenantId }).sort({ name: 1 }).lean()
  if (!rows.length) {
    await HelpdeskCategory.insertMany(DEFAULT_CATEGORIES.map((c) => ({ ...c, tenantId, active: true })), { ordered: false }).catch(() => undefined)
    rows = await HelpdeskCategory.find({ tenantId }).sort({ name: 1 }).lean()
  }
  return rows
}
async function nextNumber(tenantId: string) {
  const c: any = await Counter.findOneAndUpdate({ _id: `helpdesk:${tenantId}` as any }, { $inc: { n: 1 } }, { upsert: true, returnDocument: 'after' }).lean()
  return `HD-${String(c.n).padStart(4, '0')}`
}
const view = (t: any, staff: boolean) => {
  const out = ser(t)
  if (!staff) out.comments = (out.comments ?? []).filter((c: any) => !c.internal)
  return out
}
// A ticket is visible to its requester, its assignee and staff; anyone else gets a 404
async function load(req: any, id: string) {
  const { tenantId, userId, roleIds } = req.user
  const t: any = await HelpdeskTicket.findOne({ _id: id, tenantId }).lean()
  if (!t || !(isStaff(roleIds) || t.requesterUserId === userId || t.assigneeUserId === userId)) throw new AppError('Ticket not found', 404)
  return t
}
const idp = z.object({ id: z.string().uuid() })

helpdeskRouter.get('/categories', asyncHandler(async (req, res) => { res.json({ success: true, data: (await categories(req.user!.tenantId)).filter((c) => c.active !== false).map(ser) }) }))
helpdeskRouter.post('/categories', requireRoles(...STAFF), validate(z.object({ body: z.object({ name: z.string().trim().min(2).max(60), responseHours: z.number().int().min(1).max(720) }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const c: any = await HelpdeskCategory.create({ ...req.body, tenantId, active: true }).catch((e) => { throw e?.code === 11000 ? new AppError('That category exists', 409) : e })
  await AuditLog.create({ tenantId, userId, action: 'HELPDESK_CATEGORY_CREATED', entityType: 'helpdesk_category', entityId: c._id, newValue: req.body })
  res.status(201).json({ success: true, data: ser(c.toObject()) })
}))

const NewTicket = z.object({ categoryId: z.string().uuid(), subject: z.string().trim().min(3).max(140), description: z.string().trim().min(3).max(4000), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal') }).strict()
helpdeskRouter.post('/tickets', validate(z.object({ body: NewTicket })), asyncHandler(async (req, res) => {
  const { tenantId, userId, employeeId } = req.user!
  await categories(tenantId)
  const cat: any = await HelpdeskCategory.findOne({ _id: req.body.categoryId, tenantId, active: { $ne: false } }).lean()
  if (!cat) throw new AppError('Category not found', 404)
  const number = await nextNumber(tenantId)
  const t: any = await HelpdeskTicket.create({ ...req.body, tenantId, number, categoryName: cat.name, status: 'open', requesterUserId: userId, requesterEmployeeId: employeeId ?? null, assigneeUserId: null, dueAt: new Date(Date.now() + cat.responseHours * 3600_000), comments: [] })
  await AuditLog.create({ tenantId, userId, action: 'HELPDESK_TICKET_CREATED', entityType: 'helpdesk_ticket', entityId: t._id, newValue: { number, categoryId: cat._id } })
  res.status(201).json({ success: true, data: view(t.toObject(), false) })
}))

helpdeskRouter.get('/tickets', asyncHandler(async (req, res) => {
  const { tenantId, userId, roleIds } = req.user!
  const staff = isStaff(roleIds)
  const q: any = { tenantId }
  if (!(staff && req.query.scope === 'all')) q.$or = [{ requesterUserId: userId }, { assigneeUserId: userId }]
  if (typeof req.query.status === 'string' && req.query.status) q.status = req.query.status
  const rows: any[] = await HelpdeskTicket.find(q).sort({ createdAt: -1 }).limit(200).select('-comments').lean()
  const names = new Map<string, string>()
  if (staff) for (const e of (await Employee.find({ tenantId, userId: { $in: [...new Set(rows.map((r) => r.requesterUserId))] } }).select('userId firstName lastName').lean()) as any[]) names.set(e.userId, `${e.firstName} ${e.lastName}`)
  const now = Date.now()
  res.json({ success: true, data: rows.map((r) => ({ ...ser(r), requesterName: names.get(r.requesterUserId) ?? null, overdue: !['resolved', 'closed'].includes(r.status) && !!r.dueAt && new Date(r.dueAt).getTime() < now })) })
}))

helpdeskRouter.get('/tickets/:id', validate(z.object({ params: idp })), asyncHandler(async (req, res) => {
  const t = await load(req, String(req.params.id))
  const staff = isStaff(req.user!.roleIds)
  const out: any = view(t, staff)
  if (staff) { const e: any = await Employee.findOne({ tenantId: req.user!.tenantId, userId: t.requesterUserId }).select('firstName lastName').lean(); out.requesterName = e ? `${e.firstName} ${e.lastName}` : null }
  res.json({ success: true, data: out })
}))

helpdeskRouter.post('/tickets/:id/comments', validate(z.object({ params: idp, body: z.object({ body: z.string().trim().min(1).max(4000), internal: z.boolean().default(false) }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId, roleIds } = req.user!
  const t = await load(req, String(req.params.id))
  const staff = isStaff(roleIds)
  if (req.body.internal && !staff) throw new AppError('Only HR can add internal notes', 403)
  if (t.status === 'closed') throw new AppError('This ticket is closed. Reopen it first.', 409)
  const u: any = await User.findOne({ _id: userId, tenantId }).select('email').lean()
  const e: any = await Employee.findOne({ tenantId, userId }).select('firstName lastName').lean()
  const c = { id: crypto.randomUUID(), userId, name: e ? `${e.firstName} ${e.lastName}` : (u?.email ?? 'User'), body: req.body.body, internal: req.body.internal, at: new Date() }
  // an HR reply moves an open ticket on; the requester replying to a waiting ticket puts it back in progress
  const status = staff && t.status === 'open' && !req.body.internal ? 'in_progress' : (!staff && t.status === 'waiting' ? 'in_progress' : t.status)
  const r: any = await HelpdeskTicket.findOneAndUpdate({ _id: t._id, tenantId }, { $push: { comments: c }, $set: { status } }, { returnDocument: 'after' }).lean()
  res.status(201).json({ success: true, data: view(r, staff) })
}))

// HR sets owner, priority and status; the requester can only close or reopen their own ticket
helpdeskRouter.patch('/tickets/:id', validate(z.object({ params: idp, body: z.object({ status: z.enum(['open', 'in_progress', 'waiting', 'resolved', 'closed']).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), assigneeUserId: z.string().uuid().nullable().optional() }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId, roleIds } = req.user!
  const t = await load(req, String(req.params.id))
  const staff = isStaff(roleIds)
  if (!staff) {
    if (t.requesterUserId !== userId || req.body.priority !== undefined || req.body.assigneeUserId !== undefined) throw new AppError('Only HR can change that', 403)
    if (req.body.status && !['closed', 'open'].includes(req.body.status)) throw new AppError('You can close or reopen your own ticket', 403)
  }
  if (req.body.assigneeUserId) {
    const a: any = await User.findOne({ _id: req.body.assigneeUserId, tenantId }).select('userRoles').lean()
    if (!a || !(a.userRoles ?? []).some((r: any) => STAFF.includes(r.roleName))) throw new AppError('Assign to an HR or system admin of your company', 400)
  }
  const set: any = { ...req.body }
  if (req.body.status === 'resolved') set.resolvedAt = new Date()
  if (req.body.status === 'open') set.resolvedAt = null
  const r: any = await HelpdeskTicket.findOneAndUpdate({ _id: t._id, tenantId }, { $set: set }, { returnDocument: 'after' }).lean()
  await AuditLog.create({ tenantId, userId, action: 'HELPDESK_TICKET_UPDATED', entityType: 'helpdesk_ticket', entityId: t._id, newValue: req.body })
  res.json({ success: true, data: view(r, staff) })
}))

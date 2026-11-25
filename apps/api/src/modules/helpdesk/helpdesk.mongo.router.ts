import { Router, RequestHandler } from 'express'
import multer from 'multer'
import { z } from 'zod'
import crypto from 'crypto'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { requireFeature } from '../../middleware/module.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { storage, storageConfigured } from '../../infrastructure/storage/storage'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { Counter, HelpdeskCategory, HelpdeskTicket, AuditLog, Employee, User } from '../../infrastructure/mongo/mongo'

// Helpdesk: employees raise queries to HR; HR works them with owners and a response target. MongoDB mode only.
// People see their own tickets; HR admins and system admins see and work all of them. Internal notes and internal files never reach the requester.
// The response clock: each category has a target in hours; priority scales it (urgent a quarter, high half, low double); it PAUSES while the ticket
// waits on the requester. A ticket that runs past its target is flagged overdue and HR is told once; a resolved ticket closes itself after 7 days.
export const helpdeskRouter = Router()
helpdeskRouter.use(authenticate, requireFeature('helpdesk'))

const STAFF = ['hr_admin', 'system_admin']
const isStaff = (roleIds: string[]) => roleIds.some((r) => STAFF.includes(r))
const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }
const AUTO_CLOSE_DAYS = 7
const MULT: Record<string, number> = { urgent: 0.25, high: 0.5, normal: 1, low: 2 }
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

// ─── The response clock ───
const dueFor = (created: Date, hours: number, priority: string, pausedMs: number) => new Date(new Date(created).getTime() + hours * 3_600_000 * (MULT[priority] ?? 1) + pausedMs)
const slaHoursOf = (t: any) => t.slaHours ?? (t.dueAt ? Math.max(1, Math.round((new Date(t.dueAt).getTime() - new Date(t.createdAt).getTime()) / 3_600_000)) : null)
// What to $set when a ticket's status or priority changes: pausing while it waits, moving the target by the time it waited, reopening
export function patchFor(t: any, next: { status?: string; priority?: string }) {
  const status = next.status ?? t.status, priority = next.priority ?? t.priority
  const set: any = {}
  let paused: number = t.pausedMs ?? 0, waitingSince: Date | null = t.waitingSince ?? null
  if (status !== t.status) {
    if (status === 'waiting') waitingSince = new Date()
    else if (t.status === 'waiting' && waitingSince) { paused += Date.now() - new Date(waitingSince).getTime(); waitingSince = null }
    if (status === 'resolved') set.resolvedAt = new Date()
    if (status === 'open' || status === 'in_progress') { set.resolvedAt = null; set.closedAt = null }
    if (status === 'closed') set.closedAt = new Date()
    set.status = status
  }
  set.pausedMs = paused; set.waitingSince = waitingSince
  const hours = slaHoursOf(t)
  if (hours) { set.dueAt = dueFor(t.createdAt, hours, priority, paused); set.slaHours = hours }
  if (next.priority) set.priority = next.priority
  return set
}
const isOverdue = (t: any, now = Date.now()) => !['resolved', 'closed', 'waiting'].includes(t.status) && !!t.dueAt && new Date(t.dueAt).getTime() < now

// ─── Who is told what ───
const staffUserIds = async (tenantId: string) => [...new Set([...(await userIdsWithRole(tenantId, 'hr_admin')), ...(await userIdsWithRole(tenantId, 'system_admin'))])]
const tell = async (t: any, userIds: (string | null | undefined)[], type: string, title: string, body: string) => {
  try { await notify({ tenantId: t.tenantId, userIds: userIds.filter(Boolean) as string[], type, title, body, link: `/helpdesk?ticket=${t._id}`, entityType: 'helpdesk_ticket', entityId: t._id }) } catch { /* best effort */ }
}

const view = (t: any, staff: boolean) => {
  const out = ser(t)
  if (!staff) { out.comments = (out.comments ?? []).filter((c: any) => !c.internal); out.attachments = (out.attachments ?? []).filter((a: any) => !a.internal) }
  out.attachments = (out.attachments ?? []).map(({ key: _key, ...a }: any) => a)
  out.overdue = isOverdue(t)
  return out
}
// A ticket is visible to its requester, its assignee and staff; anyone else gets a 404
async function load(req: any, id: string) {
  const { tenantId, userId, roleIds } = req.user
  const t: any = await HelpdeskTicket.findOne({ _id: id, tenantId }).lean()
  if (!t || !(isStaff(roleIds) || t.requesterUserId === userId || t.assigneeUserId === userId)) throw new AppError('Ticket not found', 404)
  return t
}
async function names(tenantId: string, userIds: (string | null | undefined)[]) {
  const ids = [...new Set(userIds.filter(Boolean) as string[])]
  const m = new Map<string, string>()
  if (!ids.length) return m
  for (const e of (await Employee.find({ tenantId, userId: { $in: ids } }).select('userId firstName lastName').lean()) as any[]) m.set(e.userId, `${e.firstName} ${e.lastName}`)
  for (const u of (await User.find({ tenantId, _id: { $in: ids.filter((i) => !m.has(i)) } }).select('fullName email').lean()) as any[]) m.set(u._id, u.fullName || u.email)
  return m
}
const idp = z.object({ id: z.string().uuid() })

// ─── Categories ───
helpdeskRouter.get('/categories', asyncHandler(async (req, res) => {
  const all = isStaff(req.user!.roleIds) && req.query.all === '1'
  res.json({ success: true, data: (await categories(req.user!.tenantId)).filter((c) => all || c.active !== false).map(ser) })
}))
helpdeskRouter.post('/categories', requireRoles(...STAFF), validate(z.object({ body: z.object({ name: z.string().trim().min(2).max(60), responseHours: z.number().int().min(1).max(720) }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const c: any = await HelpdeskCategory.create({ ...req.body, tenantId, active: true }).catch((e) => { throw e?.code === 11000 ? new AppError('That category exists', 409) : e })
  await AuditLog.create({ tenantId, userId, action: 'HELPDESK_CATEGORY_CREATED', entityType: 'helpdesk_category', entityId: c._id, newValue: req.body })
  res.status(201).json({ success: true, data: ser(c.toObject()) })
}))
// Rename, change the target, or switch a category off (people can no longer pick it; tickets already raised keep it)
helpdeskRouter.patch('/categories/:id', requireRoles(...STAFF), validate(z.object({ params: idp, body: z.object({ name: z.string().trim().min(2).max(60).optional(), responseHours: z.number().int().min(1).max(720).optional(), active: z.boolean().optional() }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const c: any = await HelpdeskCategory.findOneAndUpdate({ _id: String(req.params.id), tenantId }, { $set: req.body }, { returnDocument: 'after' }).lean().catch((e: any) => { throw e?.code === 11000 ? new AppError('That category exists', 409) : e })
  if (!c) throw new AppError('Category not found', 404)
  await AuditLog.create({ tenantId, userId, action: 'HELPDESK_CATEGORY_UPDATED', entityType: 'helpdesk_category', entityId: c._id, newValue: req.body })
  res.json({ success: true, data: ser(c) })
}))
// HR people a ticket can be given to
helpdeskRouter.get('/staff', requireRoles(...STAFF), asyncHandler(async (req, res) => {
  const ids = await staffUserIds(req.user!.tenantId)
  const n = await names(req.user!.tenantId, ids)
  res.json({ success: true, data: ids.map((id) => ({ id, name: n.get(id) ?? 'HR' })).sort((a, b) => a.name.localeCompare(b.name)) })
}))

// ─── Tickets ───
const NewTicket = z.object({ categoryId: z.string().uuid(), subject: z.string().trim().min(3).max(140), description: z.string().trim().min(3).max(4000), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal') }).strict()
helpdeskRouter.post('/tickets', validate(z.object({ body: NewTicket })), asyncHandler(async (req, res) => {
  const { tenantId, userId, employeeId } = req.user!
  await categories(tenantId)
  const cat: any = await HelpdeskCategory.findOne({ _id: req.body.categoryId, tenantId, active: { $ne: false } }).lean()
  if (!cat) throw new AppError('Category not found', 404)
  const number = await nextNumber(tenantId)
  const now = new Date()
  const t: any = await HelpdeskTicket.create({ ...req.body, tenantId, number, categoryName: cat.name, status: 'open', requesterUserId: userId, requesterEmployeeId: employeeId ?? null, assigneeUserId: null, slaHours: cat.responseHours, pausedMs: 0, waitingSince: null, dueAt: dueFor(now, cat.responseHours, req.body.priority, 0), comments: [], attachments: [] })
  await AuditLog.create({ tenantId, userId, action: 'HELPDESK_TICKET_CREATED', entityType: 'helpdesk_ticket', entityId: t._id, newValue: { number, categoryId: cat._id } })
  const who = (await names(tenantId, [userId])).get(userId) ?? 'Someone'
  await tell(t, (await staffUserIds(tenantId)).filter((x) => x !== userId), 'helpdesk.new', `New ticket ${number}: ${req.body.subject}`, `${who} asked about ${cat.name.toLowerCase()}${req.body.priority !== 'normal' ? ` (${req.body.priority} priority)` : ''}.`)
  res.status(201).json({ success: true, data: view(t.toObject(), false) })
}))

const ListQuery = z.object({ query: z.object({
  scope: z.enum(['mine', 'all']).optional(), status: z.enum(['open', 'in_progress', 'waiting', 'resolved', 'closed', 'active']).optional(), categoryId: z.string().uuid().optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  assignee: z.string().max(64).optional(), overdue: z.enum(['1']).optional(), q: z.string().trim().max(80).optional(), page: z.coerce.number().int().min(1).max(500).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
}) })
helpdeskRouter.get('/tickets', validate(ListQuery), asyncHandler(async (req, res) => {
  const { tenantId, userId, roleIds } = req.user!
  const staff = isStaff(roleIds)
  const qs: any = req.query
  const base: any = { tenantId }
  if (!(staff && qs.scope === 'all')) base.$or = [{ requesterUserId: userId }, { assigneeUserId: userId }]
  const filt: any = { ...base }
  if (qs.status === 'active') filt.status = { $in: ['open', 'in_progress', 'waiting'] }; else if (qs.status) filt.status = qs.status
  if (qs.categoryId) { const c: any = await HelpdeskCategory.findOne({ _id: qs.categoryId, tenantId }).select('name').lean(); filt.categoryName = c?.name ?? '__none__' }
  if (qs.priority) filt.priority = qs.priority
  if (staff && qs.assignee) filt.assigneeUserId = qs.assignee === 'me' ? userId : qs.assignee === 'none' ? null : qs.assignee
  if (qs.overdue) { filt.status = { $in: ['open', 'in_progress'] }; filt.dueAt = { $lt: new Date() } }
  if (qs.q) { const rx = new RegExp(String(qs.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); filt.$and = [{ $or: [{ subject: rx }, { number: rx }, { description: rx }] }] }
  const page = Number(qs.page ?? 1), limit = Number(qs.limit ?? 25)
  const [rows, total, byStatus, overdueN]: any[] = await Promise.all([
    HelpdeskTicket.find(filt).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-comments -attachments').lean(),
    HelpdeskTicket.countDocuments(filt),
    HelpdeskTicket.aggregate([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    HelpdeskTicket.countDocuments({ ...base, status: { $in: ['open', 'in_progress'] }, dueAt: { $lt: new Date() } }),
  ])
  const nm = staff ? await names(tenantId, rows.flatMap((r: any) => [r.requesterUserId, r.assigneeUserId])) : new Map<string, string>()
  const counts: Record<string, number> = { open: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0 }
  for (const s of byStatus) counts[s._id] = s.n
  res.json({ success: true, data: {
    items: rows.map((r: any) => ({ ...ser(r), requesterName: nm.get(r.requesterUserId) ?? null, assigneeName: nm.get(r.assigneeUserId) ?? null, overdue: isOverdue(r) })),
    total, page, pages: Math.max(1, Math.ceil(total / limit)), counts: { ...counts, overdue: overdueN },
  } })
}))

helpdeskRouter.get('/tickets/:id', validate(z.object({ params: idp })), asyncHandler(async (req, res) => {
  const t = await load(req, String(req.params.id))
  const staff = isStaff(req.user!.roleIds)
  const out: any = view(t, staff)
  const nm = await names(req.user!.tenantId, [t.requesterUserId, t.assigneeUserId])
  out.requesterName = nm.get(t.requesterUserId) ?? null
  out.assigneeName = nm.get(t.assigneeUserId) ?? null
  res.json({ success: true, data: out })
}))

helpdeskRouter.post('/tickets/:id/comments', validate(z.object({ params: idp, body: z.object({ body: z.string().trim().min(1).max(4000), internal: z.boolean().default(false) }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId, roleIds } = req.user!
  const t = await load(req, String(req.params.id))
  const staff = isStaff(roleIds)
  if (req.body.internal && !staff) throw new AppError('Only HR can add internal notes', 403)
  if (t.status === 'closed') throw new AppError('This ticket is closed. Reopen it first.', 409)
  const who = (await names(tenantId, [userId])).get(userId) ?? 'User'
  const c = { id: crypto.randomUUID(), userId, name: who, body: req.body.body, internal: req.body.internal, at: new Date() }
  // an HR reply moves an open ticket on; the requester replying to a waiting ticket puts it back in progress (and the clock runs again)
  const next = staff && t.status === 'open' && !req.body.internal ? 'in_progress' : (!staff && t.status === 'waiting' ? 'in_progress' : t.status)
  const r: any = await HelpdeskTicket.findOneAndUpdate({ _id: t._id, tenantId }, { $push: { comments: c }, $set: next !== t.status ? patchFor(t, { status: next }) : {} }, { returnDocument: 'after' }).lean()
  if (!req.body.internal) {
    if (staff) await tell(r, [t.requesterUserId !== userId ? t.requesterUserId : null], 'helpdesk.reply', `${r.number}: ${who} replied`, req.body.body.slice(0, 160))
    else await tell(r, t.assigneeUserId ? [t.assigneeUserId] : (await staffUserIds(tenantId)).filter((x) => x !== userId), 'helpdesk.reply', `${r.number}: ${who} replied`, req.body.body.slice(0, 160))
  }
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
  const set: any = patchFor(t, { status: req.body.status, priority: req.body.priority })
  if (req.body.assigneeUserId !== undefined) set.assigneeUserId = req.body.assigneeUserId
  const r: any = await HelpdeskTicket.findOneAndUpdate({ _id: t._id, tenantId }, { $set: set }, { returnDocument: 'after' }).lean()
  await AuditLog.create({ tenantId, userId, action: 'HELPDESK_TICKET_UPDATED', entityType: 'helpdesk_ticket', entityId: t._id, newValue: req.body })
  const by = (await names(tenantId, [userId])).get(userId) ?? 'HR'
  if (req.body.status && req.body.status !== t.status && staff && t.requesterUserId !== userId) {
    const say: Record<string, string> = { resolved: 'was marked resolved', waiting: 'is waiting for your reply', closed: 'was closed', in_progress: 'is being worked on', open: 'was reopened' }
    await tell(r, [t.requesterUserId], 'helpdesk.status', `${r.number} ${say[req.body.status]}`, req.body.status === 'waiting' ? 'HR needs more from you. Open the ticket to reply.' : req.body.status === 'resolved' ? 'If it is not sorted, reply and it will reopen. It closes by itself after 7 days.' : r.subject)
  }
  if (req.body.status === 'open' && !staff && t.status !== 'open') await tell(r, t.assigneeUserId ? [t.assigneeUserId] : await staffUserIds(tenantId), 'helpdesk.status', `${r.number} was reopened`, `${by} reopened it.`)
  if (req.body.assigneeUserId && req.body.assigneeUserId !== t.assigneeUserId && req.body.assigneeUserId !== userId) await tell(r, [req.body.assigneeUserId], 'helpdesk.assigned', `${r.number} was assigned to you`, r.subject)
  res.json({ success: true, data: view(r, staff) })
}))

// ─── Files on a ticket (photos and PDFs, up to 5 MB each, 10 a ticket) ───
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }
const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } })
const accept = (mw: RequestHandler): RequestHandler => (req, res, next) => mw(req, res, (err: any) => { if (!err) return next(); next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 'A file can be up to 5 MB' : 'The file could not be read', 400)) })
helpdeskRouter.post('/tickets/:id/attachments', validate(z.object({ params: idp })), accept(memory.single('file')), asyncHandler(async (req, res) => {
  const { tenantId, userId, roleIds } = req.user!
  const t = await load(req, String(req.params.id))
  const staff = isStaff(roleIds)
  const file = (req as any).file as { buffer: Buffer; mimetype: string; originalname: string } | undefined
  if (!storageConfigured()) throw new AppError('File storage is not set up yet. Ask your administrator.', 503)
  if (!file) throw new AppError('Choose a file first', 400)
  const ext = TYPES[file.mimetype]
  if (!ext) throw new AppError('Use a JPEG, PNG, WebP or PDF file', 400)
  if (t.status === 'closed') throw new AppError('This ticket is closed. Reopen it first.', 409)
  if ((t.attachments ?? []).length >= 10) throw new AppError('A ticket can hold 10 files', 409)
  const internal = staff && req.body?.internal === 'true'
  const att = { id: crypto.randomUUID(), name: String(file.originalname).replace(/[^\w.\- ]/g, '_').slice(0, 80), type: file.mimetype, size: file.buffer.length, key: `helpdesk/${tenantId}/${t._id}/${crypto.randomUUID()}.${ext}`, userId, internal, at: new Date() }
  await storage().put(att.key, file.buffer, file.mimetype)
  const r: any = await HelpdeskTicket.findOneAndUpdate({ _id: t._id, tenantId }, { $push: { attachments: att } }, { returnDocument: 'after' }).lean()
  res.status(201).json({ success: true, data: view(r, staff) })
}))
helpdeskRouter.get('/tickets/:id/attachments/:aid', validate(z.object({ params: z.object({ id: z.string().uuid(), aid: z.string().uuid() }) })), asyncHandler(async (req, res) => {
  const t = await load(req, String(req.params.id))
  const a = (t.attachments ?? []).find((x: any) => x.id === String(req.params.aid) && (isStaff(req.user!.roleIds) || !x.internal))
  if (!a) throw new AppError('File not found', 404)
  res.json({ success: true, data: { url: await storage().signedUrl(a.key, 300, a.name), name: a.name, type: a.type } })
}))

// Run hourly by the helpdesk-maintenance job: resolved tickets close after 7 days; a ticket past its target is flagged and HR is told once
export async function helpdeskMaintenance(only?: string) {
  const now = new Date()
  const scope = only ? { tenantId: only } : {}
  let n = 0
  for (const t of (await HelpdeskTicket.find({ ...scope, status: 'resolved', resolvedAt: { $lt: new Date(now.getTime() - AUTO_CLOSE_DAYS * 86_400_000) } }).limit(500).lean()) as any[]) {
    await HelpdeskTicket.updateOne({ _id: t._id, status: 'resolved' }, { $set: patchFor(t, { status: 'closed' }) })
    await tell(t, [t.requesterUserId], 'helpdesk.status', `${t.number} was closed`, `It was resolved a week ago, so it closed by itself. Reply to reopen it if you still need help.`)
    n++
  }
  for (const t of (await HelpdeskTicket.find({ ...scope, status: { $in: ['open', 'in_progress'] }, dueAt: { $lt: now }, escalatedAt: { $in: [null, undefined] } }).limit(500).lean()) as any[]) {
    await HelpdeskTicket.updateOne({ _id: t._id, escalatedAt: { $in: [null, undefined] } }, { $set: { escalatedAt: now } })
    await tell(t, t.assigneeUserId ? [t.assigneeUserId] : await staffUserIds(t.tenantId), 'helpdesk.overdue', `${t.number} is past its response target`, `${t.subject} (${t.categoryName}) is waiting for an answer.`)
    n++
  }
  return n
}

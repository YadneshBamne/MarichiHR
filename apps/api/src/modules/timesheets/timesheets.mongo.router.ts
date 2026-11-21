import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { requireFeature } from '../../middleware/module.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { TsProject, TsWeek, AuditLog, Employee } from '../../infrastructure/mongo/mongo'

// Timesheets: people log hours by project and task for a Monday-to-Sunday week, submit it, and their manager (or HR) approves.
// A week is one document (entries embedded). Draft and rejected weeks can be edited; submitted and approved weeks are read-only.
// ponytail: no billing rates or invoice export yet; the project report gives hours by project and person.
export const timesheetsRouter = Router()
timesheetsRouter.use(authenticate, requireFeature('timesheets'))

const ADMINS = ['hr_admin', 'system_admin']
const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const utc = (s: string) => new Date(`${s}T00:00:00.000Z`)
const iso = (d: Date) => d.toISOString().slice(0, 10)
const isMonday = (s: string) => utc(s).getUTCDay() === 1 && iso(utc(s)) === s
const addDays = (s: string, n: number) => iso(new Date(utc(s).getTime() + n * 86400000))
const idp = z.object({ id: z.string().uuid() })
const myEmployee = (req: any) => { if (!req.user.employeeId) throw new AppError('Timesheets are for employees', 403); return req.user.employeeId as string }

// ── projects (HR admins and system admins manage them; everyone sees the active ones)
timesheetsRouter.get('/projects', asyncHandler(async (req, res) => {
  const q: any = { tenantId: req.user!.tenantId }
  if (!req.user!.roleIds.some((r) => ADMINS.includes(r))) q.active = { $ne: false }
  res.json({ success: true, data: (await TsProject.find(q).sort({ code: 1 }).lean()).map(ser) })
}))
const ProjectBody = z.object({ code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9._-]+$/), name: z.string().trim().min(2).max(80), billable: z.boolean().default(true), active: z.boolean().default(true) }).strict()
timesheetsRouter.post('/projects', requireRoles(...ADMINS), validate(z.object({ body: ProjectBody })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const p: any = await TsProject.create({ ...req.body, code: req.body.code.toUpperCase(), tenantId }).catch((e) => { throw e?.code === 11000 ? new AppError('A project with that code exists', 409) : e })
  await AuditLog.create({ tenantId, userId, action: 'TS_PROJECT_CREATED', entityType: 'ts_project', entityId: p._id, newValue: req.body })
  res.status(201).json({ success: true, data: ser(p.toObject()) })
}))
timesheetsRouter.put('/projects/:id', requireRoles(...ADMINS), validate(z.object({ params: idp, body: ProjectBody.partial() })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const set = { ...req.body, ...(req.body.code && { code: req.body.code.toUpperCase() }) }
  const p: any = await TsProject.findOneAndUpdate({ _id: String(req.params.id), tenantId }, { $set: set }, { returnDocument: 'after' }).lean().catch((e) => { throw e?.code === 11000 ? new AppError('A project with that code exists', 409) : e })
  if (!p) throw new AppError('Project not found', 404)
  await AuditLog.create({ tenantId, userId, action: 'TS_PROJECT_UPDATED', entityType: 'ts_project', entityId: p._id, newValue: req.body })
  res.json({ success: true, data: ser(p) })
}))

// ── my week
const weekView = (w: any, weekStart: string) => ({ id: w?._id ?? null, weekStart, status: w?.status ?? 'draft', entries: w?.entries ?? [], note: w?.note ?? null, submittedAt: w?.submittedAt ?? null, decidedAt: w?.decidedAt ?? null, total: (w?.entries ?? []).reduce((a: number, e: any) => a + e.hours, 0) })
timesheetsRouter.get('/week', validate(z.object({ query: z.object({ start: ymd }) })), asyncHandler(async (req, res) => {
  const start = String(req.query.start)
  if (!isMonday(start)) throw new AppError('A week starts on a Monday', 400)
  const w: any = await TsWeek.findOne({ tenantId: req.user!.tenantId, employeeId: myEmployee(req), weekStart: start }).lean()
  res.json({ success: true, data: weekView(w, start) })
}))

const Entry = z.object({ date: ymd, projectId: z.string().uuid(), task: z.string().trim().max(120).default(''), hours: z.number().min(0.25).max(24).refine((h) => Math.round(h * 4) === h * 4, 'Hours go in quarters'), note: z.string().trim().max(300).optional() }).strict()
timesheetsRouter.put('/week', validate(z.object({ body: z.object({ weekStart: ymd, entries: z.array(Entry).max(200) }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId } = req.user!
  const employeeId = myEmployee(req)
  const { weekStart, entries } = req.body as { weekStart: string; entries: z.infer<typeof Entry>[] }
  if (!isMonday(weekStart)) throw new AppError('A week starts on a Monday', 400)
  const cur: any = await TsWeek.findOne({ tenantId, employeeId, weekStart }).lean()
  if (cur && ['submitted', 'approved'].includes(cur.status)) throw new AppError(`This week is ${cur.status} and can't be edited`, 409)
  const end = addDays(weekStart, 6)
  const perDay = new Map<string, number>()
  for (const e of entries) {
    if (e.date < weekStart || e.date > end) throw new AppError(`${e.date} is outside this week`, 400)
    perDay.set(e.date, (perDay.get(e.date) ?? 0) + e.hours)
  }
  for (const [d, h] of perDay) if (h > 24) throw new AppError(`More than 24 hours on ${d}`, 400)
  const ids = [...new Set(entries.map((e) => e.projectId))]
  const ok = await TsProject.countDocuments({ tenantId, _id: { $in: ids }, active: { $ne: false } })
  if (ok !== ids.length) throw new AppError('A project is missing or inactive', 400)
  const w: any = await TsWeek.findOneAndUpdate({ tenantId, employeeId, weekStart }, { $set: { entries, status: 'draft' } }, { upsert: true, returnDocument: 'after' }).lean()
  res.json({ success: true, data: weekView(w, weekStart) })
}))

timesheetsRouter.post('/week/submit', validate(z.object({ body: z.object({ weekStart: ymd }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const employeeId = myEmployee(req)
  const w: any = await TsWeek.findOneAndUpdate({ tenantId, employeeId, weekStart: req.body.weekStart, status: { $in: ['draft', 'rejected'] }, 'entries.0': { $exists: true } }, { $set: { status: 'submitted', submittedAt: new Date(), note: null } }, { returnDocument: 'after' }).lean()
  if (!w) throw new AppError('Nothing to submit: add hours first, or the week is already submitted', 409)
  await AuditLog.create({ tenantId, userId, action: 'TS_WEEK_SUBMITTED', entityType: 'ts_week', entityId: w._id, newValue: { weekStart: w.weekStart } })
  res.json({ success: true, data: weekView(w, w.weekStart) })
}))

// ── approvals: a manager sees the weeks of their direct reports, HR and system admins see everyone's; never your own
async function approvable(req: any) {
  const { tenantId, employeeId, roleIds } = req.user
  if (roleIds.some((r: string) => ADMINS.includes(r))) return {}
  const mine: any[] = await Employee.find({ tenantId, managerId: employeeId ?? '__none__', active: true }).select('_id').lean()
  return { employeeId: { $in: mine.map((m) => m._id) } }
}
timesheetsRouter.get('/approvals', asyncHandler(async (req, res) => {
  const { tenantId, employeeId } = req.user!
  const scope = await approvable(req)
  const rows: any[] = await TsWeek.find({ tenantId, status: 'submitted', ...scope, ...(employeeId && { employeeId: { ...(scope as any).employeeId, $ne: employeeId } }) }).sort({ submittedAt: 1 }).limit(200).lean()
  const emps: any[] = await Employee.find({ tenantId, _id: { $in: rows.map((r) => r.employeeId) } }).select('firstName lastName employeeCode').lean()
  const name = new Map(emps.map((e) => [e._id, `${e.firstName} ${e.lastName}`]))
  const projects: any[] = await TsProject.find({ tenantId }).select('code name').lean()
  res.json({ success: true, data: { projects: projects.map(ser), weeks: rows.map((r) => ({ ...weekView(r, r.weekStart), employeeId: r.employeeId, employeeName: name.get(r.employeeId) ?? null })) } })
}))
timesheetsRouter.post('/weeks/:id/decide', validate(z.object({ params: idp, body: z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId, employeeId } = req.user!
  const scope = await approvable(req)
  const w: any = await TsWeek.findOne({ _id: String(req.params.id), tenantId, ...scope }).lean()
  if (!w) throw new AppError('Timesheet not found', 404)
  if (w.employeeId === employeeId) throw new AppError('You cannot approve your own timesheet', 403)
  if (!req.body.approve && !req.body.note) throw new AppError('Say what needs changing', 400)
  const r: any = await TsWeek.findOneAndUpdate({ _id: w._id, tenantId, status: 'submitted' }, { $set: { status: req.body.approve ? 'approved' : 'rejected', decidedBy: userId, decidedAt: new Date(), note: req.body.note ?? null } }, { returnDocument: 'after' }).lean()
  if (!r) throw new AppError('Someone else just acted on this timesheet', 409)
  await AuditLog.create({ tenantId, userId, action: req.body.approve ? 'TS_WEEK_APPROVED' : 'TS_WEEK_REJECTED', entityType: 'ts_week', entityId: w._id, newValue: { note: req.body.note ?? null } })
  res.json({ success: true, data: weekView(r, r.weekStart) })
}))

// ── report: approved hours by project and person for a date range (HR admins, system admins)
timesheetsRouter.get('/report', requireRoles(...ADMINS), validate(z.object({ query: z.object({ from: ymd, to: ymd }) })), asyncHandler(async (req, res) => {
  const { tenantId } = req.user!
  const from = String(req.query.from), to = String(req.query.to)
  const weeks: any[] = await TsWeek.find({ tenantId, status: 'approved', weekStart: { $gte: addDays(from, -6), $lte: to } }).lean()
  const projects: any[] = await TsProject.find({ tenantId }).lean()
  const pn = new Map(projects.map((p) => [p._id, p]))
  const emps: any[] = await Employee.find({ tenantId, _id: { $in: [...new Set(weeks.map((w) => w.employeeId))] } }).select('firstName lastName').lean()
  const en = new Map(emps.map((e) => [e._id, `${e.firstName} ${e.lastName}`]))
  const rows = new Map<string, { projectId: string; code: string; project: string; billable: boolean; employee: string; hours: number }>()
  for (const w of weeks) for (const e of w.entries) {
    if (e.date < from || e.date > to) continue
    const key = `${e.projectId}|${w.employeeId}`
    const p = pn.get(e.projectId)
    const row = rows.get(key) ?? { projectId: e.projectId, code: p?.code ?? '?', project: p?.name ?? 'Removed project', billable: p?.billable !== false, employee: en.get(w.employeeId) ?? '?', hours: 0 }
    row.hours += e.hours
    rows.set(key, row)
  }
  res.json({ success: true, data: [...rows.values()].sort((a, b) => a.code.localeCompare(b.code) || a.employee.localeCompare(b.employee)) })
}))

import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { redis, soft } from '../../infrastructure/cache/redis'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { apiKeyService } from './integrations.service'

import { attendanceExtras, PunchesBody } from '../attendance/attendance-extras.service'
import { employeeService } from '../employees/employees.service'
import { leaveService } from '../leave/leave.service'
// API for other systems (payroll bureaus, BI tools, access control, HR feeds), authenticated with an API key:
// `Authorization: Bearer mhr_…`. Each key carries scopes; every query is scoped to the key's company.
export const integrationApiRouter = Router()
const RATE_PER_MIN = 120
type KeyReq = Request & { apiKey?: { id: string; tenantId: string; scopes: string[]; createdBy: string } }

integrationApiRouter.use(asyncHandler(async (req: KeyReq, _res: Response, next: NextFunction) => {
  const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  const row = key ? await apiKeyService.resolve(key) : null
  if (!row) throw new AppError('Missing, invalid, revoked or expired API key', 401)
  const bucket = `apikey:${row.id}:${Math.floor(Date.now() / 60_000)}`
  const used = await soft(async () => { const n = await redis.incr(bucket); if (n === 1) await redis.expire(bucket, 90); return n }, 0)
  if (used > RATE_PER_MIN) throw new AppError(`Rate limit: ${RATE_PER_MIN} requests a minute per key`, 429)
  req.apiKey = { id: row.id, tenantId: row.tenantId, scopes: row.scopes, createdBy: row.createdBy }
  next()
}))
const scope = (s: string) => (req: KeyReq, _res: Response, next: NextFunction) => (req.apiKey!.scopes.includes(s) ? next() : next(new AppError(`This key does not have the ${s} scope`, 403)))
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const page = { limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
const tenantOf = (req: Request) => (req as KeyReq).apiKey!.tenantId

// Punches from biometric devices or turnstiles: [{ employeeId (code or work email), at (ISO time), type in|out, deviceId? }]
integrationApiRouter.post('/punches', scope('attendance:write'), validate(z.object({ body: PunchesBody })), asyncHandler(async (req, res) => {
  res.json(await attendanceExtras.ingestPunches(tenantOf(req), req.body.punches))
}))

// People directory: work details only (no personal, identity, pay or bank data)
integrationApiRouter.get('/employees', scope('employees:read'), validate(z.object({ query: z.object({ ...page, status: z.enum(['active', 'all']).default('active'), updatedSince: z.string().datetime().optional() }) })), asyncHandler(async (req, res) => {
  const q = req.query as any
  const where = { tenantId: tenantOf(req), ...(q.status === 'active' && { active: true }), ...(q.updatedSince && { updatedAt: { gte: new Date(q.updatedSince) } }) }
  const [total, rows] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.findMany({ where, orderBy: { employeeCode: 'asc' }, skip: q.offset, take: q.limit, select: { employeeCode: true, firstName: true, lastName: true, workEmail: true, employmentType: true, employmentStatus: true, active: true, hireDate: true, exitDate: true, updatedAt: true, orgUnit: { select: { name: true } }, jobPosition: { select: { title: true } }, workLocation: { select: { name: true } }, manager: { select: { employeeCode: true } } } }),
  ])
  res.json({ total, limit: q.limit, offset: q.offset, data: rows.map((e) => ({ employeeId: e.employeeCode, firstName: e.firstName, lastName: e.lastName, workEmail: e.workEmail, department: e.orgUnit?.name ?? null, jobTitle: e.jobPosition?.title ?? null, office: e.workLocation?.name ?? null, managerEmployeeId: e.manager?.employeeCode ?? null, employmentType: e.employmentType, status: e.active ? e.employmentStatus : 'exited', hireDate: ymd(e.hireDate), exitDate: ymd(e.exitDate), updatedAt: e.updatedAt })) })
}))

integrationApiRouter.get('/org-units', scope('org:read'), asyncHandler(async (req, res) => {
  const units = await prisma.orgUnit.findMany({ where: { tenantId: tenantOf(req), active: true }, select: { id: true, name: true, type: true, parentId: true }, orderBy: { name: 'asc' } })
  res.json({ total: units.length, data: units })
}))

// Approved leave overlapping a date range (at most 366 days)
integrationApiRouter.get('/leave', scope('leave:read'), validate(z.object({ query: z.object({ ...page, from: date, to: date }) })), asyncHandler(async (req, res) => {
  const q = req.query as any
  const [from, to] = [new Date(`${q.from}T00:00:00Z`), new Date(`${q.to}T00:00:00Z`)]
  if (from > to || to.getTime() - from.getTime() > 366 * 86_400_000) throw new AppError('from must be before to, at most 366 days apart', 400)
  const where = { status: 'approved', employee: { tenantId: tenantOf(req) }, startDate: { lte: to }, endDate: { gte: from } }
  const [total, rows] = await Promise.all([
    prisma.leaveRequest.count({ where }),
    prisma.leaveRequest.findMany({ where, orderBy: { startDate: 'asc' }, skip: q.offset, take: q.limit, select: { startDate: true, endDate: true, totalDays: true, employee: { select: { employeeCode: true } }, leaveType: { select: { code: true, name: true, isPaid: true } } } }),
  ])
  res.json({ total, limit: q.limit, offset: q.offset, data: rows.map((l) => ({ employeeId: l.employee.employeeCode, leaveType: l.leaveType.code, leaveTypeName: l.leaveType.name, paid: l.leaveType.isPaid, startDate: ymd(l.startDate), endDate: ymd(l.endDate), days: l.totalDays })) })
}))

// Attendance by day (at most 31 days)
integrationApiRouter.get('/attendance', scope('attendance:read'), validate(z.object({ query: z.object({ ...page, from: date, to: date }) })), asyncHandler(async (req, res) => {
  const q = req.query as any
  const [from, to] = [new Date(`${q.from}T00:00:00Z`), new Date(`${q.to}T00:00:00Z`)]
  if (from > to || to.getTime() - from.getTime() > 31 * 86_400_000) throw new AppError('from must be before to, at most 31 days apart', 400)
  const where = { employee: { tenantId: tenantOf(req) }, date: { gte: from, lte: to } }
  const [total, rows] = await Promise.all([
    prisma.attendanceRecord.count({ where }),
    prisma.attendanceRecord.findMany({ where, orderBy: [{ date: 'asc' }, { employeeId: 'asc' }], skip: q.offset, take: q.limit, select: { date: true, status: true, checkInTime: true, checkOutTime: true, workedHours: true, employee: { select: { employeeCode: true } } } }),
  ])
  res.json({ total, limit: q.limit, offset: q.offset, data: rows.map((a) => ({ employeeId: a.employee.employeeCode, date: ymd(a.date), status: a.status, checkIn: a.checkInTime, checkOut: a.checkOutTime, workedHours: a.workedHours })) })
}))

// ─── Writes ─────────────────────────────────────────────────────────────────────────────────────────────
// Other systems refer to people by employee code (or work email) and to departments, job titles and offices by name.
// Writes run through the same rules as the app (audit log, events, approvals); the key's creator is recorded as the actor.
async function refs(tenantId: string, b: { department?: string; jobTitle?: string; office?: string; managerEmployeeId?: string }) {
  const out: Record<string, string> = {}
  if (b.department) {
    const u = await prisma.orgUnit.findFirst({ where: { tenantId, name: { equals: b.department, mode: 'insensitive' }, active: true } })
    if (!u) throw new AppError(`No department called "${b.department}"`, 400)
    out.orgUnitId = u.id
  }
  if (b.jobTitle) {
    const j = await prisma.jobPosition.findFirst({ where: { tenantId, title: { equals: b.jobTitle, mode: 'insensitive' } } })
    if (!j) throw new AppError(`No job position called "${b.jobTitle}"`, 400)
    out.jobPositionId = j.id
  }
  if (b.office) {
    const w = await prisma.workLocation.findFirst({ where: { tenantId, name: { equals: b.office, mode: 'insensitive' } } })
    if (!w) throw new AppError(`No office called "${b.office}"`, 400)
    out.workLocationId = w.id
  }
  if (b.managerEmployeeId) out.managerId = (await byCode(tenantId, b.managerEmployeeId)).id
  return out
}
async function byCode(tenantId: string, codeOrEmail: string) {
  const e = await prisma.employee.findFirst({ where: { tenantId, OR: [{ employeeCode: codeOrEmail }, { workEmail: { equals: codeOrEmail, mode: 'insensitive' } }] } })
  if (!e) throw new AppError(`No employee ${codeOrEmail}`, 404)
  return e
}
const refFields = { department: z.string().trim().max(120).optional(), jobTitle: z.string().trim().max(120).optional(), office: z.string().trim().max(120).optional(), managerEmployeeId: z.string().trim().max(120).optional() }
const NewEmployee = z.object({ firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80), workEmail: z.string().email(), hireDate: date, employmentType: z.string().trim().min(1).max(40).default('full_time'), mobileWork: z.string().trim().max(30).optional(), taxJurisdiction: z.string().length(2).optional(), ...refFields }).strict()
const EditEmployee = z.object({ firstName: z.string().trim().min(1).max(80).optional(), lastName: z.string().trim().min(1).max(80).optional(), mobileWork: z.string().trim().max(30).optional(), employmentType: z.string().trim().min(1).max(40).optional(), ...refFields }).strict()

// Create a person (no login: HR grants that in the app). Department is required unless the company has one unit.
integrationApiRouter.post('/employees', scope('employees:write'), validate(z.object({ body: NewEmployee })), asyncHandler(async (req, res) => {
  const t = tenantOf(req), b = req.body
  const r = await refs(t, b)
  if (!r.orgUnitId) {
    const units = await prisma.orgUnit.findMany({ where: { tenantId: t, active: true }, select: { id: true }, take: 2 })
    if (units.length !== 1) throw new AppError('Give the department', 400)
    r.orgUnitId = units[0].id
  }
  const created: any = await employeeService.create(t, { firstName: b.firstName, lastName: b.lastName, workEmail: b.workEmail, hireDate: b.hireDate, employmentType: b.employmentType, ...(b.mobileWork && { mobileWork: b.mobileWork }), ...(b.taxJurisdiction && { taxJurisdiction: b.taxJurisdiction }), ...r } as any, (req as KeyReq).apiKey!.createdBy)
  const e = created.employee ?? created
  res.status(201).json({ data: { employeeId: e.employeeCode, firstName: e.firstName, lastName: e.lastName, workEmail: e.workEmail } })
}))
integrationApiRouter.patch('/employees/:code', scope('employees:write'), validate(z.object({ params: z.object({ code: z.string().min(1).max(120) }), body: EditEmployee })), asyncHandler(async (req, res) => {
  const t = tenantOf(req), b = req.body
  const e = await byCode(t, String(req.params.code))
  const { department: _d, jobTitle: _j, office: _o, managerEmployeeId: _m, ...plain } = b
  await employeeService.update(e.id, t, { ...plain, ...(await refs(t, b)) } as any, (req as KeyReq).apiKey!.createdBy)
  res.json({ data: { employeeId: e.employeeCode, updated: Object.keys(b) } })
}))

// Apply leave for someone (e.g. from a time-off kiosk): it goes to their manager for approval like any request
const NewLeave = z.object({ employeeId: z.string().min(1).max(120), leaveType: z.string().trim().min(1).max(40), startDate: date, endDate: date, reason: z.string().trim().max(500).optional() }).strict()
integrationApiRouter.post('/leave', scope('leave:write'), validate(z.object({ body: NewLeave })), asyncHandler(async (req, res) => {
  const t = tenantOf(req), b = req.body
  const e = await byCode(t, b.employeeId)
  const type = await prisma.leaveType.findFirst({ where: { tenantId: t, active: true, OR: [{ code: b.leaveType.toUpperCase() }, { name: { equals: b.leaveType, mode: 'insensitive' } }] } })
  if (!type) throw new AppError(`No leave type "${b.leaveType}"`, 400)
  const r: any = await leaveService.applyLeave(e.id, t, { leaveTypeId: type.id, startDate: b.startDate, endDate: b.endDate, ...(b.reason && { reason: b.reason }) })
  const lr = r.request ?? r.leaveRequest ?? r
  res.status(201).json({ data: { id: lr.id, status: lr.status, totalDays: lr.totalDays ?? null } })
}))

import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { redis, soft } from '../../infrastructure/cache/redis'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { apiKeyService } from './integrations.service'

// Read-only API for other systems (payroll bureaus, BI tools, access control), authenticated with an API key:
// `Authorization: Bearer mhr_…`. Each key carries scopes; every query is scoped to the key's company.
export const integrationApiRouter = Router()
const RATE_PER_MIN = 120
type KeyReq = Request & { apiKey?: { id: string; tenantId: string; scopes: string[] } }

integrationApiRouter.use(asyncHandler(async (req: KeyReq, _res: Response, next: NextFunction) => {
  const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  const row = key ? await apiKeyService.resolve(key) : null
  if (!row) throw new AppError('Missing, invalid, revoked or expired API key', 401)
  const bucket = `apikey:${row.id}:${Math.floor(Date.now() / 60_000)}`
  const used = await soft(async () => { const n = await redis.incr(bucket); if (n === 1) await redis.expire(bucket, 90); return n }, 0)
  if (used > RATE_PER_MIN) throw new AppError(`Rate limit: ${RATE_PER_MIN} requests a minute per key`, 429)
  req.apiKey = { id: row.id, tenantId: row.tenantId, scopes: row.scopes }
  next()
}))
const scope = (s: string) => (req: KeyReq, _res: Response, next: NextFunction) => (req.apiKey!.scopes.includes(s) ? next() : next(new AppError(`This key does not have the ${s} scope`, 403)))
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const page = { limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
const tenantOf = (req: Request) => (req as KeyReq).apiKey!.tenantId

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

import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { prisma } from '../../infrastructure/database/prisma'

// Who changed what and when: a read-only, tenant-scoped view of audit_logs for HR, system admins and compliance.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Query = z.object({
  query: z.object({
    from: date.optional(), to: date.optional(),
    userId: z.string().uuid().optional(), entityType: z.string().max(60).optional(), entityId: z.string().max(60).optional(),
    action: z.string().max(80).optional(), cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
})

// Never show secrets, whatever a module wrote
const SECRET = /password|secret|token|accountno|bankaccount(?!last4)|mfa(?!enabled)/i
const redact = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(redact) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, SECRET.test(k) ? '••••' : redact(x)])) : v

// Field-level before/after; values that aren't objects are shown whole
function changes(oldValue: unknown, newValue: unknown) {
  const o = (oldValue && typeof oldValue === 'object' && !Array.isArray(oldValue) ? oldValue : {}) as Record<string, unknown>
  const n = (newValue && typeof newValue === 'object' && !Array.isArray(newValue) ? newValue : {}) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])]
  if (!keys.length && (oldValue != null || newValue != null)) return [{ field: 'value', from: oldValue ?? null, to: newValue ?? null }]
  return keys.map((field) => ({ field, from: field in o ? o[field] : null, to: field in n ? n[field] : null }))
}

function where(tenantId: string, q: z.infer<typeof Query>['query']): Prisma.AuditLogWhereInput {
  return {
    tenantId,
    ...(q.userId && { userId: q.userId }),
    ...(q.entityType && { entityType: q.entityType }),
    ...(q.entityId && { entityId: q.entityId }),
    ...(q.action && { action: { contains: q.action.trim().replace(/\s+/g, '_'), mode: 'insensitive' } }),
    ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: new Date(`${q.from}T00:00:00Z`) }), ...(q.to && { lt: new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000) }) } }),
  }
}

// Human labels for the records the entries point at, fetched in one go per type
async function labels(tenantId: string, rows: { entityType: string; entityId: string }[]) {
  const ids = (t: string) => [...new Set(rows.filter((r) => r.entityType === t).map((r) => r.entityId))]
  const out = new Map<string, string>()
  const put = (t: string, list: { id: string; label: string }[]) => list.forEach((x) => out.set(`${t}:${x.id}`, x.label))
  await Promise.all([
    prisma.employee.findMany({ where: { tenantId, id: { in: ids('employee') } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
      .then((l) => put('employee', l.map((e) => ({ id: e.id, label: `${e.firstName} ${e.lastName} (${e.employeeCode})` })))),
    prisma.user.findMany({ where: { tenantId, id: { in: ids('user') } }, select: { id: true, fullName: true } }).then((l) => put('user', l.map((u) => ({ id: u.id, label: u.fullName })))),
    prisma.policy.findMany({ where: { tenantId, id: { in: ids('policy') } }, select: { id: true, title: true } }).then((l) => put('policy', l.map((p) => ({ id: p.id, label: p.title })))),
    prisma.announcement.findMany({ where: { tenantId, id: { in: ids('announcement') } }, select: { id: true, title: true } }).then((l) => put('announcement', l.map((a) => ({ id: a.id, label: a.title })))),
    prisma.grievance.findMany({ where: { tenantId, id: { in: ids('grievance') } }, select: { id: true, ticketNo: true } }).then((l) => put('grievance', l.map((g) => ({ id: g.id, label: g.ticketNo })))),
    prisma.holidayCalendar.findMany({ where: { tenantId, id: { in: ids('holiday_calendar') } }, select: { id: true, name: true } }).then((l) => put('holiday_calendar', l.map((c) => ({ id: c.id, label: c.name })))),
    prisma.payrollCycle.findMany({ where: { tenantId, id: { in: ids('payroll_cycle') } }, select: { id: true, payPeriodStart: true } })
      .then((l) => put('payroll_cycle', l.map((c) => ({ id: c.id, label: `Payroll ${c.payPeriodStart.toISOString().slice(0, 7)}` })))),
    prisma.leaveRequest.findMany({ where: { id: { in: ids('leave_request') }, employee: { tenantId } }, select: { id: true, employee: { select: { firstName: true, lastName: true } }, leaveType: { select: { name: true } } } })
      .then((l) => put('leave_request', l.map((r) => ({ id: r.id, label: `${r.leaveType.name} · ${r.employee.firstName} ${r.employee.lastName}` })))),
    prisma.employeeContract.findMany({ where: { id: { in: ids('contract') }, employee: { tenantId } }, select: { id: true, employee: { select: { firstName: true, lastName: true } } } })
      .then((l) => put('contract', l.map((c) => ({ id: c.id, label: `Contract · ${c.employee.firstName} ${c.employee.lastName}` })))),
  ])
  return out
}

async function page(tenantId: string, q: z.infer<typeof Query>['query'], take: number) {
  const rows = await prisma.auditLog.findMany({
    where: where(tenantId, q),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
  })
  const more = rows.length > take
  const list = rows.slice(0, take)
  const [who, what] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...new Set(list.map((r) => r.userId).filter(Boolean) as string[])] } }, select: { id: true, fullName: true } }),
    labels(tenantId, list),
  ])
  const name = new Map(who.map((u) => [u.id, u.fullName]))
  return {
    items: list.map((r) => ({
      id: r.id, at: r.createdAt, action: r.action, entityType: r.entityType, entityId: r.entityId,
      entity: what.get(`${r.entityType}:${r.entityId}`) ?? null,
      user: r.userId ? { id: r.userId, name: name.get(r.userId) ?? 'Former user' } : null,
      changes: changes(redact(r.oldValue), redact(r.newValue)), ipAddress: r.ipAddress, userAgent: r.userAgent,
    })),
    nextCursor: more ? list[list.length - 1].id : null,
  }
}

const csvCell = (v: unknown) => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

export const auditRouter = Router()
auditRouter.use(authenticate, requirePermission('audit:read'))

auditRouter.get('/', validate(Query), asyncHandler(async (req, res) => {
  const q = req.query as any
  res.json({ success: true, data: await page(req.user!.tenantId, q, Number(q.limit) || 50) })
}))

// Filter choices: the areas and actions that exist, and who has done something
auditRouter.get('/facets', asyncHandler(async (req, res) => {
  const tenantId = req.user!.tenantId
  const [types, actions, users] = await Promise.all([
    prisma.auditLog.groupBy({ by: ['entityType'], where: { tenantId }, _count: true, orderBy: { entityType: 'asc' } }),
    prisma.auditLog.groupBy({ by: ['action'], where: { tenantId }, _count: true, orderBy: { action: 'asc' } }),
    prisma.auditLog.groupBy({ by: ['userId'], where: { tenantId, userId: { not: null } }, _count: true }),
  ])
  const names = await prisma.user.findMany({ where: { tenantId, id: { in: users.map((u) => u.userId!) } }, select: { id: true, fullName: true }, orderBy: { fullName: 'asc' } })
  res.json({ success: true, data: { entityTypes: types.map((t) => t.entityType), actions: actions.map((a) => a.action), users: names } })
}))

auditRouter.get('/export', validate(Query), asyncHandler(async (req, res) => {
  const { items } = await page(req.user!.tenantId, { ...(req.query as any), cursor: undefined }, 5000)
  const lines = [['Time (UTC)', 'Who', 'Action', 'Area', 'Record', 'Record id', 'Changes', 'IP'].join(',')]
  for (const r of items) lines.push([r.at.toISOString(), r.user?.name ?? 'System', r.action, r.entityType, r.entity ?? '', r.entityId, r.changes.map((c) => `${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join('; '), r.ipAddress ?? ''].map(csvCell).join(','))
  await prisma.auditLog.create({ data: { tenantId: req.user!.tenantId, userId: req.user!.userId, action: 'AUDIT_LOG_EXPORTED', entityType: 'audit_log', entityId: req.user!.tenantId, newValue: { rows: items.length, filters: req.query as any } } })
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send('﻿' + lines.join('\r\n'))
}))

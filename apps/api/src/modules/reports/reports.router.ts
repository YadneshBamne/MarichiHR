import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { prisma } from '../../infrastructure/database/prisma'
import { REPORTS, Report, reportCatalog } from './reports.service'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Run = z.object({
  params: z.object({ key: z.string() }),
  query: z.object({
    from: date.optional(), to: date.optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    cycleId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(), groupBy: z.enum(['department', 'location', 'type']).optional(),
  }),
})

const find = (key: string) => { const r = REPORTS[key]; if (!r) throw new AppError('Report not found', 404); return r }
const hhmmss = (h: number) => { const t = Math.round(h * 3600); return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }
const cell = (v: unknown, type?: string) => { const s = v == null ? '' : type === 'hours' ? hhmmss(Number(v)) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const toCsv = (r: Report) => [r.columns.map((c) => cell(c.label)).join(','), ...r.rows.map((row) => r.columns.map((c) => cell(row[c.key], c.type)).join(','))].join('\r\n')

export const reportsRouter = Router()
reportsRouter.use(authenticate)

reportsRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ success: true, data: reportCatalog(req.user!) })
}))
// Choices for the payroll report
reportsRouter.get('/payroll/cycles', asyncHandler(async (req, res) => {
  if (!req.user!.roleIds.some((r) => REPORTS.payroll.roles.includes(r))) throw new AppError('Not allowed to view this report', 403)
  const cycles = await prisma.payrollCycle.findMany({ where: { tenantId: req.user!.tenantId, status: { notIn: ['draft'] } }, select: { id: true, payPeriodStart: true, payPeriodEnd: true, status: true }, orderBy: { payPeriodStart: 'desc' }, take: 36 })
  res.json({ success: true, data: cycles })
}))
reportsRouter.get('/:key', validate(Run), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await find(String(req.params.key)).run(req.user!, req.query as any) })
}))
reportsRouter.get('/:key/export', validate(Run), asyncHandler(async (req, res) => {
  const key = String(req.params.key)
  const report = await find(key).run(req.user!, req.query as any)
  await prisma.auditLog.create({ data: { tenantId: req.user!.tenantId, userId: req.user!.userId, action: 'REPORT_EXPORTED', entityType: 'report', entityId: key, newValue: { rows: report.rows.length, filters: req.query as any } } })
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${key}-report-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send('﻿' + toCsv(report))
}))

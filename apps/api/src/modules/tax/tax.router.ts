import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { assertCompensationAccess, AccessUser } from '../../shared/utils/access'
import { prisma } from '../../infrastructure/database/prisma'

// Tax & compliance: the statutory tables payroll uses (with sources), the statutory return for a payroll run
// (tax and contributions per employee, CSV for filing) and each employee's annual tax statement.

const PAYROLL_STAFF = ['hr_admin', 'payroll_admin', 'compliance_officer']
const FINAL = ['approved', 'disbursed']
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
// Lines that go to the tax authority or a statutory fund: tax, employer contributions and employee NAPSA/NHIMA
const isStatutory = (l: { category: string; code: string }) => l.category === 'TAX' || l.category === 'EMP_CONTRIB' || /^(NAPSA|NHIMA)/.test(l.code)

async function filing(user: AccessUser, cycleId: string) {
  const cycle = await prisma.payrollCycle.findFirst({ where: { id: cycleId, tenantId: user.tenantId } })
  if (!cycle) throw new AppError('Payroll run not found', 404)
  const slips = await prisma.payslip.findMany({
    where: { payrollCycleId: cycle.id },
    select: { grossEarnings: true, currency: true, employee: { select: { firstName: true, lastName: true, employeeCode: true, taxJurisdiction: true } }, lines: { select: { category: true, code: true, name: true, amount: true } } },
    orderBy: { employee: { employeeCode: 'asc' } },
  })
  const columns = new Map<string, string>()
  slips.forEach((s) => s.lines.filter(isStatutory).forEach((l) => columns.set(l.code, l.name)))
  const rows = slips.map((s) => {
    const row: Record<string, unknown> = { employee: `${s.employee.firstName} ${s.employee.lastName}`, code: s.employee.employeeCode, jurisdiction: s.employee.taxJurisdiction, gross: Number(s.grossEarnings), currency: s.currency }
    for (const c of columns.keys()) row[c] = round2(s.lines.filter((l) => l.code === c).reduce((a, l) => a + Number(l.amount), 0))
    return row
  })
  const totals = Object.fromEntries([...columns.keys(), 'gross'].map((c) => [c, round2(rows.reduce((a, r) => a + Number(r[c] ?? 0), 0))]))
  return {
    cycle: { id: cycle.id, payPeriodStart: cycle.payPeriodStart, payPeriodEnd: cycle.payPeriodEnd, status: cycle.status, final: FINAL.includes(cycle.status) },
    columns: [...columns].map(([code, name]) => ({ code, name })),
    rows, totals,
  }
}

const Filing = z.object({ query: z.object({ cycleId: z.string().uuid() }) })
const Statement = z.object({ query: z.object({ employeeId: z.string().uuid().optional(), year: z.coerce.number().int().min(2000).max(2100), basis: z.enum(['calendar', 'april']).default('calendar') }) })

export const taxRouter = Router()
taxRouter.use(authenticate)

taxRouter.get('/tables', requireRoles(...PAYROLL_STAFF), asyncHandler(async (_req, res) => {
  const rows = await prisma.statutoryTable.findMany({ orderBy: [{ country: 'asc' }, { code: 'asc' }, { effectiveFrom: 'desc' }] })
  const today = new Date().toISOString().slice(0, 10)
  const inForce = new Map<string, string>()
  for (const r of rows) { const d = r.effectiveFrom.toISOString().slice(0, 10); if (d <= today && !inForce.has(r.code)) inForce.set(r.code, r.id) }
  res.json({ success: true, data: rows.map((r) => ({ ...r, effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10), inForce: inForce.get(r.code) === r.id, upcoming: r.effectiveFrom.toISOString().slice(0, 10) > today })) })
}))

taxRouter.get('/filing', requireRoles(...PAYROLL_STAFF), validate(Filing), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await filing(req.user!, String(req.query.cycleId)) })
}))

taxRouter.get('/filing/export', requireRoles(...PAYROLL_STAFF), validate(Filing), asyncHandler(async (req, res) => {
  const f = await filing(req.user!, String(req.query.cycleId))
  const head = ['Employee', 'Code', 'Tax jurisdiction', 'Currency', 'Gross', ...f.columns.map((c) => c.name)]
  const lines = f.rows.map((r) => [r.employee, r.code, r.jurisdiction, r.currency, r.gross, ...f.columns.map((c) => r[c.code])].map(cell).join(','))
  lines.push(['Total', '', '', '', f.totals.gross, ...f.columns.map((c) => f.totals[c.code])].map(cell).join(','))
  const month = f.cycle.payPeriodStart.toISOString().slice(0, 7)
  await prisma.auditLog.create({ data: { tenantId: req.user!.tenantId, userId: req.user!.userId, action: 'STATUTORY_RETURN_EXPORTED', entityType: 'payroll_cycle', entityId: f.cycle.id, newValue: { month, rows: f.rows.length } } })
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="statutory-return-${month}.csv"`)
  res.send('﻿' + [head.map(cell).join(','), ...lines].join('\r\n'))
}))

// Month-by-month pay, tax and contributions for a year (calendar, or April-March for India), from finalised runs only
taxRouter.get('/statement', validate(Statement), asyncHandler(async (req, res) => {
  const user = req.user!
  const employeeId = (req.query.employeeId as string | undefined) ?? user.employeeId
  if (!employeeId) throw new AppError('Not found', 404)
  await assertCompensationAccess(user, employeeId)
  const year = Number(req.query.year)
  const april = req.query.basis === 'april'
  const from = new Date(Date.UTC(year, april ? 3 : 0, 1)), to = new Date(Date.UTC(april ? year + 1 : year + 1, april ? 3 : 0, 1))
  const [emp, tenant, slips] = await Promise.all([
    prisma.employee.findFirst({ where: { id: employeeId, tenantId: user.tenantId }, select: { firstName: true, lastName: true, employeeCode: true, taxJurisdiction: true, hireDate: true } }),
    prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } }),
    prisma.payslip.findMany({
      where: { employeeId, payrollCycle: { tenantId: user.tenantId, status: { in: FINAL }, payPeriodStart: { gte: from, lt: to } } },
      select: { grossEarnings: true, netPay: true, currency: true, payrollCycle: { select: { payPeriodStart: true } }, lines: { select: { category: true, code: true, name: true, amount: true } } },
      orderBy: { payrollCycle: { payPeriodStart: 'asc' } },
    }),
  ])
  const columns = new Map<string, string>()
  slips.forEach((s) => s.lines.filter((l) => isStatutory(l) && l.category !== 'EMP_CONTRIB').forEach((l) => columns.set(l.code, l.name)))
  const months = slips.map((s) => ({
    month: s.payrollCycle.payPeriodStart.toISOString().slice(0, 7), currency: s.currency, gross: Number(s.grossEarnings), net: Number(s.netPay),
    ...Object.fromEntries([...columns.keys()].map((c) => [c, round2(s.lines.filter((l) => l.code === c).reduce((a, l) => a + Number(l.amount), 0))])),
  }))
  const totals = Object.fromEntries(['gross', 'net', ...columns.keys()].map((c) => [c, round2(months.reduce((a, m: any) => a + Number(m[c] ?? 0), 0))]))
  res.json({ success: true, data: { employer: tenant?.name, employee: emp, period: { from: from.toISOString().slice(0, 10), to: new Date(to.getTime() - 86_400_000).toISOString().slice(0, 10), basis: april ? 'april' : 'calendar' }, columns: [...columns].map(([code, name]) => ({ code, name })), months, totals, generatedAt: new Date() } })
}))

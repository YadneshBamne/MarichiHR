import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { clearStatutoryCache } from './statutory'

// Tax administration by the company:
// - its own versions of the statutory tables (a Compliance officer enters them; payroll prefers them over the shared ones)
// - manual tax overrides on a payslip (a Payroll admin asks with a reason; a different Compliance officer signs off)

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const has = (u: AccessUser, r: string) => u.roleIds.includes(r)
const audit = (u: AccessUser, action: string, entityType: string, entityId: string, newValue?: any) =>
  prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action, entityType, entityId, newValue } })

// ─── Company table versions ─────────────────────────────────────────────────────────────────────────────────
export const TableVersionBody = z.object({
  code: z.string().trim().min(2).max(40),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  params: z.record(z.string(), z.any()),
  sourceUrl: z.string().trim().url().max(500).optional(),
  sourceNote: z.string().trim().min(5).max(500),
}).strict()

// The new figures must have the same shape as the shared table (same keys, same kinds of value), so the payroll
// formulas that read them keep working; rates are fractions (0.3 = 30%)
function sameShape(ref: any, val: any, path: string): string | null {
  if (Array.isArray(ref)) {
    if (!Array.isArray(val) || !val.length) return `${path} must be a non-empty list`
    for (let i = 0; i < val.length; i++) { const e = sameShape(ref[Math.min(i, ref.length - 1)], val[i], `${path}[${i + 1}]`); if (e) return e }
    return null
  }
  if (ref && typeof ref === 'object') {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return `${path} must be a group of values`
    const want = Object.keys(ref).sort().join(','), got = Object.keys(val).sort().join(',')
    if (want !== got) return `${path || 'The table'} needs exactly: ${Object.keys(ref).join(', ')}`
    for (const k of Object.keys(ref)) { const e = sameShape(ref[k], val[k], path ? `${path}.${k}` : k); if (e) return e }
    return null
  }
  if (ref === null || typeof ref === 'number') {
    // upTo: null = "and above" in bands
    if (val === null && (ref === null || path.endsWith('upTo'))) return null
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return `${path} must be a number of 0 or more`
    if (/rate$/i.test(path) && val > 1) return `${path} is a fraction: 0.3 means 30%`
    return null
  }
  if (typeof ref === 'string' && typeof val !== 'string') return `${path} must be text`
  if (typeof ref === 'boolean' && typeof val !== 'boolean') return `${path} must be yes or no`
  return null
}

export const taxAdmin = {
  async tables(u: AccessUser) {
    const rows = await prisma.statutoryTable.findMany({ where: { OR: [{ tenantId: null }, { tenantId: u.tenantId }] }, orderBy: [{ country: 'asc' }, { code: 'asc' }, { effectiveFrom: 'desc' }] })
    const today = new Date().toISOString().slice(0, 10)
    const inForce = new Map<string, { id: string; from: string; own: boolean }>()
    for (const r of rows) {
      const from = r.effectiveFrom.toISOString().slice(0, 10)
      if (from > today) continue
      const cur = inForce.get(r.code)
      if (!cur || from > cur.from || (from === cur.from && r.tenantId)) inForce.set(r.code, { id: r.id, from, own: !!r.tenantId })
    }
    return rows.map((r) => ({ ...r, effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10), company: !!r.tenantId, inForce: inForce.get(r.code)?.id === r.id, upcoming: r.effectiveFrom.toISOString().slice(0, 10) > today }))
  },

  async saveVersion(u: AccessUser, body: z.infer<typeof TableVersionBody>) {
    if (!has(u, 'compliance_officer')) throw new AppError('Only a Compliance officer changes tax tables', 403)
    const shared = await prisma.statutoryTable.findFirst({ where: { code: body.code, tenantId: null }, orderBy: { effectiveFrom: 'desc' } })
    if (!shared) throw new AppError('Unknown table', 404)
    const err = sameShape(shared.params, body.params, '')
    if (err) throw new AppError(err, 400)
    const effectiveFrom = new Date(`${body.effectiveFrom}T00:00:00Z`)
    const data = { name: shared.name, country: shared.country, params: body.params, sourceUrl: body.sourceUrl ?? shared.sourceUrl, sourceNote: body.sourceNote, verified: true, createdBy: u.userId }
    const existing = await prisma.statutoryTable.findFirst({ where: { code: body.code, effectiveFrom, tenantId: u.tenantId } })
    // Figures already used by a paid run stay as they were: a later date makes a new version instead
    if (existing && (await prisma.payslipLine.count({ where: { statutoryRef: { contains: `${body.code} ${body.effectiveFrom} (company)` }, payslip: { payrollCycle: { tenantId: u.tenantId, status: { in: ['disbursed', 'locked'] } } } } })))
      throw new AppError('Paid payroll already used this version. Enter the change with a later "in force from" date.', 400)
    const row = existing
      ? await prisma.statutoryTable.update({ where: { id: existing.id }, data })
      : await prisma.statutoryTable.create({ data: { ...data, code: body.code, effectiveFrom, tenantId: u.tenantId } })
    clearStatutoryCache()
    await audit(u, existing ? 'TAX_TABLE_UPDATED' : 'TAX_TABLE_ADDED', 'statutory_table', row.id, { code: body.code, effectiveFrom: body.effectiveFrom, params: body.params, before: existing?.params ?? shared.params })
    return row
  },

  async removeVersion(u: AccessUser, id: string) {
    if (!has(u, 'compliance_officer')) throw new AppError('Only a Compliance officer changes tax tables', 403)
    const row = await prisma.statutoryTable.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!row) throw new AppError('Not found', 404)
    const ref = `${row.code} ${row.effectiveFrom.toISOString().slice(0, 10)} (company)`
    if (await prisma.payslipLine.count({ where: { statutoryRef: { contains: ref }, payslip: { payrollCycle: { tenantId: u.tenantId } } } })) throw new AppError('Payroll has used this version, so it stays on record', 400)
    await prisma.statutoryTable.delete({ where: { id: row.id } })
    clearStatutoryCache()
    await audit(u, 'TAX_TABLE_REMOVED', 'statutory_table', row.id, { code: row.code })
    return { ok: true }
  },

  // ─── Manual tax overrides ────────────────────────────────────────────────────────────────────────────────
  async requestOverride(u: AccessUser, b: { cycleId: string; employeeId: string; lineCode: string; amount: number; reason: string }) {
    if (!has(u, 'payroll_admin')) throw new AppError('Only a Payroll admin asks for a tax override', 403)
    const cycle = await prisma.payrollCycle.findFirst({ where: { id: b.cycleId, tenantId: u.tenantId } })
    if (!cycle) throw new AppError('Payroll run not found', 404)
    if (cycle.status !== 'review') throw new AppError('Tax can be overridden while the run is in review (reopen it first)', 400)
    const line = await prisma.payslipLine.findFirst({ where: { code: b.lineCode, category: 'TAX', payslip: { payrollCycleId: cycle.id, employeeId: b.employeeId } } })
    if (!line) throw new AppError('That tax line is not on this payslip', 404)
    if (await prisma.taxOverride.count({ where: { cycleId: cycle.id, employeeId: b.employeeId, lineCode: b.lineCode, status: 'pending' } })) throw new AppError('An override for this line is already waiting for sign-off', 400)
    const o = await prisma.taxOverride.create({ data: { tenantId: u.tenantId, cycleId: cycle.id, employeeId: b.employeeId, lineCode: b.lineCode, originalAmount: line.amount, amount: b.amount, reason: b.reason, requestedBy: u.userId } })
    await audit(u, 'TAX_OVERRIDE_REQUESTED', 'payroll_cycle', cycle.id, { overrideId: o.id, employeeId: b.employeeId, lineCode: b.lineCode, from: Number(line.amount), to: b.amount, reason: b.reason })
    const officers = (await userIdsWithRole(u.tenantId, 'compliance_officer')).filter((x) => x !== u.userId)
    await notify({ tenantId: u.tenantId, userIds: officers, type: 'tax.override_requested', title: 'Tax override waiting for your sign-off', body: `${b.lineCode}: ${Number(line.amount).toLocaleString()} → ${b.amount.toLocaleString()}. Reason: ${b.reason}`, link: '/tax?tab=overrides', entityType: 'payroll_cycle', entityId: cycle.id })
    return { ...o, complianceOfficers: officers.length }
  },

  async listOverrides(u: AccessUser, q: { status?: string; cycleId?: string }) {
    if (!has(u, 'payroll_admin') && !has(u, 'compliance_officer')) throw new AppError('Forbidden', 403)
    const rows = await prisma.taxOverride.findMany({ where: { tenantId: u.tenantId, ...(q.status && { status: q.status }), ...(q.cycleId && { cycleId: q.cycleId }) }, orderBy: { createdAt: 'desc' }, take: 200 })
    const emps = await prisma.employee.findMany({ where: { tenantId: u.tenantId, id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
    const cycles = await prisma.payrollCycle.findMany({ where: { tenantId: u.tenantId, id: { in: [...new Set(rows.map((r) => r.cycleId))] } }, select: { id: true, payPeriodStart: true } })
    const users = await prisma.user.findMany({ where: { tenantId: u.tenantId, id: { in: [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy ?? '']))] } }, select: { id: true, fullName: true } })
    const name = (id?: string | null) => users.find((x) => x.id === id)?.fullName ?? null
    return rows.map((r) => {
      const e = emps.find((x) => x.id === r.employeeId)
      return { ...r, originalAmount: Number(r.originalAmount), amount: Number(r.amount), employee: e ? `${e.firstName} ${e.lastName} (${e.employeeCode})` : '', period: cycles.find((c) => c.id === r.cycleId)?.payPeriodStart.toISOString().slice(0, 7) ?? '', requestedByName: name(r.requestedBy), decidedByName: name(r.decidedBy), mine: r.requestedBy === u.userId }
    })
  },

  async decideOverride(u: AccessUser, id: string, approve: boolean, note?: string) {
    if (!has(u, 'compliance_officer')) throw new AppError('A Compliance officer signs off tax overrides', 403)
    const o = await prisma.taxOverride.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!o) throw new AppError('Not found', 404)
    if (o.status !== 'pending') throw new AppError('Already decided', 400)
    if (o.requestedBy === u.userId) throw new AppError('The sign-off must come from someone other than the person who asked', 403)
    const cycle = await prisma.payrollCycle.findFirst({ where: { id: o.cycleId, tenantId: u.tenantId } })
    if (approve && cycle?.status !== 'review') throw new AppError('The run has moved on from review; Payroll must reopen it first', 400)
    const done = await prisma.taxOverride.updateMany({ where: { id: o.id, status: 'pending' }, data: { status: approve ? 'approved' : 'rejected', decidedBy: u.userId, decidedAt: new Date(), decisionNote: note ?? null } })
    if (!done.count) throw new AppError('Already decided', 400)
    if (approve) await applyOverride(o)
    await audit(u, approve ? 'TAX_OVERRIDE_APPROVED' : 'TAX_OVERRIDE_REJECTED', 'payroll_cycle', o.cycleId, { overrideId: o.id, note })
    await notify({ tenantId: u.tenantId, userIds: [o.requestedBy], type: 'tax.override_decided', title: approve ? 'Tax override signed off' : 'Tax override not approved', body: `${o.lineCode}: ${approve ? `now ${Number(o.amount).toLocaleString()}` : note || 'no reason given'}`, link: `/payroll/cycles/${o.cycleId}`, entityType: 'payroll_cycle', entityId: o.cycleId })
    return { ok: true }
  },
}

// Replaces the line's amount on the person's current payslip in the run and moves deductions and net pay by the
// difference. Also called after a re-run, for every override already signed off.
export async function applyOverride(o: { id: string; cycleId: string; employeeId: string; lineCode: string; amount: any; reason: string }) {
  const line = await prisma.payslipLine.findFirst({ where: { code: o.lineCode, category: 'TAX', payslip: { payrollCycleId: o.cycleId, employeeId: o.employeeId } }, include: { payslip: true } })
  if (!line) return
  const delta = round2(Number(o.amount) - Number(line.amount))
  await prisma.$transaction([
    prisma.payslipLine.update({ where: { id: line.id }, data: { amount: Number(o.amount), computationMethod: 'override', statutoryRef: `Override signed off by Compliance (${o.reason})`.slice(0, 300) } }),
    prisma.payslip.update({ where: { id: line.payslipId }, data: { totalDeductions: round2(Number(line.payslip.totalDeductions) + delta), netPay: round2(Number(line.payslip.netPay) - delta) } }),
  ])
}

export async function reapplyOverrides(cycleId: string) {
  for (const o of await prisma.taxOverride.findMany({ where: { cycleId, status: 'approved' } })) await applyOverride(o)
}

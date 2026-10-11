import crypto from 'crypto'
import { prisma } from '../../infrastructure/database/prisma'
import { dateOnly } from '../../shared/utils/businessDate'
import { ensureDefaults } from '../masters/masters.service'
import { employeeService } from './employees.service'
import { contractService } from './contracts.service'
import { parseDate } from './import.service'

// Spreadsheet imports for data that belongs to people already in the company, matched by employee ID (or work email).
// Same contract as the employee import: a dry run reports every row; the real run is all or nothing.
export const DATA_IMPORTS = {
  leave_balances: ['employee_id', 'leave_type', 'balance_days', 'used_days'],
  bank_details: ['employee_id', 'bank', 'account_number', 'ifsc_swift'],
  contracts: ['employee_id', 'wage_monthly', 'ctc_annual', 'currency', 'effective_from', 'effective_until', 'salary_structure', 'notice_days'],
} as const
export type DataImportType = keyof typeof DATA_IMPORTS
type Row = Record<string, string | undefined>
type Actor = { tenantId: string; userId: string }

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const num = (v: string | undefined) => (v && /^-?\d+(\.\d+)?$/.test(v.replace(/,/g, '')) ? Number(v.replace(/,/g, '')) : null)

export async function importData(actor: Actor, type: DataImportType, input: { rows: Row[]; dryRun: boolean }) {
  const t = actor.tenantId
  const people = await prisma.employee.findMany({ where: { tenantId: t, active: true }, select: { id: true, employeeCode: true, workEmail: true, firstName: true, lastName: true } })
  const byRef = new Map<string, (typeof people)[number]>()
  people.forEach((p) => { byRef.set(key(p.employeeCode), p); if (p.workEmail) byRef.set(key(p.workEmail), p) })

  // Lookups each type needs, loaded once
  const leaveTypes = type === 'leave_balances' ? await prisma.leaveType.findMany({ where: { tenantId: t, active: true }, select: { id: true, code: true, name: true } }) : []
  const banks = type === 'bank_details' ? (await ensureDefaults(t), await prisma.masterValue.findMany({ where: { tenantId: t, list: 'bank', active: true }, select: { code: true, label: true } })) : []
  const structures = type === 'contracts' ? await prisma.salaryStructure.findMany({ where: { tenantId: t, active: true }, select: { id: true, name: true } }) : []
  const openContracts = type === 'contracts'
    ? new Set((await prisma.employeeContract.findMany({ where: { active: true, status: { in: ['new', 'draft', 'confirmed', 'running'] }, employee: { tenantId: t } }, select: { employeeId: true } })).map((c) => c.employeeId))
    : new Set<string>()

  const seen = new Map<string, number>()
  const today = new Date().toISOString().slice(0, 10)
  const parsed = input.rows.map((raw, i) => {
    const r: Row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v ?? '').trim()]))
    const n = i + 2
    const errors: string[] = []
    const person = byRef.get(key(r.employee_id ?? ''))
    if (!person) errors.push(`no active employee with ID or email "${r.employee_id ?? ''}"`)
    let data: any = {}
    let dupKey = person?.id ?? `row${n}`

    if (type === 'leave_balances') {
      const lt = leaveTypes.find((x) => norm(x.code) === norm(r.leave_type ?? '') || norm(x.name) === norm(r.leave_type ?? ''))
      if (!lt) errors.push(`leave_type "${r.leave_type ?? ''}" is not one of your leave types`)
      const bal = num(r.balance_days), used = r.used_days ? num(r.used_days) : 0
      if (bal == null || bal < 0 || bal > 366) errors.push('balance_days must be a number from 0 to 366')
      if (used == null || used < 0 || (bal != null && used > bal)) errors.push('used_days must be a number from 0 to balance_days')
      dupKey += `|${lt?.id}`
      data = { leaveTypeId: lt?.id, balanceDays: bal, usedDays: used }
    } else if (type === 'bank_details') {
      const bank = banks.find((b) => norm(b.code) === norm(r.bank ?? '') || norm(b.label) === norm(r.bank ?? ''))
      if (!bank) errors.push(`bank "${r.bank ?? ''}" is not in your Bank list (Masters)`)
      const acct = (r.account_number ?? '').replace(/[\s-]/g, '')
      if (!/^\d{6,34}$/.test(acct)) errors.push('account_number must be 6 to 34 digits')
      if ((r.ifsc_swift ?? '').length > 20) errors.push('ifsc_swift is longer than 20 characters')
      data = { bankName: bank?.code, bankAccountNo: acct, bankIfscSwift: r.ifsc_swift || undefined }
    } else {
      const wage = num(r.wage_monthly), ctc = r.ctc_annual ? num(r.ctc_annual) : wage != null ? wage * 12 : null
      if (wage == null || wage <= 0) errors.push('wage_monthly must be a positive number')
      if (ctc == null || (wage != null && ctc < wage * 12)) errors.push('ctc_annual must be at least 12 × wage_monthly')
      const currency = (r.currency || '').toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) errors.push('currency must be a 3-letter code (ZMW, INR…)')
      const from = parseDate(r.effective_from ?? '')
      if (!from) errors.push('effective_from must be a date like 2026-10-01 or 01/10/2026')
      const until = r.effective_until ? parseDate(r.effective_until) : null
      if (r.effective_until && (!until || (from && until < from))) errors.push('effective_until must be a date after effective_from')
      const structure = r.salary_structure ? structures.find((s) => key(s.name) === key(r.salary_structure!)) : undefined
      if (r.salary_structure && !structure) errors.push(`no salary structure called "${r.salary_structure}"`)
      const notice = r.notice_days ? num(r.notice_days) : 30
      if (notice == null || notice < 0 || notice > 365 || !Number.isInteger(notice)) errors.push('notice_days must be a whole number of days')
      if (person && openContracts.has(person.id)) errors.push('already has an open contract; revise it from Compensation instead')
      data = { wageMonthly: wage, ctcAnnual: ctc, currency, effectiveFrom: from, effectiveUntil: until ?? undefined, salaryStructureId: structure?.id, noticePeriodDays: notice }
    }
    if (person && seen.has(dupKey)) errors.push(`same ${type === 'leave_balances' ? 'person and leave type' : 'person'} as row ${seen.get(dupKey)}`)
    else seen.set(dupKey, n)
    return { n, person, errors, data }
  })

  const result = {
    dryRun: input.dryRun, created: 0,
    rows: parsed.map((p) => ({ row: p.n, name: p.person ? `${p.person.firstName} ${p.person.lastName}` : '', employeeCode: p.person?.employeeCode ?? null, status: (p.errors.length ? 'error' : 'ok') as 'ok' | 'error' | 'created', errors: p.errors })),
  }
  if (input.dryRun || parsed.some((p) => p.errors.length)) return result

  if (type === 'leave_balances') {
    // ponytail: one upsert per row; fine for a few thousand rows, a single INSERT … ON CONFLICT if imports grow
    const asOfDate = dateOnly(today)
    await prisma.$transaction(parsed.map((p) => prisma.leaveBalance.upsert({
      where: { employeeId_leaveTypeId: { employeeId: p.person!.id, leaveTypeId: p.data.leaveTypeId } },
      create: { employeeId: p.person!.id, leaveTypeId: p.data.leaveTypeId, balanceDays: p.data.balanceDays, usedDays: p.data.usedDays, asOfDate },
      update: { balanceDays: p.data.balanceDays, usedDays: p.data.usedDays, asOfDate },
    })))
  } else if (type === 'bank_details') {
    for (const p of parsed) await employeeService.updateBank(p.person!.id, t, actor.userId, p.data) // encrypts and audits each; left unverified
  } else {
    for (const p of parsed) {
      const c = await contractService.create({ employeeId: p.person!.id, ...p.data, revisionReason: 'Imported' }, t, actor.userId)
      // Imported contracts describe pay already agreed: running from a past start date, confirmed (auto-activated) for a future one
      await prisma.employeeContract.update({ where: { id: c.id }, data: { status: p.data.effectiveFrom <= today ? 'running' : 'confirmed', stateChangedAt: new Date(), stateChangedBy: actor.userId } })
    }
  }
  result.rows.forEach((r) => { r.status = 'created' })
  result.created = parsed.length
  await prisma.auditLog.create({ data: { tenantId: t, userId: actor.userId, action: `IMPORTED_${type.toUpperCase()}`, entityType: 'employee', entityId: crypto.randomUUID(), newValue: { rows: parsed.length, employeeIds: parsed.map((p) => p.person!.id) } } })
  return result
}

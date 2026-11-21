import crypto from 'crypto'
import mongoose from 'mongoose'
import { runPayrollEngine, EngineExtraLine } from './payroll.engine'
import { PAYROLL_CONFIG } from './payroll.config'
import { statutoryContext, statutoryFor, indiaFyStart, indiaMonthsLeft, StatutoryContext } from '../tax/statutory'
import { enableMongoStatutory } from '../tax/statutory.mongo'
import { CreateCycleDto, AddPayrollInputDto } from './payroll.types'
import { AppError } from '../../shared/utils/AppError'
import { renderPayslipHtml, generatePayslipPdf } from './payslip.pdf'
import { formatBankFile, buildGlLines, formatGlCsv } from './payroll.export'
import { formatFor, renderBankFile, fileExt } from './bank-formats'
import { reapplyOverrides } from '../tax/tax-admin.service'
import { decryptField, last4 } from '../../shared/utils/crypto'
import {
  Tenant, User, Employee, EmployeeContract, SalaryStructure, ResourceCalendar, PayrollCycle, Payslip, PayrollInput, PayrollInputType, AuditLog, DomainEvent, Notification, LegalEntity, PayGroup,
} from '../../infrastructure/mongo/mongo'

// MongoDB version of payroll.service.ts / payroll.repository.ts: cycles, lock, run, variance report, the two-approver flow with
// System admin sign-off, disburse, inputs, payslip release and hold, payslip access and PDF, the bank file and the GL journal.
// Payslips carry their lines and worked days inside the document. Same rules, same response shapes; the engine and the
// statutory calculators are the unchanged ones.
// ponytail: not ported yet (each is a separate piece): off-cycle runs and corrections, flexi baskets, tax overrides, India tax
// declaration exemptions, custom bank layouts (generic CSV only), and publishing events to the queue (recorded in domain_events).
// Leave, attendance, overtime and reimbursements are read from their collections as raw documents, so payroll picks them up as
// soon as those modules are ported; until then they are simply empty.

enableMongoStatutory()

const PAYROLL_STAFF_ROLES = ['payroll_admin', 'compliance_officer']
const dstr = (d: Date) => d.toISOString().slice(0, 10)
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`)
const maxStr = (...a: string[]) => a.reduce((x, y) => (x > y ? x : y))
const minStr = (...a: string[]) => a.reduce((x, y) => (x < y ? x : y))
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }
const col = (n: string) => mongoose.connection.collection(n)
const audit = (a: Record<string, unknown>) => AuditLog.create(a)
const event = (tenantId: string, type: string, payload: object) => DomainEvent.create({ tenantId, type, payload, status: 'pending' })

function eachDay(start: string, end: string): string[] {
  const out: string[] = []
  const cur = toDate(start), last = toDate(end)
  while (cur <= last) { out.push(dstr(cur)); cur.setUTCDate(cur.getUTCDate() + 1) }
  return out
}
const isWorking = (day: string, cal: Set<number>) => cal.has((toDate(day).getUTCDay() + 6) % 7)

type SkipReason = { employeeId: string; employeeCode: string; name: string; reason: string }

const cycleView = async (c: any) => c && { ...ser(c), _count: { payslips: await Payslip.countDocuments({ payrollCycleId: c._id }) } }

async function totalsOf(cycleId: string) {
  const [r]: any[] = await Payslip.aggregate([{ $match: { payrollCycleId: cycleId } }, { $group: { _id: null, gross: { $sum: '$grossEarnings' }, ded: { $sum: '$totalDeductions' }, net: { $sum: '$netPay' }, n: { $sum: 1 } } }])
  return { count: r?.n ?? 0, gross: round2(r?.gross ?? 0), deductions: round2(r?.ded ?? 0), net: round2(r?.net ?? 0) }
}

export async function signoffThreshold(tenantId: string) {
  const t: any = await Tenant.findById(tenantId).select('payrollSignoffAbove').lean()
  return t?.payrollSignoffAbove == null ? null : Number(t.payrollSignoffAbove.toString())
}
async function needsSignoff(cycleId: string, tenantId: string) {
  const threshold = await signoffThreshold(tenantId)
  return threshold != null && (await totalsOf(cycleId)).net > threshold
}

async function getCycleOrThrow(cycleId: string, tenantId: string) {
  const cycle: any = await PayrollCycle.findOne({ _id: cycleId, tenantId }).lean()
  if (!cycle) throw new AppError('Payroll cycle not found', 404)
  return cycleView(cycle) as Promise<any>
}

const userIdsWithRole = async (tenantId: string, role: string) => ((await User.find({ tenantId, active: true, 'userRoles.roleName': role }).select('_id').lean()) as any[]).map((u) => u._id as string)
const notifyUsers = (tenantId: string, userIds: string[], n: { type: string; title: string; body: string; link: string; entityType?: string; entityId?: string }) =>
  userIds.length ? Notification.insertMany(userIds.map((userId) => ({ _id: crypto.randomUUID(), tenantId, userId, ...n, read: false }))) : null

// ─── Reading what a payslip run needs ───
async function contractForPeriod(employeeId: string, start: Date, end: Date) {
  const c: any = await EmployeeContract.findOne({
    employeeId, active: true, status: { $in: ['running', 'expired'] }, effectiveFrom: { $lte: end },
    $or: [{ effectiveUntil: null }, { effectiveUntil: { $exists: false } }, { effectiveUntil: { $gte: start } }],
  }).sort({ effectiveFrom: -1 }).lean()
  if (!c) return null
  const s: any = c.salaryStructureId ? await SalaryStructure.findById(c.salaryStructureId).lean() : null
  const rules = s ? (s.rules || []).filter((r: any) => r.active).sort((a: any, b: any) => a.sequence - b.sequence).map((r: any) => ({ ...ser(r), category: { code: r.categoryCode } })) : []
  return { ...ser(c), salaryStructure: s && { ...ser({ ...s, rules: undefined }), rules } }
}

const rawFind = (name: string, filter: object) => col(name).find(filter as any).toArray() as Promise<any[]>

// Also used by the F&F settlement (exits module) for the prorated last month
export async function computeEmployeePayslip(emp: any, cycle: any, cycleInputs: any[], inputCodes: string[]): Promise<{ skip?: string; payslip?: any; warnings: string[]; basicMonthly?: number }> {
  const warnings: string[] = []
  const periodStart = dstr(cycle.payPeriodStart), periodEnd = dstr(cycle.payPeriodEnd)
  const calDays = new Set<number>(emp.resourceCalendar?.days?.length ? emp.resourceCalendar.days.map((d: any) => d.dayOfWeek) : PAYROLL_CONFIG.DEFAULT_WORKING_DAYS)
  const periodWorking = eachDay(periodStart, periodEnd).filter((d) => isWorking(d, calDays))
  if (periodWorking.length === 0) return { skip: 'No working days in period', warnings }

  const contract: any = await contractForPeriod(emp.id, cycle.payPeriodStart, cycle.payPeriodEnd)
  if (!contract) return { skip: 'No running contract covering this period', warnings }
  if (!contract.salaryStructure) return { skip: 'Contract has no salary structure linked', warnings }

  const windowStart = maxStr(periodStart, dstr(contract.effectiveFrom), dstr(emp.hireDate))
  const windowEnd = minStr(periodEnd, contract.effectiveUntil ? dstr(contract.effectiveUntil) : periodEnd, emp.exitDate ? dstr(emp.exitDate) : periodEnd)
  if (windowStart > windowEnd) return { skip: 'Employment window does not overlap the pay period', warnings }
  const windowWorking = eachDay(windowStart, windowEnd).filter((d) => isWorking(d, calDays))

  // ─── LWP + paid leave ───
  const lwpByDay = new Map<string, number>()
  let paidLeaveDays = 0
  const leaves = await rawFind('leave_requests', { employeeId: emp.id, status: 'approved', startDate: { $lte: toDate(windowEnd) }, endDate: { $gte: toDate(windowStart) } })
  const leaveTypes = new Map<string, any>((await rawFind('leave_types', { _id: { $in: leaves.map((l) => l.leaveTypeId) } as any })).map((t) => [t._id as any, t]))
  for (const lr of leaves) {
    const s = dstr(lr.startDate), e = dstr(lr.endDate)
    const isPaid = leaveTypes.get(lr.leaveTypeId)?.isPaid ?? true
    for (const day of eachDay(maxStr(s, windowStart), minStr(e, windowEnd))) {
      if (!isWorking(day, calDays)) continue
      let v = 1
      if (lr.hours) v = lr.totalDays
      else if (s === e && (lr.startHalf || lr.endHalf)) v = 0.5
      else { if (day === s && lr.startHalf) v -= 0.5; if (day === e && lr.endHalf) v -= 0.5 }
      const lwpShare = !isPaid ? 1 : lr.totalDays > 0 ? Math.min(1, (lr.lwpDays ?? 0) / lr.totalDays) : 0
      if (lwpShare > 0) lwpByDay.set(day, Math.max(lwpByDay.get(day) ?? 0, v * lwpShare))
      paidLeaveDays += v * (1 - lwpShare)
    }
  }

  const attendance = await rawFind('attendance_records', { employeeId: emp.id, date: { $gte: toDate(windowStart), $lte: toDate(windowEnd) } })
  if (attendance.length === 0) warnings.push('No attendance records in the pay window — treated as fully paid')
  for (const r of attendance) {
    const day = dstr(r.date)
    if (day < windowStart || day > windowEnd || !isWorking(day, calDays)) continue
    if (r.status === 'absent' && r.source === 'auto' && r.checkInTime && !r.checkOutTime) warnings.push(`${day}: clock-in without clock-out was marked absent — NOT deducted. Regularise or override before approving.`)
    else if (r.status === 'absent' || r.status === 'lwp') lwpByDay.set(day, Math.max(lwpByDay.get(day) ?? 0, 1))
    else if (r.status === 'half_day') lwpByDay.set(day, Math.max(lwpByDay.get(day) ?? 0, PAYROLL_CONFIG.HALF_DAY_LWP_FACTOR))
  }

  const lwpDays = round2(Array.from(lwpByDay.values()).reduce((a, b) => a + b, 0))
  const paidDays = Math.max(0, round2(windowWorking.length - lwpDays))
  const factor = Math.min(1, paidDays / periodWorking.length)
  const fullWage = contract.wageMonthly
  const proratedWage = round2(fullWage * factor)

  // ─── Extra lines: overtime + approved inputs ───
  const extraLines: EngineExtraLine[] = []
  const hourlyRate = fullWage / (periodWorking.length * PAYROLL_CONFIG.STANDARD_HOURS_PER_DAY)
  let overtimeHours = 0
  for (const ot of await rawFind('overtime_requests', { employeeId: emp.id, status: 'approved', date: { $gte: toDate(windowStart), $lte: toDate(windowEnd) } })) {
    const rate = ot.approvedRate ?? 1.5
    overtimeHours += ot.overtimeHours
    extraLines.push({ code: 'OVERTIME', name: `Overtime ${dstr(ot.date)} (${ot.overtimeHours}h × ${rate})`, categoryCode: 'ALW', amount: round2(ot.overtimeHours * hourlyRate * rate), computationMethod: 'overtime', sourceRefType: 'overtime_request', sourceRefId: ot._id })
  }
  const inputsByCode: Record<string, number> = {}
  for (const code of inputCodes) inputsByCode[code] = 0
  for (const inp of cycleInputs.filter((i) => i.employeeId === emp.id)) {
    if (!inp.approvedBy) { warnings.push(`Payroll input "${inp.inputType.name}" (${inp.amount}) is not approved and was ignored`); continue }
    inputsByCode[inp.inputType.code] = round2((inputsByCode[inp.inputType.code] ?? 0) + inp.amount)
    extraLines.push({ code: inp.inputType.code, name: inp.description ? `${inp.inputType.name} — ${inp.description}` : inp.inputType.name, categoryCode: inp.inputType.category === 'deductions' ? 'DED' : 'ALW', amount: inp.amount, computationMethod: 'payroll_input', sourceRefType: 'payroll_input', sourceRefId: inp.id })
  }

  // ─── Approved reimbursements (paid after tax) ───
  const reimbursementLines: { claimId: string; categoryName: string; expenseDate: string; amount: number }[] = []
  const claims = await rawFind('reimbursement_claims', { employeeId: emp.id, status: 'finance_approved', paidInCycleId: null })
  const cats = new Map<string, any>((await rawFind('expense_categories', { _id: { $in: claims.map((c) => c.categoryId) } as any })).map((c) => [c._id as any, c]))
  for (const cl of claims.sort((a, b) => +a.expenseDate - +b.expenseDate)) {
    const catName = cats.get(cl.categoryId)?.name ?? 'Expense'
    if (cl.homeCurrency !== contract.currency) { warnings.push(`Reimbursement of ${cl.homeAmount} ${cl.homeCurrency} (${catName}, ${dstr(cl.expenseDate)}) was not paid: its currency differs from the contract currency (${contract.currency})`); continue }
    reimbursementLines.push({ claimId: cl._id, categoryName: catName, expenseDate: dstr(cl.expenseDate), amount: cl.homeAmount })
  }

  // ─── Statutory tables for the period; India TDS also needs this financial year's pay and tax so far ───
  const statutory: StatutoryContext = { at: periodEnd, ...(await statutoryContext(periodEnd, emp.tenantId)) }
  if (contract.salaryStructure.rules.some((r: any) => /compute_india_tds/.test(`${r.pythonCode ?? ''}`))) {
    const priorCycles: any[] = await PayrollCycle.find({ tenantId: cycle.tenantId, _id: { $ne: cycle.id }, payPeriodStart: { $gte: toDate(indiaFyStart(periodStart)), $lt: cycle.payPeriodStart } }).select('_id').lean()
    const prior: any[] = await Payslip.find({ employeeId: emp.id, payrollCycleId: { $in: priorCycles.map((c) => c._id) } }).lean()
    statutory.indiaYtd = {
      gross: round2(prior.reduce((a, p) => a + p.grossEarnings, 0)),
      tax: round2(prior.reduce((a, p) => a + p.lines.filter((l: any) => l.category === 'TAX').reduce((b: number, l: any) => b + l.amount, 0), 0)),
      monthsLeft: indiaMonthsLeft(periodStart),
      exemption: 0, // ponytail: tax declaration exemptions are ported with the tax stage
    }
  }

  const engineRules = (extra: object = {}) => contract.salaryStructure.rules.map((r: any) => ({
    id: r.id, code: r.code, name: r.name, sequence: r.sequence, categoryCode: r.category.code, amountType: r.amountType, amountFixed: r.amountFixed, amountPercentage: r.amountPercentage,
    amountPercentageBase: r.amountPercentageBase, pythonCode: r.pythonCode, conditionSelect: r.conditionSelect, conditionExpr: r.conditionExpr, appearsOnPayslip: r.appearsOnPayslip, ...extra,
  }))
  const result = runPayrollEngine({
    rules: engineRules(), contract: { wageMonthly: proratedWage, fullWageMonthly: fullWage, ctcAnnual: contract.ctcAnnual, variablePayPercent: contract.variablePayPercent },
    factor, workingDays: periodWorking.length, paidDays, lwpDays, extraLines, inputsByCode, reimbursementLines, statutory,
  } as any)
  warnings.push(...result.warnings)
  const fullMonth = runPayrollEngine({
    rules: engineRules(), contract: { wageMonthly: fullWage, fullWageMonthly: fullWage, ctcAnnual: contract.ctcAnnual, variablePayPercent: contract.variablePayPercent },
    factor: 1, workingDays: periodWorking.length, paidDays: periodWorking.length, lwpDays: 0, extraLines: [], inputsByCode, statutory,
  } as any)

  const payLines: any[] = result.lines // ponytail: flexi baskets (applyFlexi) are not ported yet
  const basicNow = result.lines.filter((l: any) => l.categoryCode === 'BASIC').reduce((a: number, l: any) => a + l.amount, 0)
  const shareWarn = await basicShareWarning(emp.tenantId, emp, basicNow, result.gross)
  if (shareWarn) warnings.push(shareWarn)
  if (cycle.tenantId && (!emp.bankName || !emp.bankAccountNo)) warnings.push('No bank details: the bank file will leave this person out. HR adds them on the person’s profile.')
  else if (cycle.tenantId && !emp.bankVerified) warnings.push('Bank details not verified yet: the bank file will leave this person out until a second person verifies them.')
  const workDays = Math.max(0, round2(windowWorking.length - lwpDays - paidLeaveDays))
  const h = PAYROLL_CONFIG.STANDARD_HOURS_PER_DAY

  const payslip = {
    tenantId: cycle.tenantId, payrollCycleId: cycle.id, employeeId: emp.id, salaryStructureId: contract.salaryStructureId, contractId: contract.id,
    grossEarnings: result.gross, totalDeductions: result.totalDeductions, netPay: result.netPay, currency: contract.currency,
    workingDays: periodWorking.length, paidDays, lwpDays, status: 'draft',
    lines: payLines.map((l: any) => ({ salaryRuleId: l.ruleId ?? null, category: l.categoryCode, name: l.name, code: l.code, sequence: l.sequence, amount: l.amount, quantity: 1, rate: 1, computationMethod: l.computationMethod, formulaUsed: l.formulaUsed ?? null, sourceRefType: l.sourceRefType ?? null, sourceRefId: l.sourceRefId ?? null, statutoryRef: l.statutoryRef ?? null })),
    workedDays: [
      { dayType: 'work_days', numberOfDays: workDays, numberOfHours: workDays * h }, { dayType: 'paid_leave', numberOfDays: round2(paidLeaveDays), numberOfHours: round2(paidLeaveDays * h) },
      { dayType: 'lwp', numberOfDays: lwpDays, numberOfHours: round2(lwpDays * h) }, { dayType: 'overtime', numberOfDays: 0, numberOfHours: round2(overtimeHours) },
    ],
  }
  return { payslip, warnings, basicMonthly: fullMonth.categories.BASIC }
}

// A payroll warning when basic pay is below the country's minimum share of gross (India: 50%)
async function basicShareWarning(tenantId: string, emp: any, basic: number, gross: number) {
  const tenant: any = await Tenant.findById(tenantId).select('primaryCountry').lean()
  const country = emp.taxJurisdiction ?? tenant?.primaryCountry
  const t = country && (await statutoryFor(new Date().toISOString().slice(0, 10), tenantId))[`${country}_MIN_WAGE`]
  if (t?.minBasicShare && gross > 0 && basic / gross < t.minBasicShare) return `Basic pay is ${Math.round((basic / gross) * 100)}% of gross, below the ${t.minBasicShare * 100}% minimum for ${country}`
  return null
}

const payslipView = async (docs: any[]) => {
  const emps = new Map<string, any>(((await Employee.find({ _id: { $in: docs.map((p) => p.employeeId) } }).select('employeeCode firstName lastName bankName bankAccountNo bankVerified bankIfscSwift tenantId').lean()) as any[]).map((e) => [e._id, e]))
  return docs.map((p) => ({ ...ser(p), lines: p.lines.map(ser), workedDays: p.workedDays.map(ser), employee: ser(emps.get(p.employeeId)) }))
}

export const payrollService = {
  // ─── CYCLES ───
  async createCycle(tenantId: string, userId: string, dto: CreateCycleDto) {
    if (dto.payPeriodStart > dto.payPeriodEnd) throw new AppError('Pay period start must be on or before the end date', 400)
    if (dto.offCycle || dto.correctsCycleId) throw new AppError('Off-cycle runs and corrections are not available on the MongoDB version yet', 501)
    if (dto.legalEntityId && !(await LegalEntity.exists({ _id: dto.legalEntityId, tenantId, active: true }))) throw new AppError('Legal entity not found', 404)
    if (dto.payGroupId && !(await PayGroup.exists({ _id: dto.payGroupId, tenantId, active: true }))) throw new AppError('Pay group not found', 404)
    const start = toDate(dto.payPeriodStart), end = toDate(dto.payPeriodEnd)
    // A run for everyone overlaps any run; an entity's run overlaps that entity's runs and runs for everyone
    const overlap: any = await PayrollCycle.findOne({ tenantId, offCycle: false, payPeriodStart: { $lte: end }, payPeriodEnd: { $gte: start },
      $and: [...(dto.legalEntityId ? [{ $or: [{ legalEntityId: null }, { legalEntityId: { $exists: false } }, { legalEntityId: dto.legalEntityId }] }] : []), ...(dto.payGroupId ? [{ $or: [{ payGroupId: null }, { payGroupId: { $exists: false } }, { payGroupId: dto.payGroupId }] }] : [])] }).lean()
    if (overlap) throw new AppError(`This period overlaps an existing cycle (${dstr(overlap.payPeriodStart)} to ${dstr(overlap.payPeriodEnd)}, ${overlap.status})`, 409)
    const cycle: any = (await PayrollCycle.create({ tenantId, payPeriodStart: start, payPeriodEnd: end, cycleType: dto.cycleType || 'monthly', offCycle: false, legalEntityId: dto.legalEntityId ?? undefined, payGroupId: dto.payGroupId ?? undefined, status: 'draft' })).toObject()
    await audit({ tenantId, userId, action: 'PAYROLL_CYCLE_CREATED', entityType: 'payroll_cycle', entityId: cycle._id, newValue: dto })
    return cycleView(cycle)
  },

  async listCycles(tenantId: string) {
    const rows: any[] = await PayrollCycle.find({ tenantId }).sort({ payPeriodStart: -1 }).lean()
    const counts: any[] = await Payslip.aggregate([{ $match: { tenantId } }, { $group: { _id: '$payrollCycleId', n: { $sum: 1 } } }])
    const C = new Map(counts.map((c) => [c._id, c.n]))
    return rows.map((c) => ({ ...ser(c), _count: { payslips: C.get(c._id) ?? 0 } }))
  },

  async getCycle(cycleId: string, tenantId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    const [totals, payrollAdmins, threshold, adjustments] = await Promise.all([
      totalsOf(cycleId), User.countDocuments({ tenantId, active: true, 'userRoles.roleName': 'payroll_admin' }), signoffThreshold(tenantId),
      col('attendance_adjustments').countDocuments({ tenantId, appliedCycleId: null, date: { $lt: cycle.payPeriodStart } }),
    ])
    return { ...cycle, payrollAdmins, attendanceAdjustments: adjustments, signoffThreshold: threshold, signoffRequired: threshold != null && totals.net > threshold, totals: { payslips: totals.count, gross: totals.gross, deductions: totals.deductions, net: totals.net } }
  },

  async listCyclePayslips(cycleId: string, tenantId: string) {
    await getCycleOrThrow(cycleId, tenantId)
    const docs: any[] = await Payslip.find({ payrollCycleId: cycleId }).lean()
    const views: any[] = await payslipView(docs)
    return views.map(({ lines, workedDays, ...p }) => {
      const { bankAccountNo, ...emp } = p.employee ?? {}
      return { ...p, employee: { ...emp, hasBankAccount: !!bankAccountNo }, hasManualInputs: lines.some((l: any) => l.sourceRefType === 'payroll_input') }
    }).sort((a, b) => String(a.employee?.employeeCode).localeCompare(String(b.employee?.employeeCode)))
  },

  async lockAttendance(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (cycle.status !== 'draft') throw new AppError(`Cannot lock attendance — cycle is ${cycle.status}`, 400)
    const empIds = ((await Employee.find({ tenantId }).select('_id').lean()) as any[]).map((e) => e._id)
    const locked = await col('attendance_records').updateMany({ employeeId: { $in: empIds }, date: { $gte: cycle.payPeriodStart, $lte: cycle.payPeriodEnd }, isLocked: { $ne: true } } as any, { $set: { isLocked: true } })
    await PayrollCycle.updateOne({ _id: cycleId }, { attendanceLockedAt: new Date() })
    await audit({ tenantId, userId, action: 'PAYROLL_ATTENDANCE_LOCKED', entityType: 'payroll_cycle', entityId: cycleId, newValue: { recordsLocked: locked.modifiedCount } })
    await event(tenantId, 'attendance.locked', { payrollCycleId: cycleId, lockedBy: userId, recordsLocked: locked.modifiedCount })
    return { message: 'Attendance locked for this pay period', recordsLocked: locked.modifiedCount }
  },

  async runCycle(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (!['draft', 'review'].includes(cycle.status)) throw new AppError(`Cycle is ${cycle.status} and cannot be re-run. Use reopen if it is approved but not disbursed.`, 400)
    if (!cycle.attendanceLockedAt && !cycle.offCycle) throw new AppError('Lock attendance for this pay period before running payroll', 400)
    // claim the run: only one request can move the cycle into 'processing'
    const claimed = await PayrollCycle.updateOne({ _id: cycleId, tenantId, status: { $in: ['draft', 'review'] } }, { status: 'processing' })
    if (!claimed.modifiedCount) throw new AppError('This run is already being processed', 409)
    await event(tenantId, 'payroll.cycle.started', { payrollCycleId: cycleId, startedBy: userId })

    const skipped: SkipReason[] = []
    const warningsByEmployee: Record<string, string[]> = {}
    let processed = 0
    try {
      await Payslip.deleteMany({ payrollCycleId: cycleId })
      const empDocs: any[] = await Employee.find({ tenantId, active: true, employmentStatus: { $ne: 'terminated' }, ...(cycle.legalEntityId && { legalEntityId: cycle.legalEntityId }), ...(cycle.payGroupId && { payGroupId: cycle.payGroupId }) }).sort({ employeeCode: 1 }).lean()
      const calendars = new Map<string, any>(((await ResourceCalendar.find({ _id: { $in: empDocs.map((e) => e.resourceCalendarId).filter(Boolean) } }).lean()) as any[]).map((c) => [c._id, c]))
      const employees = empDocs.map((e) => ({ ...ser(e), resourceCalendar: calendars.get(e.resourceCalendarId) ?? null }))
      const cycleInputs = await this.listInputs(cycleId, tenantId)
      const inputCodes = ((await PayrollInputType.find({ tenantId, active: true }).select('code').lean()) as any[]).map((t) => t.code)
      const exits = await rawFind('employee_exits', { tenantId, status: { $ne: 'cancelled' }, lastWorkingDate: { $lte: cycle.payPeriodEnd } })
      const exitByEmployee = new Map(exits.map((x) => [x.employeeId, dstr(x.lastWorkingDate)]))

      const one = async (emp: any) => {
        const name = `${emp.firstName} ${emp.lastName}`
        const exitDay = exitByEmployee.get(emp.id)
        if (exitDay) { skipped.push({ employeeId: emp.id, employeeCode: emp.employeeCode, name, reason: `Exiting on ${exitDay}: paid through the full & final settlement` }); return }
        try {
          const out = await computeEmployeePayslip(emp, cycle, cycleInputs, inputCodes)
          if (out.skip) { skipped.push({ employeeId: emp.id, employeeCode: emp.employeeCode, name, reason: out.skip }); return }
          await Payslip.create(out.payslip)
          processed++
          if (out.warnings.length) warningsByEmployee[`${emp.employeeCode} ${name}`] = out.warnings
        } catch (err: any) { skipped.push({ employeeId: emp.id, employeeCode: emp.employeeCode, name, reason: err.message }) }
      }
      // ponytail: fixed pool of PAYROLL_CONCURRENCY (default 8); a queue job with progress if runs ever exceed a few minutes
      const pool = Math.max(1, Number(process.env.PAYROLL_CONCURRENCY) || 8)
      let next = 0
      await Promise.all(Array.from({ length: Math.min(pool, employees.length) }, async () => { while (next < employees.length) await one(employees[next++]) }))
      await reapplyOverrides(cycleId) // tax overrides already signed off survive a re-run
      await PayrollCycle.updateOne({ _id: cycleId }, { status: 'review' })
    } catch (err) {
      await PayrollCycle.updateOne({ _id: cycleId }, { status: 'draft' })
      throw err
    }
    const totals = await totalsOf(cycleId)
    await audit({ tenantId, userId, action: 'PAYROLL_CYCLE_RUN', entityType: 'payroll_cycle', entityId: cycleId, newValue: { processed, skipped: skipped.length } })
    return { status: 'review', processed, skipped, warnings: warningsByEmployee, totals: { gross: totals.gross, deductions: totals.deductions, net: totals.net } }
  },

  // ─── VARIANCE REPORT ───
  async getVarianceReport(cycleId: string, tenantId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    const current: any[] = await payslipView(await Payslip.find({ payrollCycleId: cycleId }).lean())
    const prevCycle: any = await PayrollCycle.findOne({ tenantId, payPeriodEnd: { $lt: cycle.payPeriodStart } }).sort({ payPeriodEnd: -1 }).lean()
    const previous: any[] = prevCycle ? await payslipView(await Payslip.find({ payrollCycleId: prevCycle._id }).lean()) : []
    const rows = current.map((ps) => {
      const prev = previous.find((p) => p.employeeId === ps.employeeId)
      const flags: string[] = []
      let changePct: number | null = null
      if (!prev) { if (prevCycle) flags.push('new_in_cycle') }
      else if (prev.netPay !== 0) { changePct = round2(((ps.netPay - prev.netPay) / prev.netPay) * 100); if (Math.abs(changePct) > PAYROLL_CONFIG.VARIANCE_THRESHOLD * 100) flags.push('net_change_over_threshold') }
      if (ps.lwpDays > 0) flags.push('lwp_days')
      if (ps.netPay < 0) flags.push('negative_net')
      if (!(ps.grossEarnings > 0)) flags.push('zero_gross')
      if (!ps.employee.bankName || !ps.employee.bankAccountNo) flags.push('no_bank_details')
      else if (!ps.employee.bankVerified) flags.push('bank_unverified')
      const tax = ps.lines.filter((l: any) => l.category === 'TAX').reduce((s: number, l: any) => s + l.amount, 0)
      if (ps.grossEarnings > 0 && tax / ps.grossEarnings > 0.45) flags.push('tax_over_45_percent')
      if (ps.lines.some((l: any) => l.sourceRefType === 'payroll_input')) flags.push('manual_input')
      return { employeeId: ps.employeeId, employeeCode: ps.employee.employeeCode, name: `${ps.employee.firstName} ${ps.employee.lastName}`, netPay: ps.netPay, previousNetPay: prev?.netPay ?? null, changePct, lwpDays: ps.lwpDays, flags }
    })
    const missing = previous.filter((p) => !current.some((c) => c.employeeId === p.employeeId)).map((p) => ({ employeeId: p.employeeId, employeeCode: p.employee.employeeCode, name: `${p.employee.firstName} ${p.employee.lastName}`, flags: ['missing_from_cycle'] }))
    const unapprovedInputs = await PayrollInput.countDocuments({ payrollCycleId: cycleId, approvedBy: { $in: [null, undefined] } })
    return { cycleId, unapprovedInputs, previousCycleId: prevCycle?._id ?? null, thresholdPct: PAYROLL_CONFIG.VARIANCE_THRESHOLD * 100, flaggedCount: rows.filter((r) => r.flags.length > 0).length + missing.length, rows, missing }
  },

  // ─── APPROVAL FLOW (each step is one filtered update, so two requests cannot both win) ───
  async approve(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (cycle.status !== 'review') throw new AppError(`Cycle must be in review to approve (currently ${cycle.status})`, 400)
    if (cycle._count.payslips === 0) throw new AppError('No payslips to approve', 400)
    const negative = await Payslip.countDocuments({ payrollCycleId: cycleId, netPay: { $lt: 0 } })
    if (negative) throw new AppError(`${negative} payslip${negative === 1 ? ' has' : 's have'} negative net pay; fix them and re-run before approving`, 400)
    const r = await PayrollCycle.updateOne({ _id: cycleId, tenantId, status: 'review' }, { status: 'approved', approvedBy: userId, approvedAt: new Date() })
    if (!r.modifiedCount) throw new AppError('This run was changed by someone else. Reload it.', 409)
    await Payslip.updateMany({ payrollCycleId: cycleId }, { status: 'approved' })
    await audit({ tenantId, userId, action: 'PAYROLL_CYCLE_APPROVED', entityType: 'payroll_cycle', entityId: cycleId })
    return getCycleOrThrow(cycleId, tenantId)
  },

  async financeApprove(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (cycle.status !== 'approved' || !cycle.approvedBy) throw new AppError('The first approval is needed before the second', 400)
    if (cycle.financeApprovedBy) throw new AppError('Cycle is already finance-approved', 400)
    if (cycle.approvedBy === userId) throw new AppError('The second approval must come from a different Payroll admin than the first. If you are the only Payroll admin, give a second person the role in Login & access.', 403)
    const r = await PayrollCycle.updateOne({ _id: cycleId, tenantId, status: 'approved', financeApprovedBy: { $in: [null, undefined] } }, { financeApprovedBy: userId, financeApprovedAt: new Date() })
    if (!r.modifiedCount) throw new AppError('Cycle is already finance-approved', 400)
    if (await needsSignoff(cycleId, tenantId)) {
      const admins = (await userIdsWithRole(tenantId, 'system_admin')).filter((x) => x !== userId && x !== cycle.approvedBy)
      await notifyUsers(tenantId, admins, { type: 'payroll.signoff', title: 'A payroll needs your sign-off', body: `${dstr(cycle.payPeriodStart).slice(0, 7)} is above the sign-off amount`, link: '/approvals?tab=signoff', entityType: 'payroll_cycle', entityId: cycleId })
    }
    await audit({ tenantId, userId, action: 'PAYROLL_CYCLE_FINANCE_APPROVED', entityType: 'payroll_cycle', entityId: cycleId })
    return getCycleOrThrow(cycleId, tenantId)
  },

  // Cycles waiting for sign-off: totals only (a System admin does not see individual pay)
  async signoffList(tenantId: string) {
    const threshold = await signoffThreshold(tenantId)
    if (threshold == null) return { threshold, cycles: [] }
    const cycles: any[] = await PayrollCycle.find({ tenantId, status: 'approved', financeApprovedBy: { $ne: null }, signoffBy: { $in: [null, undefined] } }).sort({ payPeriodStart: 1 }).lean()
    const tenant: any = await Tenant.findById(tenantId).select('baseCurrency').lean()
    const out = []
    for (const c of cycles) {
      const t = await totalsOf(c._id)
      if (t.net > threshold) out.push({ id: c._id, period: dstr(c.payPeriodStart).slice(0, 7), people: t.count, gross: t.gross, net: t.net, currency: tenant?.baseCurrency })
    }
    return { threshold, cycles: out }
  },

  async signoff(cycleId: string, tenantId: string, userId: string) {
    const c = await getCycleOrThrow(cycleId, tenantId)
    if (c.status !== 'approved' || !c.financeApprovedBy) throw new AppError('Both Payroll approvals come first', 400)
    if (c.signoffBy) throw new AppError('Already signed off', 400)
    if ([c.approvedBy, c.financeApprovedBy].includes(userId)) throw new AppError('The sign-off must come from someone other than the two approvers', 403)
    const done = await PayrollCycle.updateOne({ _id: cycleId, tenantId, signoffBy: { $in: [null, undefined] } }, { signoffBy: userId, signoffAt: new Date() })
    if (!done.modifiedCount) throw new AppError('Someone else just signed it off', 409)
    await audit({ tenantId, userId, action: 'PAYROLL_SIGNED_OFF', entityType: 'payroll_cycle', entityId: cycleId })
    return { signedOff: true }
  },

  async reopen(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (cycle.status !== 'approved') throw new AppError('Only approved (not yet disbursed) cycles can be reopened', 400)
    const r = await PayrollCycle.updateOne({ _id: cycleId, tenantId, status: 'approved' }, { $set: { status: 'review' }, $unset: { approvedBy: 1, approvedAt: 1, financeApprovedBy: 1, financeApprovedAt: 1, signoffBy: 1, signoffAt: 1 } })
    if (!r.modifiedCount) throw new AppError('This run was changed by someone else. Reload it.', 409)
    await Payslip.updateMany({ payrollCycleId: cycleId }, { status: 'draft' })
    await audit({ tenantId, userId, action: 'PAYROLL_CYCLE_REOPENED', entityType: 'payroll_cycle', entityId: cycleId, oldValue: { approvedBy: cycle.approvedBy, financeApprovedBy: cycle.financeApprovedBy } })
    return getCycleOrThrow(cycleId, tenantId)
  },

  async disburse(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (cycle.status !== 'approved') throw new AppError(`Cycle must be approved to disburse (currently ${cycle.status})`, 400)
    if (!cycle.approvedBy || !cycle.financeApprovedBy) throw new AppError('Both approvals (two different Payroll admins) are required before disbursement', 400)
    if (!cycle.signoffBy && (await needsSignoff(cycleId, tenantId))) throw new AppError('This payroll is above the sign-off amount: a System admin must sign it off first', 400)

    const slips: any[] = await Payslip.find({ payrollCycleId: cycleId }).select('lines').lean()
    const claimIds = [...new Set(slips.flatMap((s) => s.lines).filter((l: any) => l.sourceRefType === 'reimbursement_claim' && l.sourceRefId).map((l: any) => l.sourceRefId as string))]
    if (claimIds.length && (await col('reimbursement_claims').countDocuments({ _id: { $in: claimIds }, $or: [{ status: 'paid' }, { paidInCycleId: { $ne: null } }] } as any)) > 0) throw new AppError('Reimbursement already paid in another cycle — re-run this cycle', 409)

    const now = new Date()
    const session = await mongoose.startSession()
    try {
      await session.withTransaction(async () => {
        const r = await PayrollCycle.updateOne({ _id: cycleId, tenantId, status: 'approved' }, { status: 'disbursed', disbursedAt: now }, { session })
        if (!r.modifiedCount) throw new AppError('This run was changed by someone else. Reload it.', 409)
        await Payslip.updateMany({ payrollCycleId: cycleId }, { status: 'disbursed', disbursedAt: now }, { session })
        if (claimIds.length) await col('reimbursement_claims').updateMany({ _id: { $in: claimIds }, tenantId, status: 'finance_approved', paidInCycleId: null } as any, { $set: { status: 'paid', paidInCycleId: cycleId, paidAt: now } }, { session })
      })
    } finally { await session.endSession() }
    for (const claimId of claimIds) await audit({ tenantId, userId, action: 'EXPENSE_PAID', entityType: 'expense_claim', entityId: claimId, newValue: { payrollCycleId: cycleId } })
    await audit({ tenantId, userId, action: 'PAYROLL_CYCLE_DISBURSED', entityType: 'payroll_cycle', entityId: cycleId })
    if (!cycle.payslipsReleasedAt) await payrollService.releasePayslips(cycleId, tenantId, userId)
    await col('attendance_adjustments').updateMany({ tenantId, appliedCycleId: null, date: { $lt: cycle.payPeriodStart } } as any, { $set: { appliedCycleId: cycleId, appliedAt: new Date() } })
    await event(tenantId, 'payroll.cycle.disbursed', { payrollCycleId: cycleId, disbursedBy: userId })
    return getCycleOrThrow(cycleId, tenantId)
  },

  // ─── INPUTS ───
  async addInput(cycleId: string, tenantId: string, userId: string, dto: AddPayrollInputDto) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (!['draft', 'review'].includes(cycle.status)) throw new AppError(`Cannot add inputs — cycle is ${cycle.status}`, 400)
    if (!(await Employee.exists({ _id: dto.employeeId, tenantId }))) throw new AppError('Employee not found', 404)
    const inputType: any = await PayrollInputType.findOne({ _id: dto.inputTypeId, tenantId, active: true }).lean()
    if (!inputType) throw new AppError('Input type not found', 404)
    const input: any = (await PayrollInput.create({ tenantId, payrollCycleId: cycleId, addedBy: userId, employeeId: dto.employeeId, inputTypeId: dto.inputTypeId, amount: dto.amount, description: dto.description })).toObject()
    await audit({ tenantId, userId, action: 'PAYROLL_INPUT_ADDED', entityType: 'payroll_input', entityId: input._id, newValue: dto })
    return { ...ser(input), inputType: ser(inputType) }
  },

  async listInputs(cycleId: string, tenantId: string) {
    await getCycleOrThrow(cycleId, tenantId)
    const rows: any[] = await PayrollInput.find({ payrollCycleId: cycleId }).sort({ createdAt: 1 }).lean()
    const types = new Map<string, any>(((await PayrollInputType.find({ _id: { $in: rows.map((r) => r.inputTypeId) } }).lean()) as any[]).map((t) => [t._id, t]))
    return rows.map((r) => ({ ...ser(r), inputType: ser(types.get(r.inputTypeId)) }))
  },

  async approveInput(inputId: string, tenantId: string, userId: string) {
    const input: any = await PayrollInput.findOne({ _id: inputId, tenantId }).lean()
    if (!input) throw new AppError('Payroll input not found', 404)
    if (input.approvedBy) throw new AppError('Input is already approved', 400)
    if (input.addedBy === userId) throw new AppError('A payroll input must be approved by a different user than the one who added it', 403)
    const approved: any = await PayrollInput.findOneAndUpdate({ _id: inputId, tenantId, approvedBy: { $in: [null, undefined] } }, { approvedBy: userId, approvedAt: new Date() }, { returnDocument: 'after' }).lean()
    if (!approved) throw new AppError('Input is already approved', 400)
    await audit({ tenantId, userId, action: 'PAYROLL_INPUT_APPROVED', entityType: 'payroll_input', entityId: inputId })
    return { ...ser(approved), inputType: ser(await PayrollInputType.findById(approved.inputTypeId).lean()) }
  },

  // ─── PAYSLIP RELEASE ───
  async releasePayslips(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (!['approved', 'disbursed', 'locked'].includes(cycle.status)) throw new AppError(`Payslips can be released once the run is approved (currently ${cycle.status})`, 400)
    if (cycle.payslipsReleasedAt) throw new AppError('Payslips for this run are already released', 400)
    const claimed = await PayrollCycle.updateOne({ _id: cycleId, tenantId, payslipsReleasedAt: { $in: [null, undefined] } }, { payslipsReleasedAt: new Date() })
    if (!claimed.modifiedCount) throw new AppError('Payslips for this run are already released', 400)
    const slips: any[] = await Payslip.find({ payrollCycleId: cycleId, withheld: { $ne: true } }).select('employeeId netPay currency').lean()
    const emps = new Map<string, any>(((await Employee.find({ _id: { $in: slips.map((s) => s.employeeId) } }).select('userId').lean()) as any[]).map((e) => [e._id, e]))
    await audit({ tenantId, userId, action: 'PAYSLIPS_RELEASED', entityType: 'payroll_cycle', entityId: cycleId, newValue: { count: slips.length } })
    const month = dstr(cycle.payPeriodStart).slice(0, 7)
    for (const sl of slips) await notifyUsers(tenantId, [emps.get(sl.employeeId).userId], { type: 'payslip.released', title: `Your payslip for ${month} is ready`, body: 'Your payslip is in My payslips.', link: '/payroll', entityType: 'payslip', entityId: sl._id })
    for (const ps of slips) await event(tenantId, 'payslip.released', { payslipId: ps._id, payrollCycleId: cycleId, employeeId: ps.employeeId, netPay: ps.netPay, currency: ps.currency })
    return { released: slips.length }
  },

  async withholdPayslip(payslipId: string, tenantId: string, userId: string, withheld: boolean, reason?: string) {
    if (withheld && !reason) throw new AppError('Give a reason for holding this payslip', 400)
    const r = await Payslip.updateOne({ _id: payslipId, tenantId }, { withheld, withheldReason: withheld ? reason : null })
    if (!r.matchedCount) throw new AppError('Payslip not found', 404)
    await audit({ tenantId, userId, action: withheld ? 'PAYSLIP_WITHHELD' : 'PAYSLIP_UNHELD', entityType: 'payslip', entityId: payslipId, newValue: { reason: reason ?? null } })
    return { withheld }
  },

  // ─── PAYSLIP ACCESS ───
  async listMyPayslips(employeeId: string) {
    if (!employeeId) return []
    const released: any[] = await PayrollCycle.find({ payslipsReleasedAt: { $ne: null } }).select('payPeriodStart payPeriodEnd status').lean()
    const C = new Map(released.map((c) => [c._id, c]))
    const slips: any[] = await Payslip.find({ employeeId, withheld: { $ne: true }, payrollCycleId: { $in: [...C.keys()] } }).lean()
    return slips.map((s) => ({ ...ser({ ...s, lines: undefined, workedDays: undefined }), payrollCycle: { payPeriodStart: C.get(s.payrollCycleId).payPeriodStart, payPeriodEnd: C.get(s.payrollCycleId).payPeriodEnd, status: C.get(s.payrollCycleId).status } }))
      .sort((a, b) => +b.payrollCycle.payPeriodEnd - +a.payrollCycle.payPeriodEnd)
  },

  async getPayslip(payslipId: string, user: { tenantId: string; employeeId: string; roleIds: string[] }) {
    const doc: any = await Payslip.findOne({ _id: payslipId, tenantId: user.tenantId }).lean()
    if (!doc) throw new AppError('Payslip not found', 404)
    const [view]: any[] = await payslipView([doc])
    const cycle: any = await PayrollCycle.findById(doc.payrollCycleId).lean()
    const payslip = { ...view, payrollCycle: ser(cycle), lines: [...view.lines].sort((a: any, b: any) => a.sequence - b.sequence || String(a.code).localeCompare(String(b.code))) }
    if (user.roleIds.some((r) => PAYROLL_STAFF_ROLES.includes(r))) return payslip
    const released = !!cycle?.payslipsReleasedAt && !doc.withheld
    if (doc.employeeId !== user.employeeId || !released) throw new AppError('Payslip not found', 404)
    return { ...payslip, lines: payslip.lines.filter((l: any) => l.category !== 'EMP_CONTRIB') } // employees never see employer-side lines
  },

  async getPayslipPdf(payslipId: string, user: { tenantId: string; employeeId: string; roleIds: string[]; userId?: string }) {
    const payslip: any = await payrollService.getPayslip(payslipId, user)
    const tenant: any = await Tenant.findById(user.tenantId).select('name').lean()
    const pdf = await generatePayslipPdf(renderPayslipHtml(payslip, tenant?.name || ''))
    await audit({ tenantId: user.tenantId, userId: user.userId, action: 'PAYSLIP_PDF_DOWNLOADED', entityType: 'payslip', entityId: payslipId })
    return { pdf, filename: `payslip-${payslip.employee.employeeCode}-${dstr(new Date(payslip.payrollCycle.payPeriodStart)).slice(0, 7)}.pdf` }
  },

  // ─── BANK FILE ───
  async getBankFilePreview(cycleId: string, tenantId: string) {
    const { included, excluded, currency, totalAmount, cycleId: id } = await evaluateBankEligibility(cycleId, tenantId)
    return { cycleId: id, included: included.map(({ accountNumber: _omit, branchSwift: _b, ...safe }) => safe), excluded, totalAmount, currency }
  },

  async generateBankFile(cycleId: string, tenantId: string, userId: string, opts: { allowPartial: boolean; formatId?: string; paymentDate?: string }) {
    const { cycle, included, excluded, totalAmount } = await evaluateBankEligibility(cycleId, tenantId)
    if (excluded.length > 0 && !opts.allowPartial) {
      const who = excluded.map((e) => `${e.name} (${e.employeeCode}): ${e.reason}`).join('; ')
      throw new AppError(`Cannot generate the bank file — ${excluded.length} employee(s) excluded: ${who}. Resolve them or allow a partial file.`, 409)
    }
    if (included.length === 0) throw new AppError('No payable employees to include in the bank file', 400)
    const period = dstr(cycle.payPeriodStart).slice(0, 7)
    const bankRows = (included.map((r) => ({ employeeCode: r.employeeCode, name: r.name, bankName: r.bankName, accountNumber: r.accountNumber, branchSwift: r.branchSwift, amount: r.amount, currency: r.currency, reference: `SAL-${period}-${r.employeeCode}` })))
    const layout = await formatFor(tenantId, opts.formatId)
    const csv = layout ? renderBankFile(bankRows, layout, opts.paymentDate ?? dstr(new Date())) : formatBankFile(bankRows, 'generic_csv')
    const sha256 = crypto.createHash('sha256').update(csv).digest('hex')
    await audit({ tenantId, userId, action: 'PAYROLL_BANK_FILE_GENERATED', entityType: 'payroll_cycle', entityId: cycleId, newValue: { employees: included.length, totalAmount, sha256, allowPartial: opts.allowPartial } })
    return { csv, filename: `bank-file-${period}${layout ? `-${layout.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : ''}.${fileExt(layout)}` }
  },

  // ─── GL EXPORT ───
  async generateGlExport(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    assertExportable(cycle)
    const payslips: any[] = await Payslip.find({ payrollCycleId: cycleId }).lean()
    if (payslips.length === 0) throw new AppError('This cycle has no payslips to export', 400)
    const period = dstr(cycle.payPeriodStart).slice(0, 7)
    const { lines, totalDebit, totalCredit, difference } = buildGlLines(payslips, period)
    if (Math.abs(difference) > 0.01) throw new AppError(`GL journal does not balance (debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}, difference ${difference.toFixed(2)}). No file produced.`, 409)
    const csv = formatGlCsv(lines, dstr(cycle.payPeriodEnd), `PAYROLL-${period}`)
    await audit({ tenantId, userId, action: 'PAYROLL_GL_EXPORTED', entityType: 'payroll_cycle', entityId: cycleId, newValue: { totalDebit, totalCredit, payslips: payslips.length } })
    return { csv, filename: `gl-journal-${period}.csv` }
  },
}

function assertExportable(cycle: { status: string; approvedBy?: string | null; financeApprovedBy?: string | null }) {
  if (cycle.status === 'disbursed' || cycle.status === 'locked') return
  if (cycle.status === 'approved' && cycle.approvedBy && cycle.financeApprovedBy) return
  throw new AppError(`Export is only available once the cycle has both approvals (currently ${cycle.status})`, 400)
}

async function evaluateBankEligibility(cycleId: string, tenantId: string) {
  const cycle = await getCycleOrThrow(cycleId, tenantId)
  assertExportable(cycle)
  const payslips: any[] = await payslipView(await Payslip.find({ payrollCycleId: cycleId }).lean())
  payslips.sort((a, b) => String(a.employee.employeeCode).localeCompare(String(b.employee.employeeCode)))
  const included: { employeeCode: string; name: string; bankName: string; accountNumber: string; branchSwift: string; accountLast4: string; amount: number; currency: string }[] = []
  const excluded: { employeeCode: string; name: string; reason: string }[] = []
  for (const p of payslips) {
    const e = p.employee, name = `${e.firstName} ${e.lastName}`
    if (!e.bankName || !e.bankAccountNo) { excluded.push({ employeeCode: e.employeeCode, name, reason: 'no bank details' }); continue }
    if (!e.bankVerified) { excluded.push({ employeeCode: e.employeeCode, name, reason: 'bank details not verified' }); continue }
    if (!(p.netPay > 0)) { excluded.push({ employeeCode: e.employeeCode, name, reason: 'net pay is zero or negative' }); continue }
    let accountNumber: string
    try { accountNumber = decryptField(e.bankAccountNo) } catch { console.warn(`[bank] could not decrypt account number for ${e.employeeCode}`); excluded.push({ employeeCode: e.employeeCode, name, reason: 'bank details could not be read' }); continue }
    included.push({ employeeCode: e.employeeCode, name, bankName: e.bankName, accountNumber, branchSwift: e.bankIfscSwift ?? '', accountLast4: last4(accountNumber), amount: p.netPay, currency: p.currency })
  }
  if (new Set(included.map((i) => i.currency)).size > 1) throw new AppError('A bank file cannot mix currencies', 409)
  const totalAmount = round2(included.reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100)
  return { cycleId, cycle, included, excluded, totalAmount, currency: included[0]?.currency ?? payslips[0]?.currency ?? '' }
}

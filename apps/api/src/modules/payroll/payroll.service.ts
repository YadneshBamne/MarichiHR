import { payrollRepository as repo } from './payroll.repository'
import { runPayrollEngine, EngineExtraLine } from './payroll.engine'
import { PAYROLL_CONFIG } from './payroll.config'
import { masterLabels } from '../masters/masters.service'
import { statutoryContext, indiaFyStart, indiaMonthsLeft, StatutoryContext } from '../tax/statutory'
import { CreateCycleDto, AddPayrollInputDto } from './payroll.types'
import { AppError } from '../../shared/utils/AppError'
import { eventBus } from '../../infrastructure/events/eventBus'
import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { verifiedExemption } from '../tax/declarations.service'
import { renderPayslipHtml, generatePayslipPdf } from './payslip.pdf'
import { formatBankFile, buildGlLines, formatGlCsv } from './payroll.export'
import { decryptField, last4 } from '../../shared/utils/crypto'
import crypto from 'crypto'

import { reapplyOverrides } from '../tax/tax-admin.service'
import { applyFlexi, basicShareWarning, offCyclePayslip } from './payroll-extras.service'
const PAYROLL_STAFF_ROLES = ['payroll_admin', 'compliance_officer']

// ─── DATE HELPERS (all UTC, YYYY-MM-DD strings) ───────────────
const dstr = (d: Date) => d.toISOString().slice(0, 10)
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`)
const maxStr = (...a: string[]) => a.reduce((x, y) => (x > y ? x : y))
const minStr = (...a: string[]) => a.reduce((x, y) => (x < y ? x : y))
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

function eachDay(start: string, end: string): string[] {
  const out: string[] = []
  const cur = toDate(start)
  const last = toDate(end)
  while (cur <= last) {
    out.push(dstr(cur))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

// dayOfWeek in resource calendars: 0 = Monday ... 6 = Sunday
const isWorking = (day: string, cal: Set<number>) => cal.has((toDate(day).getUTCDay() + 6) % 7)

type SkipReason = { employeeId: string; employeeCode: string; name: string; reason: string }

// Extra sign-off: a payroll whose net total is above the company's threshold needs a System admin's sign-off
export async function signoffThreshold(tenantId: string) {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { payrollSignoffAbove: true } })
  return t?.payrollSignoffAbove == null ? null : Number(t.payrollSignoffAbove)
}
async function needsSignoff(cycleId: string, tenantId: string) {
  const threshold = await signoffThreshold(tenantId)
  if (threshold == null) return false
  const sum = await prisma.payslip.aggregate({ where: { payrollCycleId: cycleId }, _sum: { netPay: true } })
  return Number(sum._sum.netPay ?? 0) > threshold
}

async function getCycleOrThrow(cycleId: string, tenantId: string) {
  const cycle = await repo.findCycleById(cycleId)
  if (!cycle || cycle.tenantId !== tenantId) throw new AppError('Payroll cycle not found', 404)
  return cycle
}

// Also used by the F&F settlement (exits module) for the prorated last month
export async function computeEmployeePayslip(
  emp: any,
  cycle: any,
  cycleInputs: any[],
  inputCodes: string[]
): Promise<{ skip?: string; payslip?: any; warnings: string[]; basicMonthly?: number }> {
  const warnings: string[] = []
  const periodStart = dstr(cycle.payPeriodStart)
  const periodEnd = dstr(cycle.payPeriodEnd)

  const calDays = new Set<number>(
    emp.resourceCalendar?.days?.length
      ? emp.resourceCalendar.days.map((d: any) => d.dayOfWeek)
      : PAYROLL_CONFIG.DEFAULT_WORKING_DAYS
  )

  const periodWorking = eachDay(periodStart, periodEnd).filter((d) => isWorking(d, calDays))
  if (periodWorking.length === 0) return { skip: 'No working days in period', warnings }

  const contract: any = await repo.findContractForPeriod(emp.id, cycle.payPeriodStart, cycle.payPeriodEnd)
  if (!contract) return { skip: 'No running contract covering this period', warnings }
  if (!contract.salaryStructure) return { skip: 'Contract has no salary structure linked', warnings }

  const windowStart = maxStr(periodStart, dstr(contract.effectiveFrom), dstr(emp.hireDate))
  const windowEnd = minStr(
    periodEnd,
    contract.effectiveUntil ? dstr(contract.effectiveUntil) : periodEnd,
    emp.exitDate ? dstr(emp.exitDate) : periodEnd
  )
  if (windowStart > windowEnd) return { skip: 'Employment window does not overlap the pay period', warnings }

  const windowWorking = eachDay(windowStart, windowEnd).filter((d) => isWorking(d, calDays))

  // ─── LWP + paid leave ─────────────────────────────────────
  const lwpByDay = new Map<string, number>()
  let paidLeaveDays = 0

  const leaves = await repo.listApprovedLeave(emp.id, toDate(windowStart), toDate(windowEnd))
  for (const lr of leaves) {
    const s = dstr(lr.startDate)
    const e = dstr(lr.endDate)
    for (const day of eachDay(maxStr(s, windowStart), minStr(e, windowEnd))) {
      if (!isWorking(day, calDays)) continue
      let v = 1
      if ((lr as any).hours) v = lr.totalDays
      else if (s === e && (lr.startHalf || lr.endHalf)) v = 0.5
      else {
        if (day === s && lr.startHalf) v -= 0.5
        if (day === e && lr.endHalf) v -= 0.5
      }
      // Days approved beyond the balance as unpaid: that share of each day is LWP
      const lwpShare = !lr.leaveType.isPaid ? 1 : lr.totalDays > 0 ? Math.min(1, (lr.lwpDays ?? 0) / lr.totalDays) : 0
      if (lwpShare > 0) lwpByDay.set(day, Math.max(lwpByDay.get(day) ?? 0, v * lwpShare))
      paidLeaveDays += v * (1 - lwpShare)
    }
  }

  const attendance = await repo.listAttendance(emp.id, toDate(windowStart), toDate(windowEnd))
  if (attendance.length === 0) {
    warnings.push('No attendance records in the pay window — treated as fully paid')
  }
  for (const r of attendance) {
    const day = dstr(r.date)
    if (day < windowStart || day > windowEnd || !isWorking(day, calDays)) continue
    if (r.status === 'absent' && r.source === 'auto' && r.checkInTime && !r.checkOutTime) {
      warnings.push(`${day}: clock-in without clock-out was marked absent — NOT deducted. Regularise or override before approving.`)
    } else if (r.status === 'absent' || r.status === 'lwp') {
      lwpByDay.set(day, Math.max(lwpByDay.get(day) ?? 0, 1))
    } else if (r.status === 'half_day') {
      lwpByDay.set(day, Math.max(lwpByDay.get(day) ?? 0, PAYROLL_CONFIG.HALF_DAY_LWP_FACTOR))
    }
  }

  const lwpDays = round2(Array.from(lwpByDay.values()).reduce((a, b) => a + b, 0))
  const paidDays = Math.max(0, round2(windowWorking.length - lwpDays))
  const factor = Math.min(1, paidDays / periodWorking.length)

  const fullWage = contract.wageMonthly
  const proratedWage = round2(fullWage * factor)

  // ─── Extra lines: overtime + approved inputs ──────────────
  const extraLines: EngineExtraLine[] = []
  const hourlyRate = fullWage / (periodWorking.length * PAYROLL_CONFIG.STANDARD_HOURS_PER_DAY)
  let overtimeHours = 0

  const overtime = await repo.listApprovedOvertime(emp.id, toDate(windowStart), toDate(windowEnd))
  for (const ot of overtime) {
    const rate = ot.approvedRate ?? 1.5
    overtimeHours += ot.overtimeHours
    extraLines.push({
      code: 'OVERTIME',
      name: `Overtime ${dstr(ot.date)} (${ot.overtimeHours}h × ${rate})`,
      categoryCode: 'ALW',
      amount: round2(ot.overtimeHours * hourlyRate * rate),
      computationMethod: 'overtime',
      sourceRefType: 'overtime_request',
      sourceRefId: ot.id,
    })
  }

  const inputsByCode: Record<string, number> = {}
  for (const code of inputCodes) inputsByCode[code] = 0

  for (const inp of cycleInputs.filter((i) => i.employeeId === emp.id)) {
    if (!inp.approvedBy) {
      warnings.push(`Payroll input "${inp.inputType.name}" (${inp.amount}) is not approved and was ignored`)
      continue
    }
    inputsByCode[inp.inputType.code] = round2((inputsByCode[inp.inputType.code] ?? 0) + inp.amount)
    extraLines.push({
      code: inp.inputType.code,
      name: inp.description ? `${inp.inputType.name} — ${inp.description}` : inp.inputType.name,
      categoryCode: inp.inputType.category === 'deductions' ? 'DED' : 'ALW',
      amount: inp.amount,
      computationMethod: 'payroll_input',
      sourceRefType: 'payroll_input',
      sourceRefId: inp.id,
    })
  }

  // ─── Approved reimbursements (paid after tax) ─────────────
  const reimbursementLines: { claimId: string; categoryName: string; expenseDate: string; amount: number }[] = []
  const claims = await prisma.reimbursementClaim.findMany({
    where: { employeeId: emp.id, status: 'finance_approved', paidInCycleId: null },
    include: { category: { select: { name: true } } },
    orderBy: { expenseDate: 'asc' },
  })
  for (const cl of claims) {
    if (cl.homeCurrency !== contract.currency) {
      warnings.push(`Reimbursement of ${cl.homeAmount} ${cl.homeCurrency} (${cl.category.name}, ${dstr(cl.expenseDate)}) was not paid: its currency differs from the contract currency (${contract.currency})`)
      continue
    }
    reimbursementLines.push({ claimId: cl.id, categoryName: cl.category.name, expenseDate: dstr(cl.expenseDate), amount: cl.homeAmount })
  }

  // ─── Statutory tables for the period; India TDS also needs this financial year's pay and tax so far ──
  const statutory: StatutoryContext = { at: periodEnd, ...(await statutoryContext(periodEnd, emp.tenantId)) }
  if (contract.salaryStructure.rules.some((r: any) => /compute_india_tds/.test(`${r.pythonCode ?? ''}`))) {
    const prior = await prisma.payslip.findMany({
      where: { employeeId: emp.id, payrollCycleId: { not: cycle.id }, payrollCycle: { payPeriodStart: { gte: toDate(indiaFyStart(periodStart)), lt: cycle.payPeriodStart } } },
      select: { grossEarnings: true, lines: { where: { category: 'TAX' }, select: { amount: true } } },
    })
    statutory.indiaYtd = {
      gross: round2(prior.reduce((a, p) => a + Number(p.grossEarnings), 0)),
      tax: round2(prior.reduce((a, p) => a + p.lines.reduce((b, l) => b + Number(l.amount), 0), 0)),
      monthsLeft: indiaMonthsLeft(periodStart),
      exemption: await verifiedExemption(cycle.tenantId, emp.id, Number(indiaFyStart(periodStart).slice(0, 4))),
    }
  }

  // ─── Run the engine ───────────────────────────────────────
  const result = runPayrollEngine({
    rules: contract.salaryStructure.rules.map((r: any) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      sequence: r.sequence,
      categoryCode: r.category.code,
      amountType: r.amountType,
      amountFixed: r.amountFixed,
      amountPercentage: r.amountPercentage,
      amountPercentageBase: r.amountPercentageBase,
      pythonCode: r.pythonCode,
      conditionSelect: r.conditionSelect,
      conditionExpr: r.conditionExpr,
      appearsOnPayslip: r.appearsOnPayslip,
    })),
    contract: {
      wageMonthly: proratedWage,
      fullWageMonthly: fullWage,
      ctcAnnual: contract.ctcAnnual,
      variablePayPercent: contract.variablePayPercent,
    },
    factor,
    workingDays: periodWorking.length,
    paidDays,
    lwpDays,
    extraLines,
    inputsByCode,
    reimbursementLines,
    statutory,
  })

  warnings.push(...result.warnings)

  // Unprorated monthly BASIC (per-day rates for leave encashment / notice pay)
  const fullMonth = runPayrollEngine({
    rules: contract.salaryStructure.rules.map((r: any) => ({ ...r, categoryCode: r.category.code })),
    contract: { wageMonthly: fullWage, fullWageMonthly: fullWage, ctcAnnual: contract.ctcAnnual, variablePayPercent: contract.variablePayPercent },
    factor: 1,
    workingDays: periodWorking.length,
    paidDays: periodWorking.length,
    lwpDays: 0,
    extraLines: [],
    inputsByCode,
    statutory,
  })

  const payLines = await applyFlexi(emp.id, contract.salaryStructure, result.lines)
  const basicNow = result.lines.filter((l: any) => l.categoryCode === 'BASIC').reduce((a: number, l: any) => a + l.amount, 0)
  const shareWarn = await basicShareWarning(emp.tenantId, emp.id, basicNow, result.gross)
  if (shareWarn) warnings.push(shareWarn)
  // Said here, before approval, rather than first at the bank file after payment
  if (cycle.tenantId && (!emp.bankName || !emp.bankAccountNo)) warnings.push('No bank details: the bank file will leave this person out. HR adds them on the person’s profile.')
  else if (cycle.tenantId && !emp.bankVerified) warnings.push('Bank details not verified yet: the bank file will leave this person out until a second person verifies them.')
  const workDays = Math.max(0, round2(windowWorking.length - lwpDays - paidLeaveDays))
  const hoursPerDay = PAYROLL_CONFIG.STANDARD_HOURS_PER_DAY

  const payslip = {
    payrollCycleId: cycle.id,
    employeeId: emp.id,
    salaryStructureId: contract.salaryStructureId,
    contractId: contract.id,
    grossEarnings: result.gross,
    totalDeductions: result.totalDeductions,
    netPay: result.netPay,
    currency: contract.currency,
    workingDays: periodWorking.length,
    paidDays,
    lwpDays,
    status: 'draft',
    lines: {
      create: payLines.map((l: any) => ({
        salaryRuleId: l.ruleId ?? null,
        category: l.categoryCode,
        name: l.name,
        code: l.code,
        sequence: l.sequence,
        amount: l.amount,
        quantity: 1,
        rate: 1,
        computationMethod: l.computationMethod,
        formulaUsed: l.formulaUsed ?? null,
        sourceRefType: l.sourceRefType ?? null,
        sourceRefId: l.sourceRefId ?? null,
        statutoryRef: l.statutoryRef ?? null,
      })),
    },
    workedDays: {
      create: [
        { dayType: 'work_days', numberOfDays: workDays, numberOfHours: workDays * hoursPerDay },
        { dayType: 'paid_leave', numberOfDays: round2(paidLeaveDays), numberOfHours: round2(paidLeaveDays * hoursPerDay) },
        { dayType: 'lwp', numberOfDays: lwpDays, numberOfHours: round2(lwpDays * hoursPerDay) },
        { dayType: 'overtime', numberOfDays: 0, numberOfHours: round2(overtimeHours) },
      ],
    },
  }

  return { payslip, warnings, basicMonthly: fullMonth.categories.BASIC }
}

export const payrollService = {
  // ─── CYCLES ───────────────────────────────────────────────
  async createCycle(tenantId: string, userId: string, dto: CreateCycleDto) {
    if (dto.payPeriodStart > dto.payPeriodEnd) {
      throw new AppError('Pay period start must be on or before the end date', 400)
    }
    const start = toDate(dto.payPeriodStart)
    const end = toDate(dto.payPeriodEnd)

    if (dto.offCycle && !dto.reason?.trim()) throw new AppError('Say what the off-cycle run is for', 400)
    if (dto.correctsCycleId && !(await prisma.payrollCycle.findFirst({ where: { id: dto.correctsCycleId, tenantId, status: { in: ['disbursed', 'locked'] } } }))) throw new AppError('Corrections are for a run that was already paid', 400)
    if (dto.legalEntityId && !(await prisma.legalEntity.findFirst({ where: { id: dto.legalEntityId, tenantId, active: true } }))) throw new AppError('Legal entity not found', 404)
    const overlap = dto.offCycle ? null : await repo.findOverlappingCycle(tenantId, start, end, dto.legalEntityId)
    if (overlap) {
      throw new AppError(
        `This period overlaps an existing cycle (${dstr(overlap.payPeriodStart)} to ${dstr(overlap.payPeriodEnd)}, ${overlap.status})`,
        409
      )
    }

    const cycle = await repo.createCycle(tenantId, {
      payPeriodStart: start,
      payPeriodEnd: end,
      cycleType: dto.offCycle ? 'off_cycle' : dto.cycleType || 'monthly',
      offCycle: !!dto.offCycle,
      reason: dto.reason?.trim() || null,
      correctsCycleId: dto.correctsCycleId ?? null,
      legalEntityId: dto.legalEntityId ?? null,
    } as any)
    await repo.createAudit({ tenantId, userId, action: 'PAYROLL_CYCLE_CREATED', entityType: 'payroll_cycle', entityId: cycle.id, newValue: dto })
    return cycle
  },

  listCycles(tenantId: string) {
    return repo.listCycles(tenantId)
  },

  async getCycle(cycleId: string, tenantId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    const [totals, payrollAdmins] = await Promise.all([
      repo.aggregateTotals(cycleId),
      // The screen explains the two-approver rule when the company has only one Payroll admin
      prisma.userRole.count({ where: { role: { tenantId, name: 'payroll_admin' }, user: { tenantId, active: true } } }),
    ])
    const threshold = await signoffThreshold(tenantId)
    return {
      ...cycle,
      payrollAdmins,
      attendanceAdjustments: await prisma.attendanceAdjustment.count({ where: { tenantId, appliedCycleId: null, date: { lt: cycle.payPeriodStart } } }),
      signoffThreshold: threshold,
      signoffRequired: threshold != null && round2(Number(totals._sum.netPay ?? 0)) > threshold,
      totals: {
        payslips: totals._count,
        gross: round2(Number(totals._sum.grossEarnings ?? 0)),
        deductions: round2(Number(totals._sum.totalDeductions ?? 0)),
        net: round2(Number(totals._sum.netPay ?? 0)),
      },
    }
  },

  async listCyclePayslips(cycleId: string, tenantId: string) {
    await getCycleOrThrow(cycleId, tenantId)
    const payslips = await repo.listCyclePayslips(cycleId)
    return payslips.map(({ lines, ...p }) => ({
      ...p,
      hasManualInputs: lines.some((l) => l.sourceRefType === 'payroll_input'),
    }))
  },

  async lockAttendance(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (cycle.status !== 'draft') throw new AppError(`Cannot lock attendance — cycle is ${cycle.status}`, 400)

    const locked = await prisma.attendanceRecord.updateMany({
      where: {
        date: { gte: cycle.payPeriodStart, lte: cycle.payPeriodEnd },
        isLocked: false,
        employee: { tenantId },
      },
      data: { isLocked: true },
    })

    await repo.updateCycle(cycleId, { attendanceLockedAt: new Date() })
    await repo.createAudit({
      tenantId, userId, action: 'PAYROLL_ATTENDANCE_LOCKED', entityType: 'payroll_cycle', entityId: cycleId,
      newValue: { recordsLocked: locked.count },
    })
    await eventBus.publish(tenantId, 'attendance.locked', {
      payrollCycleId: cycleId,
      lockedBy: userId,
      recordsLocked: locked.count,
    })

    return { message: 'Attendance locked for this pay period', recordsLocked: locked.count }
  },

  async runCycle(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (!['draft', 'review'].includes(cycle.status)) {
      throw new AppError(`Cycle is ${cycle.status} and cannot be re-run. Use reopen if it is approved but not disbursed.`, 400)
    }
    if (!cycle.attendanceLockedAt && !cycle.offCycle) {
      throw new AppError('Lock attendance for this pay period before running payroll', 400)
    }

    await repo.updateCycle(cycleId, { status: 'processing' })
    await eventBus.publish(tenantId, 'payroll.cycle.started', { payrollCycleId: cycleId, startedBy: userId })

    const skipped: SkipReason[] = []
    const warningsByEmployee: Record<string, string[]> = {}
    let processed = 0

    try {
      await repo.deletePayslipsForCycle(cycleId)

      const employees = await repo.listPayrollEmployees(tenantId, cycle.legalEntityId)
      const cycleInputs = await repo.listCycleInputs(cycleId)
      const inputTypes = await repo.listInputTypes(tenantId)
      const inputCodes = inputTypes.map((t) => t.code)

      // Leavers whose last working day is on or before this period's end are paid through their F&F settlement
      const exits = await prisma.employeeExit.findMany({
        where: { tenantId, status: { not: 'cancelled' }, lastWorkingDate: { lte: cycle.payPeriodEnd } },
        select: { employeeId: true, lastWorkingDate: true },
      })
      const exitByEmployee = new Map(exits.map((x) => [x.employeeId, dstr(x.lastWorkingDate)]))

      const one = async (emp: (typeof employees)[number]) => {
        const name = `${emp.firstName} ${emp.lastName}`
        const exitDay = exitByEmployee.get(emp.id)
        if (exitDay) {
          skipped.push({ employeeId: emp.id, employeeCode: emp.employeeCode, name, reason: `Exiting on ${exitDay}: paid through the full & final settlement` })
          return
        }
        try {
          // Off-cycle runs pay only the inputs added to them; people without any are left out quietly
          if (cycle.offCycle && !cycleInputs.some((i: any) => i.employeeId === emp.id)) return
          const out: any = cycle.offCycle ? await offCyclePayslip(emp, cycle, cycleInputs) : await computeEmployeePayslip(emp, cycle, cycleInputs, inputCodes)
          if (out.skip) {
            skipped.push({ employeeId: emp.id, employeeCode: emp.employeeCode, name, reason: out.skip })
            return
          }
          await repo.createPayslip(out.payslip)
          processed++
          if (out.warnings.length) warningsByEmployee[`${emp.employeeCode} ${name}`] = out.warnings
        } catch (err: any) {
          skipped.push({ employeeId: emp.id, employeeCode: emp.employeeCode, name, reason: err.message })
        }
      }
      // People are independent: several are worked out at once (each waits on the database most of the time).
      // ponytail: fixed pool of PAYROLL_CONCURRENCY (default 8, below Prisma's connection limit); a queue job with
      // progress if runs ever exceed a few minutes.
      const pool = Math.max(1, Number(process.env.PAYROLL_CONCURRENCY) || 8)
      let next = 0
      await Promise.all(Array.from({ length: Math.min(pool, employees.length) }, async () => { while (next < employees.length) await one(employees[next++]) }))

      await reapplyOverrides(cycleId) // tax overrides already signed off survive a re-run
      await repo.updateCycle(cycleId, { status: 'review' })
    } catch (err) {
      await repo.updateCycle(cycleId, { status: 'draft' })
      throw err
    }

    const totals = await repo.aggregateTotals(cycleId)
    await repo.createAudit({
      tenantId, userId, action: 'PAYROLL_CYCLE_RUN', entityType: 'payroll_cycle', entityId: cycleId,
      newValue: { processed, skipped: skipped.length },
    })

    return {
      status: 'review',
      processed,
      skipped,
      warnings: warningsByEmployee,
      totals: {
        gross: round2(Number(totals._sum.grossEarnings ?? 0)),
        deductions: round2(Number(totals._sum.totalDeductions ?? 0)),
        net: round2(Number(totals._sum.netPay ?? 0)),
      },
    }
  },

  // ─── VARIANCE REPORT ──────────────────────────────────────
  async getVarianceReport(cycleId: string, tenantId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    const current = await repo.listCyclePayslips(cycleId)
    const prevCycle = await repo.findPreviousCycle(tenantId, cycle.payPeriodStart)
    const previous = prevCycle ? await repo.listCyclePayslips(prevCycle.id) : []

    const rows = current.map((ps) => {
      const prev = previous.find((p) => p.employeeId === ps.employeeId)
      const flags: string[] = []
      let changePct: number | null = null

      if (!prev) {
        if (prevCycle) flags.push('new_in_cycle')
      } else if (prev.netPay !== 0) {
        changePct = round2(((ps.netPay - prev.netPay) / prev.netPay) * 100)
        if (Math.abs(changePct) > PAYROLL_CONFIG.VARIANCE_THRESHOLD * 100) flags.push('net_change_over_threshold')
      }
      if (ps.lwpDays > 0) flags.push('lwp_days')
      if (ps.netPay < 0) flags.push('negative_net')
      if (!(ps.grossEarnings > 0)) flags.push('zero_gross')
      if (!ps.employee.bankName || !ps.employee.bankAccountNo) flags.push('no_bank_details')
      else if (!ps.employee.bankVerified) flags.push('bank_unverified')
      const tax = ps.lines.filter((l) => l.category === 'TAX').reduce((s, l) => s + Number(l.amount), 0)
      if (ps.grossEarnings > 0 && tax / ps.grossEarnings > 0.45) flags.push('tax_over_45_percent')
      if (ps.lines.some((l) => l.sourceRefType === 'payroll_input')) flags.push('manual_input')

      return {
        employeeId: ps.employeeId,
        employeeCode: ps.employee.employeeCode,
        name: `${ps.employee.firstName} ${ps.employee.lastName}`,
        netPay: ps.netPay,
        previousNetPay: prev?.netPay ?? null,
        changePct,
        lwpDays: ps.lwpDays,
        flags,
      }
    })

    const missing = previous
      .filter((p) => !current.some((c) => c.employeeId === p.employeeId))
      .map((p) => ({
        employeeId: p.employeeId,
        employeeCode: p.employee.employeeCode,
        name: `${p.employee.firstName} ${p.employee.lastName}`,
        flags: ['missing_from_cycle'],
      }))

    // Inputs added to this run but not yet approved are left out of pay: say so before anyone approves
    const unapprovedInputs = await prisma.payrollInput.count({ where: { payrollCycleId: cycleId, approvedBy: null } })
    return {
      cycleId,
      unapprovedInputs,
      previousCycleId: prevCycle?.id ?? null,
      thresholdPct: PAYROLL_CONFIG.VARIANCE_THRESHOLD * 100,
      flaggedCount: rows.filter((r) => r.flags.length > 0).length + missing.length,
      rows,
      missing,
    }
  },

  // ─── APPROVAL FLOW ────────────────────────────────────────
  async approve(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (cycle.status !== 'review') throw new AppError(`Cycle must be in review to approve (currently ${cycle.status})`, 400)
    if ((await repo.countPayslips(cycleId)) === 0) throw new AppError('No payslips to approve', 400)
    const negative = await prisma.payslip.count({ where: { payrollCycleId: cycleId, netPay: { lt: 0 } } })
    if (negative) throw new AppError(`${negative} payslip${negative === 1 ? ' has' : 's have'} negative net pay; fix them and re-run before approving`, 400)
    const waiting = await prisma.taxOverride.count({ where: { cycleId, status: 'pending' } })
    if (waiting) throw new AppError(`${waiting} tax override${waiting === 1 ? ' is' : 's are'} waiting for a Compliance officer's sign-off`, 400)

    await repo.updateCycle(cycleId, { status: 'approved', approvedBy: userId, approvedAt: new Date() })
    await repo.setPayslipStatus(cycleId, 'approved')
    await repo.createAudit({ tenantId, userId, action: 'PAYROLL_CYCLE_APPROVED', entityType: 'payroll_cycle', entityId: cycleId })
    return getCycleOrThrow(cycleId, tenantId)
  },

  async financeApprove(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (cycle.status !== 'approved' || !cycle.approvedBy) throw new AppError('The first approval is needed before the second', 400)
    if (cycle.financeApprovedBy) throw new AppError('Cycle is already finance-approved', 400)
    if (cycle.approvedBy === userId) {
      throw new AppError('The second approval must come from a different Payroll admin than the first. If you are the only Payroll admin, give a second person the role in Login & access.', 403)
    }

    await repo.updateCycle(cycleId, { financeApprovedBy: userId, financeApprovedAt: new Date() })
    if (await needsSignoff(cycleId, tenantId)) {
      const admins = (await userIdsWithRole(tenantId, 'system_admin')).filter((x) => x !== userId && x !== cycle.approvedBy)
      await notify({ tenantId, userIds: admins, type: 'payroll.signoff', title: 'A payroll needs your sign-off', body: `${cycle.payPeriodStart.toISOString().slice(0, 7)} is above the sign-off amount`, link: '/approvals?tab=signoff', entityType: 'payroll_cycle', entityId: cycleId })
    }
    await repo.createAudit({ tenantId, userId, action: 'PAYROLL_CYCLE_FINANCE_APPROVED', entityType: 'payroll_cycle', entityId: cycleId })
    return getCycleOrThrow(cycleId, tenantId)
  },

  async reopen(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (cycle.status !== 'approved') throw new AppError('Only approved (not yet disbursed) cycles can be reopened', 400)

    await repo.updateCycle(cycleId, {
      status: 'review', approvedBy: null, approvedAt: null, financeApprovedBy: null, financeApprovedAt: null,
    })
    await repo.setPayslipStatus(cycleId, 'draft')
    await repo.createAudit({
      tenantId, userId, action: 'PAYROLL_CYCLE_REOPENED', entityType: 'payroll_cycle', entityId: cycleId,
      oldValue: { approvedBy: cycle.approvedBy, financeApprovedBy: cycle.financeApprovedBy },
    })
    return getCycleOrThrow(cycleId, tenantId)
  },

  async disburse(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (cycle.status !== 'approved') throw new AppError(`Cycle must be approved to disburse (currently ${cycle.status})`, 400)
    if (!cycle.approvedBy || !cycle.financeApprovedBy) throw new AppError('Both approvals (two different Payroll admins) are required before disbursement', 400)
    if (!cycle.signoffBy && (await needsSignoff(cycleId, tenantId))) throw new AppError('This payroll is above the sign-off amount: a System admin must sign it off first', 400)

    // Reimbursement claims on this cycle's payslips must not already have been paid elsewhere — checked before anything changes
    const reimbLines = await prisma.payslipLine.findMany({
      where: { sourceRefType: 'reimbursement_claim', payslip: { payrollCycleId: cycleId } },
      select: { sourceRefId: true },
    })
    const claimIds = Array.from(new Set(reimbLines.map((l) => l.sourceRefId).filter((x): x is string => !!x)))
    if (claimIds.length > 0) {
      const alreadyPaid = await prisma.reimbursementClaim.count({
        where: { id: { in: claimIds }, OR: [{ status: 'paid' }, { paidInCycleId: { not: null } }] },
      })
      if (alreadyPaid > 0) throw new AppError('Reimbursement already paid in another cycle — re-run this cycle', 409)
    }

    const now = new Date()
    await repo.updateCycle(cycleId, { status: 'disbursed', disbursedAt: now })
    await repo.setPayslipStatus(cycleId, 'disbursed', now)
    if (claimIds.length > 0) {
      await prisma.reimbursementClaim.updateMany({
        where: { id: { in: claimIds }, tenantId, status: 'finance_approved', paidInCycleId: null },
        data: { status: 'paid', paidInCycleId: cycleId, paidAt: now },
      })
      for (const claimId of claimIds) {
        await repo.createAudit({ tenantId, userId, action: 'EXPENSE_PAID', entityType: 'expense_claim', entityId: claimId, newValue: { payrollCycleId: cycleId } })
      }
    }
    await repo.createAudit({ tenantId, userId, action: 'PAYROLL_CYCLE_DISBURSED', entityType: 'payroll_cycle', entityId: cycleId })
    if (!cycle.payslipsReleasedAt) await payrollService.releasePayslips(cycleId, tenantId, userId)

    await prisma.attendanceAdjustment.updateMany({ where: { tenantId, appliedCycleId: null, date: { lt: cycle.payPeriodStart } }, data: { appliedCycleId: cycleId, appliedAt: new Date() } })
    await eventBus.publish(tenantId, 'payroll.cycle.disbursed', { payrollCycleId: cycleId, disbursedBy: userId })

    return getCycleOrThrow(cycleId, tenantId)
  },

  // ─── INPUTS ───────────────────────────────────────────────
  async addInput(cycleId: string, tenantId: string, userId: string, dto: AddPayrollInputDto) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (!['draft', 'review'].includes(cycle.status)) throw new AppError(`Cannot add inputs — cycle is ${cycle.status}`, 400)

    const employee = await prisma.employee.findFirst({ where: { id: dto.employeeId, tenantId } })
    if (!employee) throw new AppError('Employee not found', 404)
    const inputType = await prisma.payrollInputType.findFirst({ where: { id: dto.inputTypeId, tenantId, active: true } })
    if (!inputType) throw new AppError('Input type not found', 404)

    const input = await repo.createInput({ payrollCycleId: cycleId, addedBy: userId, ...dto })
    await repo.createAudit({ tenantId, userId, action: 'PAYROLL_INPUT_ADDED', entityType: 'payroll_input', entityId: input.id, newValue: dto })
    return input
  },

  async listInputs(cycleId: string, tenantId: string) {
    await getCycleOrThrow(cycleId, tenantId)
    return repo.listCycleInputs(cycleId)
  },

  async approveInput(inputId: string, tenantId: string, userId: string) {
    const input = await repo.findInputById(inputId)
    if (!input) throw new AppError('Payroll input not found', 404)
    await getCycleOrThrow(input.payrollCycleId, tenantId)
    if (input.approvedBy) throw new AppError('Input is already approved', 400)
    if (input.addedBy === userId) throw new AppError('A payroll input must be approved by a different user than the one who added it', 403)

    const approved = await repo.approveInput(inputId, userId)
    await repo.createAudit({ tenantId, userId, action: 'PAYROLL_INPUT_APPROVED', entityType: 'payroll_input', entityId: inputId })
    return approved
  },

  // ─── PAYSLIP RELEASE ──────────────────────────────────────
  // Payroll can show payslips as soon as a run is approved (or wait: disbursing releases them). Held payslips stay hidden.
  async releasePayslips(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    if (!['approved', 'disbursed', 'locked'].includes(cycle.status)) throw new AppError(`Payslips can be released once the run is approved (currently ${cycle.status})`, 400)
    if (cycle.payslipsReleasedAt) throw new AppError('Payslips for this run are already released', 400)
    const claimed = await prisma.payrollCycle.updateMany({ where: { id: cycleId, payslipsReleasedAt: null }, data: { payslipsReleasedAt: new Date() } })
    if (!claimed.count) throw new AppError('Payslips for this run are already released', 400)
    const slips = await prisma.payslip.findMany({ where: { payrollCycleId: cycleId, withheld: false }, select: { id: true, employeeId: true, netPay: true, currency: true, employee: { select: { userId: true } } } })
    await repo.createAudit({ tenantId, userId, action: 'PAYSLIPS_RELEASED', entityType: 'payroll_cycle', entityId: cycleId, newValue: { count: slips.length } })
    const month = new Date(cycle.payPeriodStart).toISOString().slice(0, 7)
    // One email per person with their payslip PDF attached (built only when email is on for them)
    for (const sl of slips) await notify({ tenantId, userIds: [sl.employee.userId], type: 'payslip.released', title: `Your payslip for ${month} is ready`, body: 'Your payslip is attached, and in My payslips.', link: '/payroll', entityType: 'payslip', entityId: sl.id, attachments: async () => { const f = await payrollService.getPayslipPdf(sl.id, { tenantId, employeeId: sl.employeeId, roleIds: ['payroll_admin'], userId }); return [{ filename: f.filename, content: Buffer.from(f.pdf) }] } })
    // One event per released payslip, for automation rules and webhooks (the notification above is the employee's)
    for (const ps of slips) await eventBus.publish(tenantId, 'payslip.released', { payslipId: ps.id, payrollCycleId: cycleId, employeeId: ps.employeeId, netPay: ps.netPay, currency: ps.currency })
    return { released: slips.length }
  },

  async withholdPayslip(payslipId: string, tenantId: string, userId: string, withheld: boolean, reason?: string) {
    const ps = await repo.findPayslipById(payslipId)
    if (!ps || ps.employee.tenantId !== tenantId) throw new AppError('Payslip not found', 404)
    if (withheld && !reason) throw new AppError('Give a reason for holding this payslip', 400)
    await prisma.payslip.update({ where: { id: payslipId }, data: { withheld, withheldReason: withheld ? reason : null } })
    await repo.createAudit({ tenantId, userId, action: withheld ? 'PAYSLIP_WITHHELD' : 'PAYSLIP_UNHELD', entityType: 'payslip', entityId: payslipId, newValue: { reason: reason ?? null } })
    return { withheld }
  },

  // ─── PAYSLIP ACCESS ───────────────────────────────────────
  listMyPayslips(employeeId: string) {
    if (!employeeId) return []
    return repo.listReleasedPayslips(employeeId)
  },

  async getPayslip(payslipId: string, user: { tenantId: string; employeeId: string; roleIds: string[] }) {
    const payslip = await repo.findPayslipById(payslipId)
    if (!payslip || payslip.employee.tenantId !== user.tenantId) throw new AppError('Payslip not found', 404)

    const isStaff = user.roleIds.some((r) => PAYROLL_STAFF_ROLES.includes(r))
    if (isStaff) return payslip

    const released = !!payslip.payrollCycle.payslipsReleasedAt && !payslip.withheld
    if (payslip.employeeId !== user.employeeId || !released) throw new AppError('Payslip not found', 404)

    // Employees never see employer-side contribution lines
    return { ...payslip, lines: payslip.lines.filter((l) => l.category !== 'EMP_CONTRIB') }
  },

  async getPayslipPdf(payslipId: string, user: { tenantId: string; employeeId: string; roleIds: string[]; userId?: string }) {
    const payslip = await payrollService.getPayslip(payslipId, user)
    const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } })
    const html = renderPayslipHtml(payslip, tenant?.name || '')
    const pdf = await generatePayslipPdf(html)
    const period = new Date(payslip.payrollCycle.payPeriodStart).toISOString().slice(0, 7)
    await repo.createAudit({
      tenantId: user.tenantId, userId: user.userId, action: 'PAYSLIP_PDF_DOWNLOADED', entityType: 'payslip', entityId: payslipId,
    })
    return { pdf, filename: `payslip-${payslip.employee.employeeCode}-${period}.pdf` }
  },

  // ─── BANK FILE ────────────────────────────────────────────
  async getBankFilePreview(cycleId: string, tenantId: string) {
    const { included, excluded, currency, totalAmount, cycleId: id } = await evaluateBankEligibility(cycleId, tenantId)
    return {
      cycleId: id,
      included: included.map(({ accountNumber: _omit, branchSwift: _b, ...safe }) => safe),
      excluded,
      totalAmount,
      currency,
    }
  },

  async generateBankFile(cycleId: string, tenantId: string, userId: string, opts: { allowPartial: boolean }) {
    const { cycle, included, excluded, totalAmount } = await evaluateBankEligibility(cycleId, tenantId)

    if (excluded.length > 0 && !opts.allowPartial) {
      const who = excluded.map((e) => `${e.name} (${e.employeeCode}): ${e.reason}`).join('; ')
      throw new AppError(`Cannot generate the bank file — ${excluded.length} employee(s) excluded: ${who}. Resolve them or allow a partial file.`, 409)
    }
    if (included.length === 0) throw new AppError('No payable employees to include in the bank file', 400)

    const period = dstr(cycle.payPeriodStart).slice(0, 7)
    const csv = formatBankFile(
      included.map((r) => ({
        employeeCode: r.employeeCode,
        name: r.name,
        bankName: r.bankName,
        accountNumber: r.accountNumber,
        branchSwift: r.branchSwift,
        amount: r.amount,
        currency: r.currency,
        reference: `SAL-${period}-${r.employeeCode}`,
      })),
      'generic_csv'
    )

    const sha256 = crypto.createHash('sha256').update(csv).digest('hex')
    await repo.createAudit({
      tenantId, userId, action: 'PAYROLL_BANK_FILE_GENERATED', entityType: 'payroll_cycle', entityId: cycleId,
      newValue: { employees: included.length, totalAmount, sha256, allowPartial: opts.allowPartial },
    })

    return { csv, filename: `bank-file-${period}.csv` }
  },

  // ─── GL EXPORT ────────────────────────────────────────────
  async generateGlExport(cycleId: string, tenantId: string, userId: string) {
    const cycle = await getCycleOrThrow(cycleId, tenantId)
    assertExportable(cycle)

    const payslips = await repo.listPayslipsForExport(cycleId)
    if (payslips.length === 0) throw new AppError('This cycle has no payslips to export', 400)

    const period = dstr(cycle.payPeriodStart).slice(0, 7)
    const { lines, totalDebit, totalCredit, difference } = buildGlLines(payslips, period)
    if (Math.abs(difference) > 0.01) {
      throw new AppError(`GL journal does not balance (debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}, difference ${difference.toFixed(2)}). No file produced.`, 409)
    }

    const csv = formatGlCsv(lines, dstr(cycle.payPeriodEnd), `PAYROLL-${period}`)
    await repo.createAudit({
      tenantId, userId, action: 'PAYROLL_GL_EXPORTED', entityType: 'payroll_cycle', entityId: cycleId,
      newValue: { totalDebit, totalCredit, payslips: payslips.length },
    })

    return { csv, filename: `gl-journal-${period}.csv` }
  },
}

function assertExportable(cycle: { status: string; approvedBy: string | null; financeApprovedBy: string | null }) {
  if (cycle.status === 'disbursed' || cycle.status === 'locked') return
  if (cycle.status === 'approved' && cycle.approvedBy && cycle.financeApprovedBy) return
  throw new AppError(`Export is only available once the cycle has both approvals (currently ${cycle.status})`, 400)
}

async function evaluateBankEligibility(cycleId: string, tenantId: string) {
  const cycle = await getCycleOrThrow(cycleId, tenantId)
  assertExportable(cycle)

  const [payslips, banks] = await Promise.all([repo.listPayslipsForExport(cycleId), masterLabels(tenantId, 'bank')])
  const included: { employeeCode: string; name: string; bankName: string; accountNumber: string; branchSwift: string; accountLast4: string; amount: number; currency: string }[] = []
  const excluded: { employeeCode: string; name: string; reason: string }[] = []

  for (const p of payslips) {
    const e = p.employee
    const name = `${e.firstName} ${e.lastName}`
    if (!e.bankName || !e.bankAccountNo) { excluded.push({ employeeCode: e.employeeCode, name, reason: 'no bank details' }); continue }
    if (!e.bankVerified) { excluded.push({ employeeCode: e.employeeCode, name, reason: 'bank details not verified' }); continue }
    if (!(p.netPay > 0)) { excluded.push({ employeeCode: e.employeeCode, name, reason: 'net pay is zero or negative' }); continue }

    let accountNumber: string
    try {
      accountNumber = decryptField(e.bankAccountNo)
    } catch {
      console.warn(`[bank] could not decrypt account number for ${e.employeeCode}`)
      excluded.push({ employeeCode: e.employeeCode, name, reason: 'bank details could not be read' })
      continue
    }
    included.push({
      employeeCode: e.employeeCode, name, bankName: banks.get(e.bankName)?.label ?? e.bankName, accountNumber, branchSwift: e.bankIfscSwift ?? '',
      accountLast4: last4(accountNumber), amount: p.netPay, currency: p.currency,
    })
  }

  const currencies = new Set(included.map((i) => i.currency))
  if (currencies.size > 1) throw new AppError('A bank file cannot mix currencies', 409)

  const totalAmount = round2(included.reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100)
  return { cycleId, cycle, included, excluded, totalAmount, currency: included[0]?.currency ?? payslips[0]?.currency ?? '' }
}

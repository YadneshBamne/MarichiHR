import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdOfEmployee, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { statutoryFor } from '../tax/statutory'

// Payroll extras: off-cycle runs (only the inputs added to them: bonuses, arrears, corrections to a paid run),
// the flexi-basket (people split their structure's flexi pot across allowed components; Payroll approves) and
// minimum-wage / basic-share checks from the statutory tables (marked to confirm).
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

// ─── Off-cycle payslip: the person's approved inputs in this run, no salary, no automatic tax ────────────────────
export async function offCyclePayslip(emp: { id: string }, cycle: { id: string }, inputs: any[]) {
  const mine = inputs.filter((i) => i.employeeId === emp.id)
  if (!mine.length) return { skip: 'No inputs for this person in this off-cycle run' as string, warnings: [] as string[] }
  const contract = await prisma.employeeContract.findFirst({ where: { employeeId: emp.id, active: true, status: { in: ['running', 'expired', 'closed'] } }, orderBy: { effectiveFrom: 'desc' }, select: { id: true, currency: true, salaryStructureId: true } })
  if (!contract) return { skip: 'No contract on record', warnings: [] }
  const warnings: string[] = ['Off-cycle payment: tax is not computed automatically. Add a tax deduction input if this payment is taxable.']
  const lines: any[] = []
  let earnings = 0, deductions = 0, seq = 10
  for (const inp of mine) {
    if (!inp.approvedBy) { warnings.push(`Payroll input "${inp.inputType.name}" (${inp.amount}) is not approved and was ignored`); continue }
    const ded = inp.inputType.category === 'deductions'
    if (ded) deductions += inp.amount; else earnings += inp.amount
    lines.push({ salaryRuleId: null, category: ded ? 'DED' : 'ALW', name: inp.description ? `${inp.inputType.name} — ${inp.description}` : inp.inputType.name, code: inp.inputType.code, sequence: seq += 10, amount: inp.amount, quantity: 1, rate: 1, computationMethod: 'payroll_input', formulaUsed: null, sourceRefType: 'payroll_input', sourceRefId: inp.id })
  }
  if (!lines.length) return { skip: 'No approved inputs', warnings }
  lines.push({ salaryRuleId: null, category: 'GROSS', name: 'Gross', code: 'GROSS', sequence: 900, amount: round2(earnings), quantity: 1, rate: 1, computationMethod: 'off_cycle', formulaUsed: null, sourceRefType: null, sourceRefId: null })
  lines.push({ salaryRuleId: null, category: 'NET', name: 'Net Pay', code: 'NET', sequence: 999, amount: round2(earnings - deductions), quantity: 1, rate: 1, computationMethod: 'off_cycle', formulaUsed: null, sourceRefType: null, sourceRefId: null })
  return {
    warnings,
    payslip: {
      payrollCycleId: cycle.id, employeeId: emp.id, salaryStructureId: contract.salaryStructureId, contractId: contract.id,
      grossEarnings: round2(earnings), totalDeductions: round2(deductions), netPay: round2(earnings - deductions), currency: contract.currency,
      workingDays: 0, paidDays: 0, lwpDays: 0, status: 'draft', lines: { create: lines },
    },
  }
}

// ─── Minimum wage and basic share ───────────────────────────────────────────────────────────────────────────────
async function wageRules(tenantId: string, employeeId: string) {
  const [emp, tenant] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId }, select: { taxJurisdiction: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { primaryCountry: true } }),
  ])
  const country = emp?.taxJurisdiction ?? tenant?.primaryCountry
  if (!country) return null
  const t = (await statutoryFor(new Date().toISOString().slice(0, 10), tenantId))[`${country}_MIN_WAGE`]
  return t ? { country, monthly: t.monthly as number | undefined, minBasicShare: t.minBasicShare as number | undefined } : null
}
// A contract below the minimum wage is refused (the figure is in Tax & compliance › Rates, marked to confirm)
export async function assertMinimumWage(tenantId: string, employeeId: string, wageMonthly: number, employmentType?: string | null) {
  if (employmentType === 'contractor' || employmentType === 'intern') return
  const r = await wageRules(tenantId, employeeId)
  if (r?.monthly && wageMonthly < r.monthly) throw new AppError(`The monthly wage is below ${r.country}'s minimum wage of ${r.monthly.toLocaleString()} (see Tax & compliance › Rates)`, 400)
}
// A payroll warning when basic pay is below the country's minimum share of gross (India: 50%)
export async function basicShareWarning(tenantId: string, employeeId: string, basic: number, gross: number) {
  const r = await wageRules(tenantId, employeeId)
  if (r?.minBasicShare && gross > 0 && basic / gross < r.minBasicShare) return `Basic pay is ${Math.round((basic / gross) * 100)}% of gross, below the ${r.minBasicShare * 100}% minimum for ${r.country}`
  return null
}

// ─── Flexi-basket ───────────────────────────────────────────────────────────────────────────────────────────────
export const FlexiConfigBody = z.object({
  potCode: z.string().trim().min(1).max(30).nullable(),
  components: z.array(z.object({ code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,19}$/), name: z.string().trim().min(2).max(60), max: z.number().positive().max(1e9) }).strict()).max(10),
}).strict()
export const FlexiChoiceBody = z.object({ choices: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/), z.number().min(0).max(1e9)) }).strict()

async function myStructure(u: AccessUser) {
  if (!u.employeeId) throw new AppError('Only employees choose a flexi split', 403)
  const c = await prisma.employeeContract.findFirst({ where: { employeeId: u.employeeId, active: true, status: 'running' }, select: { salaryStructureId: true, salaryStructure: { select: { id: true, name: true, flexiPotCode: true, flexiComponents: true } } } })
  return c?.salaryStructure ?? null
}

export const flexiService = {
  async configure(u: AccessUser, structureId: string, b: z.infer<typeof FlexiConfigBody>) {
    const s = await prisma.salaryStructure.findFirst({ where: { id: structureId, tenantId: u.tenantId }, include: { rules: { select: { code: true } } } })
    if (!s) throw new AppError('Salary structure not found', 404)
    if (b.potCode && !s.rules.some((r) => r.code === b.potCode)) throw new AppError(`The structure has no rule ${b.potCode} to use as the flexi pot`, 400)
    await prisma.salaryStructure.update({ where: { id: s.id }, data: { flexiPotCode: b.potCode, flexiComponents: b.potCode ? (b.components as any) : null } })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'FLEXI_CONFIGURED', entityType: 'salary_structure', entityId: s.id, newValue: b as any } })
    return { potCode: b.potCode, components: b.components }
  },
  async mine(u: AccessUser) {
    const s = await myStructure(u)
    if (!s?.flexiPotCode) return { enabled: false }
    const [choice, last] = await Promise.all([
      prisma.flexiChoice.findUnique({ where: { employeeId_structureId: { employeeId: u.employeeId!, structureId: s.id } } }),
      prisma.payslipLine.findFirst({ where: { code: s.flexiPotCode, payslip: { employeeId: u.employeeId! } }, orderBy: { payslip: { createdAt: 'desc' } }, select: { amount: true } }),
    ])
    return { enabled: true, structure: s.name, potCode: s.flexiPotCode, components: s.flexiComponents, pot: last ? Number(last.amount) : null, choice }
  },
  async choose(u: AccessUser, b: z.infer<typeof FlexiChoiceBody>) {
    const s = await myStructure(u)
    if (!s?.flexiPotCode) throw new AppError('Your salary structure has no flexi-basket', 400)
    const comps = (s.flexiComponents ?? []) as { code: string; name: string; max: number }[]
    for (const [code, amount] of Object.entries(b.choices)) {
      const c = comps.find((x) => x.code === code)
      if (!c) throw new AppError(`${code} is not one of the flexi components`, 400)
      if (amount > c.max) throw new AppError(`${c.name} can be at most ${c.max}`, 400)
    }
    const row = await prisma.flexiChoice.upsert({
      where: { employeeId_structureId: { employeeId: u.employeeId!, structureId: s.id } },
      create: { tenantId: u.tenantId, employeeId: u.employeeId!, structureId: s.id, choices: b.choices },
      update: { choices: b.choices, status: 'submitted', note: null, decidedBy: null, decidedAt: null },
    })
    await notify({ tenantId: u.tenantId, userIds: (await userIdsWithRole(u.tenantId, 'payroll_admin')).filter((x) => x !== u.userId), type: 'payroll.flexi', title: 'A flexi-basket choice to approve', body: s.name, link: '/compensation?tab=flexi', entityType: 'flexi_choice', entityId: row.id })
    return row
  },
  async pending(u: AccessUser) {
    if (!u.roleIds.includes('payroll_admin')) throw new AppError('Only Payroll admins approve flexi choices', 403)
    const rows = await prisma.flexiChoice.findMany({ where: { tenantId: u.tenantId, status: 'submitted' }, orderBy: { updatedAt: 'asc' } })
    const emps = await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
    return rows.map((r) => ({ ...r, employee: emps.find((e) => e.id === r.employeeId) ? `${emps.find((e) => e.id === r.employeeId)!.firstName} ${emps.find((e) => e.id === r.employeeId)!.lastName}` : null }))
  },
  async decide(u: AccessUser, id: string, approve: boolean, note?: string) {
    if (!u.roleIds.includes('payroll_admin')) throw new AppError('Only Payroll admins approve flexi choices', 403)
    const r = await prisma.flexiChoice.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!r) throw new AppError('Choice not found', 404)
    if (r.employeeId === u.employeeId) throw new AppError('You cannot approve your own choice', 403)
    if (!approve && !note) throw new AppError('Say what to change', 400)
    await prisma.flexiChoice.update({ where: { id }, data: { status: approve ? 'approved' : 'returned', note: note ?? null, decidedBy: u.userId, decidedAt: new Date() } })
    const uid = await userIdOfEmployee(u.tenantId, r.employeeId)
    if (uid) await notify({ tenantId: u.tenantId, userIds: [uid], type: 'payroll.flexi', title: approve ? 'Your flexi-basket choice is approved' : 'Your flexi-basket choice needs changes', body: note ?? 'It applies from the next payroll', link: '/payroll?tab=flexi', entityType: 'flexi_choice', entityId: id })
    return { status: approve ? 'approved' : 'returned' }
  },
}

// Payroll: the approved choice splits the pot line into named components (same total; any rest stays as the pot)
export async function applyFlexi(employeeId: string, structure: { id: string; flexiPotCode: string | null }, lines: any[]) {
  if (!structure.flexiPotCode) return lines
  const pot = lines.find((l) => l.code === structure.flexiPotCode)
  if (!pot || !(pot.amount > 0)) return lines
  const choice = await prisma.flexiChoice.findUnique({ where: { employeeId_structureId: { employeeId, structureId: structure.id } } })
  if (choice?.status !== 'approved') return lines
  const wanted = Object.entries(choice.choices as Record<string, number>).filter(([, v]) => v > 0)
  const total = wanted.reduce((a, [, v]) => a + v, 0)
  if (!total) return lines
  const scale = total > pot.amount ? pot.amount / total : 1
  const parts = wanted.map(([code, v], i) => ({ ...pot, code: `FLEXI_${code}`, name: `${code} (flexi)`, amount: round2(v * scale), sequence: pot.sequence + i + 1, computationMethod: 'flexi', formulaUsed: `flexi choice ${code}` }))
  const rest = round2(pot.amount - parts.reduce((a, p) => a + p.amount, 0))
  return lines.flatMap((l) => (l === pot ? [...(rest > 0 ? [{ ...pot, amount: rest, name: `${pot.name} (unallocated)` }] : []), ...parts] : [l]))
}

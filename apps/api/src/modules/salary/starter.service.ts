import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'

// One-click starter salary structure for the company's country, so a new company can run payroll without writing
// formulas first. Statutory items use the app's statutory tables (each rate has a source; HR can edit everything after).
type Rule = { code: string; name: string; cat: string; formula?: string; fixed?: number; payslip?: boolean }
const TEMPLATES: Record<string, { name: string; description: string; rules: Rule[] }> = {
  ZM: {
    name: 'Zambia Standard Monthly', description: 'Basic 60%, housing 25%, transport 15% of the monthly wage; NAPSA, NHIMA and PAYE from the statutory tables. Edit the split to match your contracts.',
    rules: [
      { code: 'BASIC', name: 'Basic Salary', cat: 'BASIC', formula: 'result = contract.wageMonthly * 0.60' },
      { code: 'HOUSING', name: 'Housing Allowance', cat: 'ALW', formula: 'result = contract.wageMonthly * 0.25' },
      { code: 'TRANSPORT', name: 'Transport Allowance', cat: 'ALW', formula: 'result = contract.wageMonthly * 0.15' },
      { code: 'GROSS', name: 'Gross Salary', cat: 'GROSS', formula: 'result = categories.BASIC + categories.ALW' },
      { code: 'NAPSA_EMP', name: 'NAPSA (employee)', cat: 'DED', formula: 'result = napsa_employee(categories.GROSS)' },
      { code: 'NHIMA_EMP', name: 'NHIMA (employee)', cat: 'DED', formula: 'result = nhima_employee(categories.BASIC)' },
      { code: 'PAYE_ZM', name: 'PAYE', cat: 'TAX', formula: 'result = compute_zra_paye(categories.GROSS)' },
      { code: 'NAPSA_EMPLOYER', name: 'NAPSA (employer)', cat: 'EMP_CONTRIB', formula: 'result = napsa_employer(categories.GROSS)', payslip: false },
      { code: 'NHIMA_EMPLOYER', name: 'NHIMA (employer)', cat: 'EMP_CONTRIB', formula: 'result = nhima_employer(categories.BASIC)', payslip: false },
      { code: 'NET', name: 'Net Pay', cat: 'NET', formula: 'result = categories.GROSS - categories.DED - categories.TAX' },
    ],
  },
  IN: {
    name: 'India Standard Monthly', description: 'Basic 40%, HRA 50% of basic, special allowance the rest; EPF 12% (capped at 1,800), professional tax 200 (Maharashtra rate: change it for your state) and TDS from the statutory tables.',
    rules: [
      { code: 'BASIC', name: 'Basic Salary', cat: 'BASIC', formula: 'result = contract.wageMonthly * 0.40' },
      { code: 'HRA', name: 'HRA', cat: 'ALW', formula: 'result = categories.BASIC * 0.50' },
      { code: 'SA', name: 'Special Allowance', cat: 'ALW', formula: 'result = max(0, contract.wageMonthly - rules.BASIC - rules.HRA - min(rules.BASIC * 0.12, 1800))' },
      { code: 'GROSS', name: 'Gross Salary', cat: 'GROSS', formula: 'result = categories.BASIC + categories.ALW' },
      { code: 'EPF_EMP', name: 'EPF (employee 12%)', cat: 'DED', formula: 'result = min(categories.BASIC * 0.12, 1800)' },
      { code: 'PT', name: 'Professional Tax', cat: 'DED', fixed: 200 },
      { code: 'TDS', name: 'Income Tax (TDS)', cat: 'TAX', formula: 'result = compute_india_tds(categories.GROSS, categories.DED)' },
      { code: 'EPF_EMPLOYER', name: 'EPF (employer 12%)', cat: 'EMP_CONTRIB', formula: 'result = min(categories.BASIC * 0.12, 1800)', payslip: false },
      { code: 'NET', name: 'Net Pay', cat: 'NET', formula: 'result = categories.GROSS - categories.DED - categories.TAX' },
    ],
  },
  DEFAULT: {
    name: 'Standard Monthly', description: 'Basic 60% and allowance 40% of the monthly wage. No tax or social security yet: add your country\'s statutory rules.',
    rules: [
      { code: 'BASIC', name: 'Basic Salary', cat: 'BASIC', formula: 'result = contract.wageMonthly * 0.60' },
      { code: 'ALLOWANCE', name: 'Allowance', cat: 'ALW', formula: 'result = contract.wageMonthly * 0.40' },
      { code: 'GROSS', name: 'Gross Salary', cat: 'GROSS', formula: 'result = categories.BASIC + categories.ALW' },
      { code: 'NET', name: 'Net Pay', cat: 'NET', formula: 'result = categories.GROSS - categories.DED - categories.TAX' },
    ],
  },
}

export function starterFor(country?: string | null) {
  const key = country && TEMPLATES[country] ? country : 'DEFAULT'
  const t = TEMPLATES[key]
  return { country: key === 'DEFAULT' ? null : key, name: t.name, description: t.description, rules: t.rules.map((r) => ({ code: r.code, name: r.name, category: r.cat, formula: r.formula ?? `fixed ${r.fixed}` })) }
}

export async function createStarterStructure(tenantId: string, userId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { primaryCountry: true } })
  const key = tenant?.primaryCountry && TEMPLATES[tenant.primaryCountry] ? tenant.primaryCountry : 'DEFAULT'
  const t = TEMPLATES[key]
  const code = `${key === 'DEFAULT' ? 'STD' : key}-MONTHLY-STARTER`
  const existing = await prisma.salaryStructure.findFirst({ where: { tenantId, code } })
  if (existing) throw new AppError('The starter structure already exists; edit it under Structures & rules', 409)
  const cats = new Map((await prisma.salaryRuleCategory.findMany({ select: { id: true, code: true } })).map((c) => [c.code, c.id]))
  const structure = await prisma.$transaction(async (tx) => {
    const type = (await tx.salaryStructureType.findFirst({ where: { tenantId, active: true, wageType: 'monthly' } })) ?? (await tx.salaryStructureType.create({ data: { tenantId, name: 'Monthly Employee', wageType: 'monthly' } }))
    const s = await tx.salaryStructure.create({ data: { tenantId, structureTypeId: type.id, name: t.name, code, countryCode: key === 'DEFAULT' ? null : key, description: t.description } })
    await tx.salaryRule.createMany({
      data: t.rules.map((r, i) => ({
        salaryStructureId: s.id, categoryId: cats.get(r.cat)!, name: r.name, code: r.code, sequence: (i + 1) * 10,
        amountType: r.fixed != null ? 'fixed' : 'python_code', amountFixed: r.fixed ?? null, pythonCode: r.formula ?? null, appearsOnPayslip: r.payslip ?? true,
      })),
    })
    return s
  })
  await prisma.auditLog.create({ data: { tenantId, userId, action: 'SALARY_STRUCTURE_CREATED', entityType: 'salary_structure', entityId: structure.id, newValue: { name: t.name, starter: true } } })
  return structure
}

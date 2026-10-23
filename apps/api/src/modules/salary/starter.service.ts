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
  KE: {
    name: 'Kenya Standard Monthly', description: 'Basic 70% and house allowance 30% of the monthly wage; NSSF, SHIF, housing levy and PAYE (after personal relief) from the statutory tables, marked to confirm.',
    rules: [
      { code: 'BASIC', name: 'Basic Salary', cat: 'BASIC', formula: 'result = contract.wageMonthly * 0.70' },
      { code: 'HOUSE', name: 'House Allowance', cat: 'ALW', formula: 'result = contract.wageMonthly * 0.30' },
      { code: 'GROSS', name: 'Gross Salary', cat: 'GROSS', formula: 'result = categories.BASIC + categories.ALW' },
      { code: 'NSSF_EMP', name: 'NSSF (employee)', cat: 'DED', formula: 'result = ke_nssf_employee(categories.GROSS)' },
      { code: 'SHIF', name: 'SHIF', cat: 'DED', formula: 'result = ke_shif(categories.GROSS)' },
      { code: 'AHL_EMP', name: 'Housing Levy (employee)', cat: 'DED', formula: 'result = ke_ahl_employee(categories.GROSS)' },
      { code: 'PAYE_KE', name: 'PAYE', cat: 'TAX', formula: 'result = compute_ke_paye(categories.GROSS - categories.DED)' },
      { code: 'NSSF_EMPLOYER', name: 'NSSF (employer)', cat: 'EMP_CONTRIB', formula: 'result = ke_nssf_employer(categories.GROSS)', payslip: false },
      { code: 'AHL_EMPLOYER', name: 'Housing Levy (employer)', cat: 'EMP_CONTRIB', formula: 'result = ke_ahl_employer(categories.GROSS)', payslip: false },
      { code: 'NET', name: 'Net Pay', cat: 'NET', formula: 'result = categories.GROSS - categories.DED - categories.TAX' },
    ],
  },
  NG: {
    name: 'Nigeria Standard Monthly', description: 'Basic 50%, housing 30%, transport 20% of the monthly wage; pension 8% (employer 10%) and PAYE under the Nigeria Tax Act 2025 from the statutory tables, marked to confirm. Rent relief is not applied.',
    rules: [
      { code: 'BASIC', name: 'Basic Salary', cat: 'BASIC', formula: 'result = contract.wageMonthly * 0.50' },
      { code: 'HOUSING', name: 'Housing Allowance', cat: 'ALW', formula: 'result = contract.wageMonthly * 0.30' },
      { code: 'TRANSPORT', name: 'Transport Allowance', cat: 'ALW', formula: 'result = contract.wageMonthly * 0.20' },
      { code: 'GROSS', name: 'Gross Salary', cat: 'GROSS', formula: 'result = categories.BASIC + categories.ALW' },
      { code: 'PENSION_EMP', name: 'Pension (employee 8%)', cat: 'DED', formula: 'result = ng_pension_employee(categories.BASIC + categories.ALW)' },
      { code: 'PAYE_NG', name: 'PAYE', cat: 'TAX', formula: 'result = compute_ng_paye(categories.GROSS, categories.DED)' },
      { code: 'PENSION_EMPLOYER', name: 'Pension (employer 10%)', cat: 'EMP_CONTRIB', formula: 'result = ng_pension_employer(categories.BASIC + categories.ALW)', payslip: false },
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

// Contractors are paid a fee with tax withheld at a flat rate: no PAYE, pension or health contributions
const CONTRACTOR: Record<string, { name: string; description: string; rules: Rule[] }> = {
  ZM: { name: 'Zambia Contractor Fee', description: 'The monthly fee, less withholding tax at the rate in the statutory tables (confirm it with ZRA).', rules: [
    { code: 'FEE', name: 'Contractor fee', cat: 'BASIC', formula: 'result = contract.wageMonthly' },
    { code: 'GROSS', name: 'Gross fee', cat: 'GROSS', formula: 'result = categories.BASIC' },
    { code: 'WHT_ZM', name: 'Withholding tax', cat: 'TAX', formula: 'result = zm_withholding(categories.GROSS)' },
    { code: 'NET', name: 'Net Pay', cat: 'NET', formula: 'result = categories.GROSS - categories.DED - categories.TAX' },
  ] },
  IN: { name: 'India Contractor Fee', description: 'The monthly fee, less TDS under section 194J at the rate in the statutory tables (confirm it).', rules: [
    { code: 'FEE', name: 'Professional fee', cat: 'BASIC', formula: 'result = contract.wageMonthly' },
    { code: 'GROSS', name: 'Gross fee', cat: 'GROSS', formula: 'result = categories.BASIC' },
    { code: 'TDS_194J', name: 'TDS (194J)', cat: 'TAX', formula: 'result = in_tds_194j(categories.GROSS)' },
    { code: 'NET', name: 'Net Pay', cat: 'NET', formula: 'result = categories.GROSS - categories.DED - categories.TAX' },
  ] },
}

export function starterFor(country?: string | null) {
  const key = country && TEMPLATES[country] ? country : 'DEFAULT'
  const t = TEMPLATES[key]
  return { country: key === 'DEFAULT' ? null : key, name: t.name, description: t.description, rules: t.rules.map((r) => ({ code: r.code, name: r.name, category: r.cat, formula: r.formula ?? `fixed ${r.fixed}` })) }
}

export async function createStarterStructure(tenantId: string, userId: string, kind: 'employee' | 'contractor' = 'employee') {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { primaryCountry: true } })
  if (kind === 'contractor' && !(tenant?.primaryCountry && CONTRACTOR[tenant.primaryCountry])) throw new AppError('A contractor structure is ready for Zambia and India; set the company country first', 400)
  const key = tenant?.primaryCountry && TEMPLATES[tenant.primaryCountry] ? tenant.primaryCountry : 'DEFAULT'
  const t = kind === 'contractor' ? CONTRACTOR[key] : TEMPLATES[key]
  const code = `${key === 'DEFAULT' ? 'STD' : key}-${kind === 'contractor' ? 'CONTRACTOR' : 'MONTHLY'}-STARTER`
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

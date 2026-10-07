import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding salary structures...')

  const tenant = await prisma.tenant.findFirst({ where: { slug: 'marichi-labs' } })
  if (!tenant) throw new Error('Tenant not found — run seed.ts first')

  // ─── RULE CATEGORIES ──────────────────────────────────────
  console.log('Creating salary rule categories...')
  const categories = [
    { name: 'Basic', code: 'BASIC', sequence: 1 },
    { name: 'Allowances', code: 'ALW', sequence: 2 },
    { name: 'Gross', code: 'GROSS', sequence: 3 },
    { name: 'Employer Contributions', code: 'EMP_CONTRIB', sequence: 4 },
    { name: 'Deductions', code: 'DED', sequence: 5 },
    { name: 'Tax', code: 'TAX', sequence: 6 },
    { name: 'Net', code: 'NET', sequence: 7 },
  ]

  const categoryMap: Record<string, string> = {}
  for (const cat of categories) {
    const existing = await prisma.salaryRuleCategory.findUnique({ where: { code: cat.code } })
    if (!existing) {
      const created = await prisma.salaryRuleCategory.create({ data: cat })
      categoryMap[cat.code] = created.id
      console.log(`  ✓ Category: ${cat.name}`)
    } else {
      categoryMap[cat.code] = existing.id
      console.log(`  ~ Category exists: ${cat.name}`)
    }
  }

  // ─── GRADE BANDS (Zambia) ─────────────────────────────────
  console.log('Creating grade bands...')
  const gradeBands = [
    { code: 'ZM-L1', name: 'Level 1 — Junior', salaryMin: 24000, salaryMid: 30000, salaryMax: 36000, currency: 'ZMW' },
    { code: 'ZM-L2', name: 'Level 2 — Mid', salaryMin: 36000, salaryMid: 48000, salaryMax: 60000, currency: 'ZMW' },
    { code: 'ZM-M1', name: 'Manager 1', salaryMin: 60000, salaryMid: 84000, salaryMax: 108000, currency: 'ZMW' },
    { code: 'ZM-M2', name: 'Manager 2 — Senior', salaryMin: 108000, salaryMid: 144000, salaryMax: 180000, currency: 'ZMW' },
    { code: 'ZM-S1', name: 'Senior Leadership', salaryMin: 180000, salaryMid: 240000, salaryMax: 300000, currency: 'ZMW' },
    { code: 'IN-L1', name: 'Level 1 — Junior (India)', salaryMin: 300000, salaryMid: 450000, salaryMax: 600000, currency: 'INR' },
    { code: 'IN-L2', name: 'Level 2 — Mid (India)', salaryMin: 600000, salaryMid: 900000, salaryMax: 1200000, currency: 'INR' },
    { code: 'IN-M1', name: 'Manager 1 (India)', salaryMin: 1200000, salaryMid: 1800000, salaryMax: 2400000, currency: 'INR' },
  ]

  for (const gb of gradeBands) {
    const existing = await prisma.gradeBand.findUnique({ where: { tenantId_code: { tenantId: tenant.id, code: gb.code } } })
    if (!existing) {
      await prisma.gradeBand.create({ data: { tenantId: tenant.id, ...gb } })
      console.log(`  ✓ Grade band: ${gb.code}`)
    } else {
      console.log(`  ~ Grade band exists: ${gb.code}`)
    }
  }

  // ─── SALARY STRUCTURE TYPES ───────────────────────────────
  console.log('Creating salary structure types...')
  const structureTypes = [
    { name: 'Monthly Employee', wageType: 'monthly' },
    { name: 'Contractor', wageType: 'monthly' },
    { name: 'Executive', wageType: 'monthly' },
  ]

  const typeMap: Record<string, string> = {}
  for (const st of structureTypes) {
    const existing = await prisma.salaryStructureType.findUnique({
      where: { tenantId_name: { tenantId: tenant.id, name: st.name } },
    })
    if (!existing) {
      const created = await prisma.salaryStructureType.create({ data: { tenantId: tenant.id, ...st } })
      typeMap[st.name] = created.id
      console.log(`  ✓ Structure type: ${st.name}`)
    } else {
      typeMap[st.name] = existing.id
      console.log(`  ~ Structure type exists: ${st.name}`)
    }
  }

  // ─── ZAMBIA MONTHLY STRUCTURE ─────────────────────────────
  console.log('Creating Zambia Monthly salary structure...')
  const zmStructureCode = 'ZM-MONTHLY-STD'
  let zmStructure = await prisma.salaryStructure.findUnique({
    where: { tenantId_code: { tenantId: tenant.id, code: zmStructureCode } },
  })

  if (!zmStructure) {
    zmStructure = await prisma.salaryStructure.create({
      data: {
        tenantId: tenant.id,
        structureTypeId: typeMap['Monthly Employee'],
        name: 'Zambia Standard Monthly',
        code: zmStructureCode,
        countryCode: 'ZM',
        description: 'Standard monthly salary structure for Zambia — BASIC + allowances + ZRA PAYE + NAPSA',
      },
    })
    console.log(`  ✓ Structure: ${zmStructure.name}`)
  } else {
    console.log(`  ~ Structure exists: Zambia Standard Monthly`)
  }

  const zmRules = [
    { name: 'Basic Salary', code: 'BASIC', sequence: 10, categoryCode: 'BASIC', amountType: 'python_code', pythonCode: 'result = contract.wageMonthly * 0.40', appearsOnPayslip: true },
    { name: 'Housing Allowance', code: 'HRA', sequence: 20, categoryCode: 'ALW', amountType: 'percentage', amountPercentage: 0.20, amountPercentageBase: 'BASIC', appearsOnPayslip: true },
    { name: 'Transport Allowance', code: 'TA', sequence: 30, categoryCode: 'ALW', amountType: 'fixed', amountFixed: 1500, appearsOnPayslip: true },
    { name: 'Medical Allowance', code: 'MED', sequence: 40, categoryCode: 'ALW', amountType: 'fixed', amountFixed: 1000, appearsOnPayslip: true },
    { name: 'Gross Salary', code: 'GROSS', sequence: 50, categoryCode: 'GROSS', amountType: 'python_code', pythonCode: 'result = categories.BASIC + categories.ALW', appearsOnPayslip: true },
    { name: 'NAPSA Employee (5%)', code: 'NAPSA_EMP', sequence: 60, categoryCode: 'DED', amountType: 'python_code', pythonCode: 'result = min(contract.wageMonthly * 0.05, 1073.20)', appearsOnPayslip: true },
    { name: 'NHIMA Employee (1%)', code: 'NHIMA_EMP', sequence: 70, categoryCode: 'DED', amountType: 'percentage', amountPercentage: 0.01, amountPercentageBase: 'GROSS', appearsOnPayslip: true },
    { name: 'ZRA PAYE', code: 'PAYE_ZM', sequence: 80, categoryCode: 'TAX', amountType: 'python_code', pythonCode: 'result = compute_zra_paye(categories.GROSS - categories.DED)', appearsOnPayslip: true },
    { name: 'NAPSA Employer (10%)', code: 'NAPSA_EMPLOYER', sequence: 90, categoryCode: 'EMP_CONTRIB', amountType: 'python_code', pythonCode: 'result = min(contract.wageMonthly * 0.10, 2146.40)', appearsOnPayslip: false },
    { name: 'Net Pay', code: 'NET', sequence: 100, categoryCode: 'NET', amountType: 'python_code', pythonCode: 'result = categories.GROSS - categories.DED - categories.TAX', appearsOnPayslip: true },
  ]

  for (const rule of zmRules) {
    const existing = await prisma.salaryRule.findUnique({
      where: { salaryStructureId_code: { salaryStructureId: zmStructure.id, code: rule.code } },
    })
    if (!existing) {
      await prisma.salaryRule.create({
        data: {
          salaryStructureId: zmStructure.id,
          categoryId: categoryMap[rule.categoryCode],
          name: rule.name,
          code: rule.code,
          sequence: rule.sequence,
          amountType: rule.amountType,
          amountFixed: (rule as any).amountFixed,
          amountPercentage: (rule as any).amountPercentage,
          amountPercentageBase: (rule as any).amountPercentageBase,
          pythonCode: (rule as any).pythonCode,
          appearsOnPayslip: rule.appearsOnPayslip,
        },
      })
      console.log(`  ✓ Rule: ${rule.name}`)
    } else {
      console.log(`  ~ Rule exists: ${rule.name}`)
    }
  }

  // ─── INDIA MONTHLY STRUCTURE ──────────────────────────────
  console.log('Creating India Monthly salary structure...')
  const inStructureCode = 'IN-MONTHLY-STD'
  let inStructure = await prisma.salaryStructure.findUnique({
    where: { tenantId_code: { tenantId: tenant.id, code: inStructureCode } },
  })

  if (!inStructure) {
    inStructure = await prisma.salaryStructure.create({
      data: {
        tenantId: tenant.id,
        structureTypeId: typeMap['Monthly Employee'],
        name: 'India Standard Monthly CTC',
        code: inStructureCode,
        countryCode: 'IN',
        description: 'Standard CTC structure for India — BASIC + HRA + Special Allowance + EPF + TDS',
      },
    })
    console.log(`  ✓ Structure: ${inStructure.name}`)
  } else {
    console.log(`  ~ Structure exists: India Standard Monthly CTC`)
  }

  const inRules = [
    { name: 'Basic Salary', code: 'BASIC', sequence: 10, categoryCode: 'BASIC', amountType: 'python_code', pythonCode: 'result = contract.wageMonthly * 0.40', appearsOnPayslip: true },
    { name: 'HRA', code: 'HRA', sequence: 20, categoryCode: 'ALW', amountType: 'python_code', pythonCode: 'result = categories.BASIC * 0.50', appearsOnPayslip: true },
    { name: 'Special Allowance', code: 'SA', sequence: 30, categoryCode: 'ALW', amountType: 'python_code', pythonCode: 'result = contract.wageMonthly - categories.BASIC - categories.HRA - (contract.wageMonthly * 0.12)', appearsOnPayslip: true },
    { name: 'Gross Salary', code: 'GROSS', sequence: 40, categoryCode: 'GROSS', amountType: 'python_code', pythonCode: 'result = categories.BASIC + categories.ALW', appearsOnPayslip: true },
    { name: 'EPF Employee (12%)', code: 'EPF_EMP', sequence: 50, categoryCode: 'DED', amountType: 'python_code', pythonCode: 'result = min(categories.BASIC * 0.12, 1800)', appearsOnPayslip: true },
    { name: 'Professional Tax', code: 'PT', sequence: 60, categoryCode: 'DED', amountType: 'fixed', amountFixed: 200, appearsOnPayslip: true },
    { name: 'Income Tax (TDS)', code: 'TDS', sequence: 70, categoryCode: 'TAX', amountType: 'python_code', pythonCode: 'result = compute_india_tds(categories.GROSS, categories.DED)', appearsOnPayslip: true },
    { name: 'EPF Employer (12%)', code: 'EPF_EMPLOYER', sequence: 80, categoryCode: 'EMP_CONTRIB', amountType: 'python_code', pythonCode: 'result = min(categories.BASIC * 0.12, 1800)', appearsOnPayslip: false },
    { name: 'Net Pay', code: 'NET', sequence: 90, categoryCode: 'NET', amountType: 'python_code', pythonCode: 'result = categories.GROSS - categories.DED - categories.TAX', appearsOnPayslip: true },
  ]

  for (const rule of inRules) {
    const existing = await prisma.salaryRule.findUnique({
      where: { salaryStructureId_code: { salaryStructureId: inStructure.id, code: rule.code } },
    })
    if (!existing) {
      await prisma.salaryRule.create({
        data: {
          salaryStructureId: inStructure.id,
          categoryId: categoryMap[rule.categoryCode],
          name: rule.name,
          code: rule.code,
          sequence: rule.sequence,
          amountType: rule.amountType,
          amountFixed: (rule as any).amountFixed,
          amountPercentage: (rule as any).amountPercentage,
          amountPercentageBase: (rule as any).amountPercentageBase,
          pythonCode: (rule as any).pythonCode,
          appearsOnPayslip: rule.appearsOnPayslip,
        },
      })
      console.log(`  ✓ Rule: ${rule.name}`)
    } else {
      console.log(`  ~ Rule exists: ${rule.name}`)
    }
  }

  // ─── PAYROLL INPUT TYPES ──────────────────────────────────
  console.log('Creating payroll input types...')
  const inputTypes = [
    { name: 'Manual Bonus', code: 'MANUAL_BONUS', category: 'earnings', description: 'One-off bonus payment' },
    { name: 'Advance Recovery', code: 'ADVANCE_REC', category: 'deductions', description: 'Recovery of salary advance' },
    { name: 'Referral Bonus', code: 'REFERRAL', category: 'earnings', description: 'Employee referral bonus' },
    { name: 'Salary Arrear', code: 'ARREAR', category: 'earnings', description: 'Arrear payment from prior period' },
    { name: 'Leave Encashment', code: 'LEAVE_ENCASH', category: 'earnings', description: 'Leave balance encashment' },
    { name: 'Loan Recovery', code: 'LOAN_REC', category: 'deductions', description: 'Monthly loan EMI recovery' },
  ]

  for (const it of inputTypes) {
    const existing = await prisma.payrollInputType.findUnique({
      where: { tenantId_code: { tenantId: tenant.id, code: it.code } },
    })
    if (!existing) {
      await prisma.payrollInputType.create({ data: { tenantId: tenant.id, ...it } })
      console.log(`  ✓ Input type: ${it.name}`)
    } else {
      console.log(`  ~ Input type exists: ${it.name}`)
    }
  }

  // ─── LINK JOHN BANDA'S CONTRACT TO ZM STRUCTURE ───────────
  console.log('Linking John Banda contract to Zambia salary structure...')
  const johnBanda = await prisma.employee.findFirst({
    where: { tenantId: tenant.id, employeeCode: 'EMP0002' },
    include: { contracts: { where: { status: 'running' }, take: 1 } },
  })

  if (johnBanda?.contracts?.[0]) {
    const gradeBandM1 = await prisma.gradeBand.findUnique({
      where: { tenantId_code: { tenantId: tenant.id, code: 'ZM-M1' } },
    })
    await prisma.employeeContract.update({
      where: { id: johnBanda.contracts[0].id },
      data: {
        salaryStructureId: zmStructure.id,
        gradeBandId: gradeBandM1?.id,
      },
    })
    console.log(`  ✓ John Banda contract linked to ${zmStructure.name}`)
  } else {
    console.log(`  ~ John Banda has no running contract to link`)
  }

  console.log('')
  console.log('✓ Salary seed complete!')
  console.log(`  Structure types: ${Object.keys(typeMap).length}`)
  console.log(`  Salary structures: 2 (Zambia + India)`)
  console.log(`  Salary rules: ${zmRules.length + inRules.length} total`)
  console.log(`  Grade bands: ${gradeBands.length}`)
  console.log(`  Payroll input types: ${inputTypes.length}`)
}

main()
  .catch((err) => {
    console.error('Salary seed failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding payroll test setup...')

  const tenant = await prisma.tenant.findFirst({ where: { slug: 'marichi-labs' } })
  if (!tenant) throw new Error('Tenant not found')

  // 1) Finance user (payroll_admin) — needed for dual approval
  const payrollAdminRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, name: 'payroll_admin' } })
  if (!payrollAdminRole) throw new Error('payroll_admin role not found')

  const financeEmail = 'finance@marichihr.com'
  const existingFinance = await prisma.user.findFirst({ where: { tenantId: tenant.id, email: financeEmail } })
  if (!existingFinance) {
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: financeEmail,
        fullName: 'Finance Approver',
        passwordHash: await bcrypt.hash('Finance@2026', 12),
        active: true,
        userRoles: { create: [{ roleId: payrollAdminRole.id, scopeType: 'org', validFrom: new Date() }] },
      },
    })
    console.log('  ✓ Finance user created: finance@marichihr.com / Finance@2026')
  } else {
    console.log('  ~ Finance user already exists')
  }

  // 2) OTHER_ALW balancing rule on the Zambia structure so GROSS equals the monthly wage
  const zm = await prisma.salaryStructure.findUnique({
    where: { tenantId_code: { tenantId: tenant.id, code: 'ZM-MONTHLY-STD' } },
  })
  const alwCategory = await prisma.salaryRuleCategory.findUnique({ where: { code: 'ALW' } })
  if (!zm || !alwCategory) throw new Error('Zambia structure or ALW category missing — run seed-salary first')

  const existingRule = await prisma.salaryRule.findUnique({
    where: { salaryStructureId_code: { salaryStructureId: zm.id, code: 'OTHER_ALW' } },
  })
  if (!existingRule) {
    await prisma.salaryRule.create({
      data: {
        salaryStructureId: zm.id,
        categoryId: alwCategory.id,
        name: 'Other Allowance (balancing)',
        code: 'OTHER_ALW',
        sequence: 45,
        amountType: 'python_code',
        pythonCode: 'result = max(0, contract.wageMonthly - rules.BASIC - rules.HRA - rules.TA - rules.MED)',
        appearsOnPayslip: true,
      },
    })
    console.log('  ✓ Added OTHER_ALW rule to Zambia structure')
  } else {
    console.log('  ~ OTHER_ALW rule already exists')
  }

  // 3) Make the admin's test contract usable for payroll (running, effective 2026-10-01, linked to ZM structure)
  const admin = await prisma.employee.findFirst({
    where: { tenantId: tenant.id, employeeCode: 'EMP0001' },
    include: { contracts: { orderBy: { createdAt: 'desc' }, take: 1 } },
  })
  const adminContract = admin?.contracts?.[0]
  if (adminContract && adminContract.status !== 'running') {
    const gradeBand = await prisma.gradeBand.findUnique({ where: { tenantId_code: { tenantId: tenant.id, code: 'ZM-M1' } } })
    await prisma.employeeContract.update({
      where: { id: adminContract.id },
      data: {
        status: 'running',
        effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
        salaryStructureId: zm.id,
        gradeBandId: gradeBand?.id,
        stateChangedAt: new Date(),
        stateChangedBy: 'system',
      },
    })
    const steps: Array<[string, string]> = [['new', 'draft'], ['draft', 'confirmed'], ['confirmed', 'running']]
    for (const [fromState, toState] of steps) {
      await prisma.contractStateTransition.create({
        data: { contractId: adminContract.id, fromState, toState, transitionedBy: 'system', reason: 'Dev seed for payroll testing' },
      })
    }
    console.log('  ✓ Admin contract set to running (effective 2026-10-01)')
  } else {
    console.log('  ~ Admin contract already running or missing')
  }

  console.log('✓ Payroll test setup complete')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())

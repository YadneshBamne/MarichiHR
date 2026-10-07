import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding MarichiHR database...')

  // ─── TENANT ───────────────────────────────────────────────
  console.log('Creating tenant...')
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'marichi-labs' },
    update: {},
    create: {
      name: 'Marichi Labs',
      slug: 'marichi-labs',
      countryCodes: ['ZM', 'IN', 'KE', 'NG'],
      baseCurrency: 'ZMW',
      fiscalYearStart: new Date('2026-04-01'),
      timezone: 'Africa/Lusaka',
      active: true,
    },
  })
  console.log(`✓ Tenant: ${tenant.name} (${tenant.id})`)

  // ─── ROLES ────────────────────────────────────────────────
  console.log('Creating roles...')
  const roleNames = [
    { name: 'employee', description: 'Standard employee — self-service access only' },
    { name: 'manager', description: 'Team manager — can approve team leave and attendance' },
    { name: 'hr_admin', description: 'HR Administrator — full org-wide access' },
    { name: 'payroll_admin', description: 'Payroll Admin — run and disburse payroll cycles' },
    { name: 'compliance_officer', description: 'Compliance Officer — configure and file statutory taxes' },
    { name: 'system_admin', description: 'System Admin — manage users, roles, and integrations' },
  ]

  const roles: Record<string, any> = {}
  for (const r of roleNames) {
    const role = await prisma.role.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: r.name } },
      update: {},
      create: {
        tenantId: tenant.id,
        name: r.name,
        description: r.description,
        isSystemRole: true,
      },
    })
    roles[r.name] = role
    console.log(`  ✓ Role: ${role.name}`)
  }

  // ─── LEAVE TYPES ──────────────────────────────────────────
  console.log('Creating leave types...')
  const leaveTypes = [
    {
      name: 'Annual Leave',
      code: 'ANNUAL',
      category: 'annual',
      isPaid: true,
      isStatutory: true,
      accrualType: 'monthly_prorate',
      accrualAmount: 1.67,
      accrualDayOfMonth: 1,
      carryForward: true,
      carryForwardMax: 10,
      carryForwardExpiryMonths: 3,
      encashable: true,
      halfDayAllowed: true,
      approvalLevels: 1,
      sandwichRule: false,
    },
    {
      name: 'Sick Leave',
      code: 'SICK',
      category: 'sick',
      isPaid: true,
      isStatutory: true,
      accrualType: 'annual_lumpsum',
      accrualAmount: 10,
      carryForward: false,
      encashable: false,
      halfDayAllowed: true,
      approvalLevels: 1,
      attachmentRequiredAfterDays: 3,
      sandwichRule: false,
    },
    {
      name: 'Casual Leave',
      code: 'CASUAL',
      category: 'casual',
      isPaid: true,
      isStatutory: false,
      accrualType: 'annual_lumpsum',
      accrualAmount: 6,
      carryForward: false,
      encashable: false,
      halfDayAllowed: true,
      approvalLevels: 1,
      sandwichRule: false,
    },
    {
      name: 'Maternity Leave',
      code: 'MATERNITY',
      category: 'maternity',
      isPaid: true,
      isStatutory: true,
      accrualType: 'manual',
      accrualAmount: 90,
      carryForward: false,
      encashable: false,
      halfDayAllowed: false,
      approvalLevels: 2,
      requiresHrForStatutory: true,
      sandwichRule: false,
    },
    {
      name: 'Paternity Leave',
      code: 'PATERNITY',
      category: 'paternity',
      isPaid: true,
      isStatutory: true,
      accrualType: 'manual',
      accrualAmount: 5,
      carryForward: false,
      encashable: false,
      halfDayAllowed: false,
      approvalLevels: 2,
      requiresHrForStatutory: true,
      sandwichRule: false,
    },
    {
      name: 'Leave Without Pay',
      code: 'LWP',
      category: 'unpaid',
      isPaid: false,
      isStatutory: false,
      accrualType: 'manual',
      accrualAmount: 0,
      carryForward: false,
      encashable: false,
      halfDayAllowed: true,
      approvalLevels: 2,
      sandwichRule: true,
    },
    {
      name: 'Compensatory Off',
      code: 'COMPOFF',
      category: 'compensatory',
      isPaid: true,
      isStatutory: false,
      accrualType: 'manual',
      accrualAmount: 0,
      carryForward: true,
      carryForwardMax: 5,
      carryForwardExpiryMonths: 1,
      encashable: false,
      halfDayAllowed: true,
      approvalLevels: 1,
      sandwichRule: false,
    },
    {
      name: 'Bereavement Leave',
      code: 'BEREAVEMENT',
      category: 'bereavement',
      isPaid: true,
      isStatutory: false,
      accrualType: 'manual',
      accrualAmount: 3,
      carryForward: false,
      encashable: false,
      halfDayAllowed: false,
      approvalLevels: 1,
      sandwichRule: false,
    },
  ]

  for (const lt of leaveTypes) {
    const leaveType = await prisma.leaveType.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: lt.code } },
      update: {},
      create: { tenantId: tenant.id, ...lt },
    })
    console.log(`  ✓ Leave type: ${leaveType.name}`)
  }

  // ─── ACTIVITY TYPES ───────────────────────────────────────
  console.log('Creating activity types...')
  const activityTypes = [
    { name: 'Phone Call', icon: 'phone', defaultDays: 1 },
    { name: 'Email', icon: 'mail', defaultDays: 1 },
    { name: 'Meeting', icon: 'users', defaultDays: 1 },
    { name: 'Document Upload', icon: 'file', defaultDays: 3 },
    { name: 'Follow-up', icon: 'clock', defaultDays: 2 },
    { name: 'Review', icon: 'eye', defaultDays: 3 },
    { name: 'Contract Review', icon: 'file-text', defaultDays: 5 },
    { name: 'Onboarding Task', icon: 'check-square', defaultDays: 7 },
  ]

  for (const at of activityTypes) {
    const existing = await prisma.activityType.findFirst({
      where: { tenantId: tenant.id, name: at.name },
    })
    if (!existing) {
      const activityType = await prisma.activityType.create({
        data: { tenantId: tenant.id, ...at },
      })
      console.log(`  ✓ Activity type: ${activityType.name}`)
    } else {
      console.log(`  ~ Activity type already exists: ${at.name}`)
    }
  }

  // ─── RESOURCE CALENDAR ────────────────────────────────────
  console.log('Creating default resource calendar...')
  const existingCalendar = await prisma.resourceCalendar.findFirst({
    where: { tenantId: tenant.id, name: 'Standard 40h Mon-Fri' },
  })

  let calendar: any
  if (!existingCalendar) {
    calendar = await prisma.resourceCalendar.create({
      data: {
        tenantId: tenant.id,
        name: 'Standard 40h Mon-Fri',
        timezone: 'Africa/Lusaka',
        hoursPerWeek: 40,
        isFlexi: false,
        days: {
          create: [
            { dayOfWeek: 0, hourFrom: 8, hourTo: 17 },
            { dayOfWeek: 1, hourFrom: 8, hourTo: 17 },
            { dayOfWeek: 2, hourFrom: 8, hourTo: 17 },
            { dayOfWeek: 3, hourFrom: 8, hourTo: 17 },
            { dayOfWeek: 4, hourFrom: 8, hourTo: 17 },
          ],
        },
      },
    })
    console.log(`  ✓ Resource calendar: ${calendar.name}`)
  } else {
    calendar = existingCalendar
    console.log(`  ~ Resource calendar already exists`)
  }

  // ─── SHIFT TEMPLATE ───────────────────────────────────────
  console.log('Creating default shift template...')
  const existingShift = await prisma.shiftTemplate.findFirst({
    where: { tenantId: tenant.id, name: 'Standard 8-5' },
  })

  if (!existingShift) {
    const shift = await prisma.shiftTemplate.create({
      data: {
        tenantId: tenant.id,
        name: 'Standard 8-5',
        shiftType: 'fixed',
        startTime: '08:00',
        endTime: '17:00',
        graceLateMinutes: 15,
        graceEarlyOutMinutes: 15,
        halfDayHours: 4,
        fullDayHours: 8,
        overtimeThresholdHours: 8,
        overnight: false,
      },
    })
    console.log(`  ✓ Shift template: ${shift.name}`)
  } else {
    console.log(`  ~ Shift template already exists`)
  }

  // ─── DEFAULT ORG UNIT ─────────────────────────────────────
  console.log('Creating default org unit...')
  const existingOrg = await prisma.orgUnit.findFirst({
    where: { tenantId: tenant.id, name: 'Marichi Labs' },
  })

  let rootOrg: any
  if (!existingOrg) {
    rootOrg = await prisma.orgUnit.create({
      data: {
        tenantId: tenant.id,
        name: 'Marichi Labs',
        type: 'entity',
        countryCode: 'ZM',
        currencyCode: 'ZMW',
      },
    })
    console.log(`  ✓ Root org unit: ${rootOrg.name}`)
  } else {
    rootOrg = existingOrg
    console.log(`  ~ Root org unit already exists`)
  }

  // ─── HR ADMIN USER ────────────────────────────────────────
  console.log('Creating HR Admin user...')
  const adminEmail = 'admin@marichihr.com'
  const adminPassword = 'MarichiHR@2026'
  const passwordHash = await bcrypt.hash(adminPassword, 12)

  const existingUser = await prisma.user.findFirst({
    where: { tenantId: tenant.id, email: adminEmail },
  })

  if (!existingUser) {
    const adminUser = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: adminEmail,
        passwordHash,
        fullName: 'HR Administrator',
        active: true,
        userRoles: {
          create: [
            {
              roleId: roles['hr_admin'].id,
              scopeType: 'org',
              validFrom: new Date(),
            },
            {
              roleId: roles['system_admin'].id,
              scopeType: 'org',
              validFrom: new Date(),
            },
          ],
        },
      },
    })

    const adminEmployee = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: adminUser.id,
        employeeCode: 'EMP0001',
        orgUnitId: rootOrg.id,
        firstName: 'HR',
        lastName: 'Administrator',
        workEmail: adminEmail,
        employmentType: 'full_time',
        employmentStatus: 'active',
        hireDate: new Date(),
        resourceCalendarId: calendar.id,
        taxJurisdiction: 'ZM',
      },
    })

    console.log(`  ✓ HR Admin user created`)
    console.log(`  ✓ HR Admin employee record: ${adminEmployee.employeeCode}`)
    console.log('')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  FIRST LOGIN CREDENTIALS')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`  Email    : ${adminEmail}`)
    console.log(`  Password : ${adminPassword}`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  } else {
    console.log(`  ~ HR Admin user already exists`)
  }

  console.log('')
  console.log('✓ Seed complete!')
}

main()
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

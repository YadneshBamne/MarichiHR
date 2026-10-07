import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding expense categories, per-diem rates and FX rates...')

  const tenant = await prisma.tenant.findFirst({ where: { slug: 'marichi-labs' } })
  if (!tenant) throw new Error('Tenant not found — run seed.ts first')

  // PLACEHOLDER — replace with real policy and rates
  const categories = [
    { name: 'Travel', code: 'TRAVEL', receiptRequiredAbove: 100 },
    { name: 'Meals', code: 'MEALS', maxAmount: 150, enforceLimit: true },
    { name: 'Accommodation', code: 'ACCOM', receiptRequiredAbove: 100 },
    { name: 'Communication', code: 'COMM' },
    { name: 'Other', code: 'OTHER' },
  ]
  for (const c of categories) {
    const existing = await prisma.expenseCategory.findUnique({ where: { tenantId_code: { tenantId: tenant.id, code: c.code } } })
    if (existing) { console.log(`  ~ Category exists: ${c.name}`); continue }
    await prisma.expenseCategory.create({ data: { tenantId: tenant.id, ...c } })
    console.log(`  ✓ Category: ${c.name}`)
  }

  // PLACEHOLDER — replace with real policy and rates
  const rates = [
    { countryCode: 'ZM', ratePerDay: 300, currency: 'ZMW' },
    { countryCode: 'KE', ratePerDay: 120, currency: 'USD' },
  ]
  for (const r of rates) {
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z')
    const existing = await prisma.perDiemRate.findFirst({ where: { tenantId: tenant.id, countryCode: r.countryCode, city: null, effectiveFrom } })
    if (existing) { console.log(`  ~ Per-diem rate exists: ${r.countryCode}`); continue }
    await prisma.perDiemRate.create({ data: { tenantId: tenant.id, ...r, city: null, effectiveFrom } })
    console.log(`  ✓ Per-diem rate: ${r.countryCode} ${r.ratePerDay} ${r.currency}/day`)
  }

  // PLACEHOLDER — replace with real policy and rates
  const fxFrom = new Date('2026-01-01T00:00:00.000Z')
  const fx = await prisma.fxRate.findUnique({
    where: { tenantId_fromCurrency_toCurrency_effectiveFrom: { tenantId: tenant.id, fromCurrency: 'USD', toCurrency: 'ZMW', effectiveFrom: fxFrom } },
  })
  if (fx) console.log('  ~ FX rate exists: USD→ZMW')
  else {
    await prisma.fxRate.create({ data: { tenantId: tenant.id, fromCurrency: 'USD', toCurrency: 'ZMW', rate: 25, effectiveFrom: fxFrom } })
    console.log('  ✓ FX rate: USD→ZMW 25.00 from 2026-01-01')
  }

  console.log('')
  console.log('✓ Expense seed complete')
  console.log(`  Categories: ${await prisma.expenseCategory.count({ where: { tenantId: tenant.id } })}`)
  console.log(`  Per-diem rates: ${await prisma.perDiemRate.count({ where: { tenantId: tenant.id } })}`)
  console.log(`  FX rates: ${await prisma.fxRate.count({ where: { tenantId: tenant.id } })}`)
}

main()
  .catch((err) => {
    console.error('Expense seed failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

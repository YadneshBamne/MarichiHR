import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')

const ymd = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

async function main() {
  console.log(APPLY ? 'APPLY mode' : 'DRY RUN (pass --apply to write changes)')

  const rows = await prisma.attendanceRecord.findMany({
    where: { checkInTime: { not: null }, source: 'auto' },
    include: { employee: { include: { tenant: { select: { timezone: true } } } } },
    orderBy: { date: 'desc' },
  })

  // Rows can shift in a chain (09-29 -> 09-30 -> 10-01), so process latest-first and track occupancy
  const all = await prisma.attendanceRecord.findMany({ select: { employeeId: true, date: true } })
  const occupied = new Set(all.map((a) => `${a.employeeId}|${a.date.toISOString().slice(0, 10)}`))

  let fixed = 0, ok = 0, conflicts = 0
  for (const r of rows) {
    const tz = r.employee.tenant.timezone || 'UTC'
    const expected = ymd(r.checkInTime!, tz)
    const stored = r.date.toISOString().slice(0, 10)
    if (expected === stored) { ok++; continue }

    const target = new Date(`${expected}T00:00:00.000Z`)
    if (occupied.has(`${r.employeeId}|${expected}`)) {
      conflicts++
      console.log(`CONFLICT ${r.employee.employeeCode}: ${stored} -> ${expected} (row already exists, left unchanged)`)
      continue
    }
    console.log(`${APPLY ? 'FIX' : 'WOULD FIX'} ${r.employee.employeeCode}: ${stored} -> ${expected} (${r.status}, checkIn ${r.checkInTime!.toISOString()}, locked=${r.isLocked})`)
    if (APPLY) {
      await prisma.attendanceRecord.update({ where: { id: r.id }, data: { date: target } })
    }
    occupied.delete(`${r.employeeId}|${stored}`)
    occupied.add(`${r.employeeId}|${expected}`)
    fixed++
  }
  console.log(`\nChecked ${rows.length} auto rows: ${ok} correct, ${fixed} ${APPLY ? 'fixed' : 'to fix'}, ${conflicts} conflicts`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())

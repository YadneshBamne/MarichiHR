import { Prisma } from '@prisma/client'
import { prisma } from '../../infrastructure/database/prisma'
import { businessToday } from '../../shared/utils/businessDate'
import { lastYearEnd } from './yearend.service'

// Automatic leave credits, safe to run any number of times (daily job, on joining, by hand):
//  - Monthly accrual: the type's days once per person and month.
//  - Annual lump sum: the type's yearly days once per person and leave year (the company's fiscal year). A person
//    who joins during the year gets the share of months left, counting the joining month, rounded to half days.
//    The new year's credit waits until that year's year-end run has closed the old balances, so it is never lapsed.
// A per-company database lock makes concurrent runs (job + new hire) wait for each other, so nothing is credited twice.
// ponytail: re-running a rolled-back year end later treats this year's lump sum as old balance; roll back credits by hand then.

type Tx = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>
const DAY = 86_400_000
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const halfDays = (n: number) => Math.round(n * 2) / 2

// All credits of one run in two statements: the allocation rows, then one upsert that adds to each balance
async function apply(tx: Tx, rows: { employeeId: string; leaveTypeId: string; daysAllocated: number; allocationType: string; validFrom: Date; validUntil?: Date; reason: string }[]) {
  if (!rows.length) return
  await tx.leaveAllocation.createMany({ data: rows.map((r) => ({ ...r, approvedBy: 'system', status: 'approved' })) })
  const now = new Date()
  await tx.$executeRaw`
    INSERT INTO leave_balances ("employeeId", "leaveTypeId", "balanceDays", "usedDays", "pendingDays", "encashedDays", "lapsedDays", "asOfDate")
    VALUES ${Prisma.join(rows.map((r) => Prisma.sql`(${r.employeeId}, ${r.leaveTypeId}, ${r.daysAllocated}, 0, 0, 0, 0, ${now})`))}
    ON CONFLICT ("employeeId", "leaveTypeId") DO UPDATE SET "balanceDays" = leave_balances."balanceDays" + EXCLUDED."balanceDays", "asOfDate" = EXCLUDED."asOfDate"`
}

export async function creditLeave(tenantId: string, only?: { employeeId: string }) {
  const today = await businessToday(tenantId)
  const yearStart = new Date((await lastYearEnd(tenantId, today)).getTime() + DAY)
  const yearEndDay = new Date(Date.UTC(yearStart.getUTCFullYear() + 1, yearStart.getUTCMonth(), 1) - DAY)
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
  const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))
  const monthLabel = monthStart.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'leave-credit:' + tenantId}))`
    const [types, people, tenant, closed] = await Promise.all([
      tx.leaveType.findMany({ where: { tenantId, active: true, accrualType: { in: ['monthly_prorate', 'annual_lumpsum'] }, accrualAmount: { gt: 0 } } }),
      tx.employee.findMany({ where: { tenantId, active: true, employmentStatus: { not: 'terminated' }, hireDate: { lte: today }, ...(only && { id: only.employeeId }) }, select: { id: true, hireDate: true } }),
      tx.tenant.findUnique({ where: { id: tenantId }, select: { createdAt: true } }),
      tx.leaveYearEndRun.findFirst({ where: { tenantId, yearEnd: new Date(yearStart.getTime() - DAY), status: 'done' }, select: { id: true } }),
    ])
    // A company that existed last leave year gets this year's lump sums only after the year end closed it
    const lumpSumReady = !!closed || !tenant || tenant.createdAt >= yearStart
    if (!types.length || !people.length) return { monthly: 0, lumpSum: 0, waitingForYearEnd: !lumpSumReady }

    const ids = people.map((p) => p.id)
    const done = new Set((await tx.leaveAllocation.findMany({
      where: { employeeId: { in: ids }, leaveTypeId: { in: types.map((t) => t.id) }, OR: [{ allocationType: 'accrual', validFrom: { gte: monthStart, lt: nextMonth } }, { allocationType: 'annual', validFrom: yearStart }] },
      select: { employeeId: true, leaveTypeId: true, allocationType: true },
    })).map((a) => `${a.employeeId}|${a.leaveTypeId}|${a.allocationType}`))

    let monthly = 0, lumpSum = 0
    const rows: Parameters<typeof apply>[1] = []
    for (const p of people) {
      for (const t of types) {
        if (t.accrualType === 'monthly_prorate' && !done.has(`${p.id}|${t.id}|accrual`)) {
          rows.push({ employeeId: p.id, leaveTypeId: t.id, daysAllocated: t.accrualAmount!, allocationType: 'accrual', validFrom: monthStart, reason: `Monthly accrual — ${monthLabel}` })
          monthly++
        }
        if (t.accrualType === 'annual_lumpsum' && lumpSumReady && !done.has(`${p.id}|${t.id}|annual`)) {
          const joined = p.hireDate > yearStart ? p.hireDate : yearStart
          const monthsLeft = (yearEndDay.getUTCFullYear() - joined.getUTCFullYear()) * 12 + yearEndDay.getUTCMonth() - joined.getUTCMonth() + 1
          const days = halfDays((t.accrualAmount! * Math.min(12, monthsLeft)) / 12)
          if (days <= 0) continue
          const share = monthsLeft >= 12 ? '' : ` (${monthsLeft} of 12 months)`
          rows.push({ employeeId: p.id, leaveTypeId: t.id, daysAllocated: days, allocationType: 'annual', validFrom: yearStart, validUntil: yearEndDay, reason: `Yearly credit ${ymd(yearStart)} – ${ymd(yearEndDay)}${share}` })
          lumpSum++
        }
      }
    }
    // Postgres caps one statement at 65535 parameters; 8 per balance row
    for (let i = 0; i < rows.length; i += 5000) await apply(tx, rows.slice(i, i + 5000))
    return { monthly, lumpSum, waitingForYearEnd: !lumpSumReady }
  }, { timeout: 120_000, maxWait: 30_000 })
}

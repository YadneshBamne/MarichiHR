import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { creditLeave } from './credits.service'

// Leave year end. For every active person and paid leave type, what is left (balance − used − pending) is:
//   1. carried forward, up to the type's carry-forward limit (nothing if the type doesn't carry forward)
//   2. encashed from what remains, up to the type's encashment limit (nothing if not encashable)
//   3. lapsed: the rest
// Pending days stay reserved. A negative balance (types that allow it) carries forward as it is. Monthly and yearly
// credits already given for the new leave year are kept aside: they are neither carried, encashed nor lapsed.
// The leave year starts on the company's fiscal-year start month. The run records the change it made to each
// balance, so a rollback subtracts exactly that and keeps any leave taken since.

const round = (n: number) => Math.round(n * 100) / 100
const ymd = (d: Date) => d.toISOString().slice(0, 10)

// The last day of the leave year that ended most recently (on or before `asOf`)
export async function lastYearEnd(tenantId: string, asOf = new Date()) {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { fiscalYearStart: true } })
  const startMonth = t ? t.fiscalYearStart.getUTCMonth() : 0
  const y = asOf.getUTCMonth() >= startMonth ? asOf.getUTCFullYear() : asOf.getUTCFullYear() - 1
  return new Date(Date.UTC(y, startMonth, 1) - 86_400_000) // the day before this leave year began
}

const startedAfter = async (tenantId: string, yearEnd: Date) => {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { createdAt: true } })
  return !!t && t.createdAt.getTime() > yearEnd.getTime() + 86_400_000
}

export async function computeYearEnd(tenantId: string) {
  const newYearStart = new Date((await lastYearEnd(tenantId)).getTime() + 86_400_000)
  const [balances, credits] = await Promise.all([
    prisma.leaveBalance.findMany({
      where: { employee: { tenantId, active: true }, leaveType: { tenantId, active: true, isPaid: true } },
      include: { leaveType: true, employee: { select: { firstName: true, lastName: true, employeeCode: true } } },
    }),
    // Automatic credits that already belong to the new leave year stay out of the closing (never carried or lapsed)
    prisma.leaveAllocation.groupBy({ by: ['employeeId', 'leaveTypeId'], where: { employee: { tenantId }, allocationType: { in: ['annual', 'accrual'] }, validFrom: { gte: newYearStart } }, _sum: { daysAllocated: true } }),
  ])
  const fresh = new Map(credits.map((c) => [`${c.employeeId}|${c.leaveTypeId}`, c._sum.daysAllocated ?? 0]))
  return balances.map((b) => {
    const lt = b.leaveType
    const newYear = fresh.get(`${b.employeeId}|${b.leaveTypeId}`) ?? 0
    const available = round(b.balanceDays - b.usedDays - b.pendingDays - newYear)
    let carried = 0, encashed = 0, lapsed = 0
    if (available < 0) carried = available
    else {
      carried = Math.min(available, lt.carryForward ? lt.carryForwardMax ?? available : 0)
      const rest = available - carried
      encashed = lt.encashable ? Math.min(rest, lt.encashMaxDays ?? rest) : 0
      lapsed = rest - encashed
    }
    const newBalance = round(carried + b.pendingDays + newYear)
    return {
      employeeId: b.employeeId, leaveTypeId: b.leaveTypeId, employee: `${b.employee.firstName} ${b.employee.lastName}`, employeeCode: b.employee.employeeCode, leaveType: lt.name,
      available, carried: round(carried), encashed: round(encashed), lapsed: round(lapsed), dBalance: round(newBalance - b.balanceDays), dUsed: round(-b.usedDays),
    }
  })
}

const totalsOf = (rows: Awaited<ReturnType<typeof computeYearEnd>>) => ({
  people: new Set(rows.map((r) => r.employeeId)).size,
  carried: round(rows.reduce((s, r) => s + r.carried, 0)), encashed: round(rows.reduce((s, r) => s + r.encashed, 0)), lapsed: round(rows.reduce((s, r) => s + r.lapsed, 0)),
})

export const yearEndService = {
  async preview(tenantId: string) {
    const [yearEnd, rows, done] = await Promise.all([lastYearEnd(tenantId), computeYearEnd(tenantId), prisma.leaveYearEndRun.findMany({ where: { tenantId }, orderBy: { ranAt: 'desc' }, take: 10 })])
    const alreadyRun = done.some((r) => r.status === 'done' && ymd(r.yearEnd) === ymd(yearEnd))
    // A company that started after that date has no earlier leave year to close
    const firstYear = await startedAfter(tenantId, yearEnd)
    const nextYearEnd = new Date(Date.UTC(yearEnd.getUTCFullYear() + 1, yearEnd.getUTCMonth() + 1, 1) - 86_400_000)
    return { yearEnd: ymd(yearEnd), alreadyRun, firstYear, nextYearEnd: ymd(nextYearEnd), rows, totals: totalsOf(rows), runs: done.map((r) => ({ id: r.id, yearEnd: ymd(r.yearEnd), status: r.status, automatic: r.automatic, ranAt: r.ranAt, rolledBackAt: r.rolledBackAt, totals: r.totals })) }
  },

  // `who` is null for the automatic run
  async run(tenantId: string, who: AccessUser | null) {
    const yearEnd = await lastYearEnd(tenantId)
    const existing = await prisma.leaveYearEndRun.findFirst({ where: { tenantId, yearEnd, status: 'done' } })
    if (existing) throw new AppError(`The leave year ending ${ymd(yearEnd)} has already been closed`, 409)
    if (await startedAfter(tenantId, yearEnd)) throw new AppError(`Nothing to close: your company started after ${ymd(yearEnd)}. Your first leave year closes by itself when it ends.`, 400)
    const rows = await computeYearEnd(tenantId)
    const run = await prisma.$transaction(async (tx) => {
      for (const r of rows) {
        await tx.leaveBalance.update({
          where: { employeeId_leaveTypeId: { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId } },
          data: { balanceDays: { increment: r.dBalance }, usedDays: { increment: r.dUsed }, encashedDays: { increment: r.encashed }, lapsedDays: { increment: r.lapsed }, asOfDate: new Date() },
        })
      }
      return tx.leaveYearEndRun.create({ data: { tenantId, yearEnd, automatic: !who, ranBy: who?.userId ?? null, rows: rows as any, totals: totalsOf(rows) } })
    }, { timeout: 60_000 })
    // The new leave year's lump sums can now be credited on top of what was carried forward
    await creditLeave(tenantId)
    await prisma.auditLog.create({ data: { tenantId, userId: who?.userId ?? null, action: 'LEAVE_YEAR_CLOSED', entityType: 'leave_year_end', entityId: run.id, newValue: { yearEnd: ymd(yearEnd), ...totalsOf(rows) } } })
    // Encashed days are paid through payroll: let the payroll team know what to add
    const encashed = rows.filter((r) => r.encashed > 0)
    if (encashed.length) {
      const to = [...new Set([...(await userIdsWithRole(tenantId, 'payroll_admin')), ...(await userIdsWithRole(tenantId, 'hr_admin'))])]
      await notify({ tenantId, userIds: to, type: 'leave.encashment', title: `Leave encashment: ${encashed.length} balance${encashed.length === 1 ? '' : 's'} to pay`, body: `${totalsOf(encashed).encashed} days in total from the leave year ending ${ymd(yearEnd)}`, link: '/leave-types', entityType: 'leave_year_end', entityId: run.id, eventId: `leave-yearend:${run.id}` })
    }
    return { id: run.id, yearEnd: ymd(yearEnd), totals: totalsOf(rows) }
  },

  // Only the latest run, and only once. Leave taken after the run is kept.
  async rollback(u: AccessUser, id: string) {
    const run = await prisma.leaveYearEndRun.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!run) throw new AppError('Year-end run not found', 404)
    if (run.status !== 'done') throw new AppError('This run was already rolled back', 400)
    const latest = await prisma.leaveYearEndRun.findFirst({ where: { tenantId: u.tenantId, status: 'done' }, orderBy: { ranAt: 'desc' } })
    if (latest?.id !== id) throw new AppError('Only the latest year-end run can be rolled back', 400)
    const rows = run.rows as any[]
    await prisma.$transaction(async (tx) => {
      for (const r of rows) {
        await tx.leaveBalance.updateMany({
          where: { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId },
          data: { balanceDays: { decrement: r.dBalance }, usedDays: { decrement: r.dUsed }, encashedDays: { decrement: r.encashed }, lapsedDays: { decrement: r.lapsed } },
        })
      }
      await tx.leaveYearEndRun.update({ where: { id }, data: { status: 'rolled_back', rolledBackBy: u.userId, rolledBackAt: new Date() } })
    }, { timeout: 60_000 })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'LEAVE_YEAR_ROLLED_BACK', entityType: 'leave_year_end', entityId: id, newValue: { yearEnd: ymd(run.yearEnd) } } })
    return { rolledBack: true }
  },
}

// Daily job: on the first day of the leave year, close the year that just ended (once)
export async function autoYearEnd(tenantId: string) {
  const yearEnd = await lastYearEnd(tenantId)
  if (await startedAfter(tenantId, yearEnd)) return 0
  const firstDay = new Date(yearEnd.getTime() + 86_400_000)
  if (ymd(firstDay) !== ymd(new Date())) return 0
  if (await prisma.leaveYearEndRun.findFirst({ where: { tenantId, yearEnd, status: { in: ['done', 'rolled_back'] } } })) return 0
  await yearEndService.run(tenantId, null)
  return 1
}

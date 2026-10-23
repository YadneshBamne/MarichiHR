import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { policyService } from '../policies/policies.service'

// Success KPIs over a period: how fast leave is decided, how long payroll and expense payouts take, how many people
// use the app, policy acceptance and attrition. Pay KPIs are for Payroll / System admins; people KPIs for HR.

const round1 = (n: number) => Math.round(n * 10) / 10
const avg = (xs: number[]) => (xs.length ? round1(xs.reduce((a, x) => a + x, 0) / xs.length) : null)
const H = 3_600_000, D = 86_400_000

export async function kpis(u: AccessUser, days: number) {
  const hr = u.roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
  const pay = u.roleIds.some((r) => ['payroll_admin', 'system_admin', 'compliance_officer'].includes(r))
  if (!hr && !pay) throw new AppError('Only HR, Payroll and System admins see KPIs', 403)
  const since = new Date(Date.now() - days * D)
  const t = u.tenantId
  const out: Record<string, any> = { days }

  if (hr) {
    const [requests, users, loggedIn, active, clocked, exits] = await Promise.all([
      prisma.leaveRequest.findMany({ where: { employee: { tenantId: t }, appliedAt: { gte: since }, status: { in: ['approved', 'rejected'] } }, select: { appliedAt: true, approvals: { where: { actionedAt: { not: null } }, select: { actionedAt: true }, orderBy: { actionedAt: 'asc' }, take: 1 } } }),
      prisma.user.count({ where: { tenantId: t, active: true, passwordHash: { not: null } } }),
      prisma.user.count({ where: { tenantId: t, active: true, lastLoginAt: { gte: new Date(Date.now() - 30 * D) } } }),
      prisma.employee.count({ where: { tenantId: t, active: true } }),
      prisma.attendanceRecord.findMany({ where: { employee: { tenantId: t }, date: { gte: new Date(Date.now() - 30 * D) }, checkInTime: { not: null } }, select: { employeeId: true }, distinct: ['employeeId'] }),
      prisma.employeeExit.count({ where: { tenantId: t, status: { not: 'cancelled' }, lastWorkingDate: { gte: since } } }),
    ])
    const turn = requests.map((r) => r.approvals[0]?.actionedAt ? (r.approvals[0].actionedAt.getTime() - r.appliedAt.getTime()) / H : null).filter((x): x is number => x != null && x >= 0)
    const policy = await policyService.report(u).then((r) => r.totals).catch(() => null)
    Object.assign(out, {
      leave: { decided: turn.length, avgHours: avg(turn), within24h: turn.length ? Math.round((turn.filter((h) => h <= 24).length / turn.length) * 100) : null },
      adoption: { usersWithLogin: users, activeLast30Days: loggedIn, pct: users ? Math.round((loggedIn / users) * 100) : null },
      attendance: { employees: active, clockedInLast30Days: clocked.length, pct: active ? Math.round((clocked.length / active) * 100) : null },
      policies: policy ? { acceptedPct: policy.rate, overdue: policy.overdue } : null,
      attrition: { leavers: exits, pctOfHeadcount: active ? round1((exits / (active + exits)) * 100) : null },
    })
  }
  if (pay) {
    const [cycles, claims] = await Promise.all([
      prisma.payrollCycle.findMany({ where: { tenantId: t, offCycle: false, disbursedAt: { gte: since } }, select: { createdAt: true, disbursedAt: true, payPeriodEnd: true } }),
      prisma.reimbursementClaim.findMany({ where: { tenantId: t, paidAt: { gte: since } }, select: { createdAt: true, paidAt: true } }),
    ])
    const run = cycles.map((c) => (c.disbursedAt!.getTime() - c.createdAt.getTime()) / D)
    const late = cycles.map((c) => (c.disbursedAt!.getTime() - c.payPeriodEnd.getTime()) / D)
    const claimDays = claims.map((c) => (c.paidAt!.getTime() - c.createdAt.getTime()) / D)
    Object.assign(out, {
      payroll: { runs: cycles.length, avgDaysOpenToPaid: avg(run), avgDaysAfterPeriodEnd: avg(late) },
      expenses: { paid: claims.length, avgDaysToPay: avg(claimDays) },
    })
  }
  return out
}

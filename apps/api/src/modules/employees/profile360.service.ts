import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, assertProfileAccess, canAccessCompensation } from '../../shared/utils/access'

// One page about a person: where they sit (the whole chain above and the people below), time off, this month's
// attendance, pay and awards (compensation access only), how they joined, an exit in progress, and for HR the
// change history. Each block is only filled for viewers allowed to see it; apps a company hasn't installed stay empty.

const name = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`
const brief = { id: true, firstName: true, lastName: true, employeeCode: true, managerId: true, jobPosition: { select: { title: true } }, user: { select: { avatarUrl: true } } } as const
const card = (e: any) => ({ id: e.id, name: name(e), employeeCode: e.employeeCode, title: e.jobPosition?.title ?? null, avatarUrl: e.user?.avatarUrl ?? null })

export async function profile360(user: AccessUser, employeeId: string) {
  await assertProfileAccess(user, employeeId)
  const t = user.tenantId
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: t }, select: { ...brief, hireDate: true, tenant: { select: { modules: true } } } })
  if (!emp) throw new AppError('Employee not found', 404)
  const has = (app: string) => emp.tenant.modules.includes(app)
  const pay = await canAccessCompensation(user, employeeId)
  const hr = user.roleIds.includes('hr_admin')

  // Reporting chain upwards (stops at 10 levels or a loop)
  const chain: ReturnType<typeof card>[] = []
  const seen = new Set([emp.id])
  for (let id = emp.managerId; id && !seen.has(id) && chain.length < 10;) {
    seen.add(id)
    const m = await prisma.employee.findFirst({ where: { id, tenantId: t }, select: brief })
    if (!m) break
    chain.push(card(m))
    id = m.managerId
  }

  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const [reports, balances, attendance, payslip, awards, hiredFrom, exit, history] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId: t, managerId: emp.id, active: true }, select: brief, orderBy: { firstName: 'asc' } }),
    has('leave') ? prisma.leaveBalance.findMany({ where: { employeeId: emp.id, leaveType: { active: true } }, select: { balanceDays: true, usedDays: true, pendingDays: true, leaveType: { select: { name: true, isPaid: true } } } }) : [],
    has('attendance') ? prisma.attendanceRecord.groupBy({ by: ['status'], where: { employeeId: emp.id, date: { gte: monthStart } }, _count: true, _sum: { workedHours: true } }) : [],
    pay && has('payroll') ? prisma.payslip.findFirst({ where: { employeeId: emp.id, payrollCycle: { tenantId: t, status: { in: ['approved', 'disbursed'] } } }, orderBy: { payrollCycle: { payPeriodStart: 'desc' } }, select: { grossEarnings: true, netPay: true, currency: true, payrollCycle: { select: { payPeriodStart: true } } } }) : null,
    pay && has('payroll') ? prisma.incentive.findMany({ where: { tenantId: t, employeeId: emp.id, status: { in: ['approved', 'posted'] } }, select: { amount: true, currency: true, reason: true, createdAt: true, type: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 5 }) : [],
    prisma.candidate.findFirst({ where: { tenantId: t, hiredEmployeeId: emp.id }, select: { source: true, hiredAt: true, referredByEmployeeId: true, opening: { select: { title: true } } } }),
    has('exits') && (hr || pay) ? prisma.employeeExit.findFirst({ where: { tenantId: t, employeeId: emp.id, status: { not: 'cancelled' } }, orderBy: { noticeDate: 'desc' }, select: { exitType: true, status: true, lastWorkingDate: true } }) : null,
    hr ? prisma.auditLog.findMany({ where: { tenantId: t, entityId: emp.id, entityType: 'employee' }, orderBy: { createdAt: 'desc' }, take: 12, select: { action: true, createdAt: true, userId: true, newValue: true } }) : [],
  ])
  const referrer = hiredFrom?.referredByEmployeeId ? await prisma.employee.findFirst({ where: { id: hiredFrom.referredByEmployeeId, tenantId: t }, select: { firstName: true, lastName: true } }) : null
  const actors = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(history.map((h) => h.userId).filter(Boolean) as string[])] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]))

  return {
    chain: chain.reverse(), // top of the company first
    directReports: reports.map(card),
    leave: balances.map((b) => ({ type: b.leaveType.name, paid: b.leaveType.isPaid, available: b.balanceDays, used: b.usedDays, pending: b.pendingDays })),
    attendanceThisMonth: attendance.length ? {
      days: Object.fromEntries(attendance.map((a) => [a.status, a._count])),
      hours: Math.round(attendance.reduce((s, a) => s + (a._sum.workedHours ?? 0), 0) * 100) / 100,
    } : null,
    lastPayslip: payslip ? { month: payslip.payrollCycle.payPeriodStart.toISOString().slice(0, 7), gross: Number(payslip.grossEarnings), net: Number(payslip.netPay), currency: payslip.currency } : null,
    awards: awards.map((a) => ({ type: a.type.name, amount: Number(a.amount), currency: a.currency, reason: a.reason, at: a.createdAt })),
    joined: { hireDate: emp.hireDate, viaRecruitment: hiredFrom ? { opening: hiredFrom.opening.title, source: hiredFrom.source, referredBy: referrer ? name(referrer) : null } : null },
    exit: exit ? { type: exit.exitType, status: exit.status, lastWorkingDate: exit.lastWorkingDate } : null,
    history: history.map((h) => ({ action: h.action, at: h.createdAt, by: h.userId ? actors.get(h.userId) ?? null : null, fields: h.newValue && typeof h.newValue === 'object' && !Array.isArray(h.newValue) ? Object.keys(h.newValue as object).filter((k) => !/password|bank|secret|token/i.test(k)).slice(0, 6) : [] })),
    can: { seePay: pay, seeHistory: hr },
  }
}

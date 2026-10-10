import { Router } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { prisma } from '../../infrastructure/database/prisma'
import { tenantModules } from '../../middleware/module.middleware'
import { businessToday, monthRange } from '../../shared/utils/businessDate'
import { holidayMap, holidaysBetween, holidayTargetOf } from '../../shared/utils/holidays'
import { announcementService } from '../announcements/announcements.service'

// Role-based home: each section is returned only when the caller's roles (and the company's installed apps) allow it.
//   self    – anyone with an employee record: own attendance, leave, tasks, latest payslip
//   team    – managers (direct reports) and HR (everyone): who is in today, who is off this week, approvals waiting
//   company – HR / system admins: headcount, joiners, exits, people without a login
//   payroll – payroll staff: the cycle in flight, finance approvals, payroll inputs to approve
// Everything is gathered in parallel so the page costs about one database round trip per section.

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const dayMs = 86_400_000

type U = { tenantId: string; userId: string; employeeId?: string; roleIds: string[] }

function scopes(u: U) {
  const r = u.roleIds
  const hr = r.includes('hr_admin') || r.includes('system_admin')
  return {
    self: !!u.employeeId,
    team: hr || (r.includes('manager') && !!u.employeeId),
    company: hr,
    payroll: r.some((x) => ['hr_admin', 'payroll_admin', 'compliance_officer'].includes(x)),
    finance: r.some((x) => ['hr_admin', 'payroll_admin'].includes(x)),
    hr,
  }
}

// Whose team: HR sees the whole company, a manager their direct reports
const teamWhere = (u: U, hr: boolean) => (hr ? { tenantId: u.tenantId, active: true } : { tenantId: u.tenantId, active: true, managerId: u.employeeId })

async function approvalsWaiting(u: U, apps: string[], sc: ReturnType<typeof scopes>) {
  const scopeEmp = sc.hr ? { tenantId: u.tenantId } : { tenantId: u.tenantId, managerId: u.employeeId }
  const canApprove = sc.team
  const [leave, regs, ot, exp, fin, signoffs] = await Promise.all([
    canApprove && apps.includes('leave') ? prisma.leaveRequest.findMany({ where: { status: 'pending', employee: scopeEmp, NOT: { employeeId: u.employeeId ?? '' } }, select: { id: true, startDate: true, endDate: true, totalDays: true, appliedAt: true, leaveType: { select: { name: true } }, employee: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { appliedAt: 'asc' }, take: 20 }) : [],
    canApprove && apps.includes('attendance') ? prisma.attendanceRegularisation.findMany({ where: { status: 'pending', employee: scopeEmp, NOT: { employeeId: u.employeeId ?? '' } }, select: { id: true, date: true, createdAt: true, employee: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'asc' }, take: 20 }) : [],
    canApprove && apps.includes('attendance') ? prisma.overtimeRequest.count({ where: { status: 'pending', employee: scopeEmp, NOT: { employeeId: u.employeeId ?? '' } } }) : 0,
    canApprove && apps.includes('expenses') ? prisma.reimbursementClaim.count({ where: { tenantId: u.tenantId, status: 'submitted', ...(sc.hr ? {} : { employee: { managerId: u.employeeId } }) } }) : 0,
    sc.finance && apps.includes('expenses') ? prisma.reimbursementClaim.count({ where: { tenantId: u.tenantId, status: 'manager_approved' } }) : 0,
    apps.includes('exits') ? prisma.exitClearance.count({ where: { responsibleUserId: u.userId, status: 'pending', exit: { tenantId: u.tenantId, status: 'initiated' } } }) : 0,
  ])
  const name = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`
  const items = [
    ...leave.map((l) => ({ kind: 'leave', id: l.id, who: name(l.employee), employeeId: l.employee.id, title: `${l.leaveType.name} · ${l.totalDays} day${l.totalDays === 1 ? '' : 's'}`, detail: `${ymd(l.startDate)} to ${ymd(l.endDate)}`, at: l.appliedAt, link: '/approvals' })),
    ...regs.map((r) => ({ kind: 'attendance', id: r.id, who: name(r.employee), employeeId: r.employee.id, title: 'Missed punch correction', detail: ymd(r.date), at: r.createdAt, link: '/approvals' })),
  ].sort((a, b) => +a.at - +b.at)
  return {
    leave: leave.length, attendance: regs.length + ot, expenses: exp, finance: fin, signoffs,
    total: leave.length + regs.length + ot + exp + fin + signoffs,
    items: items.slice(0, 6),
  }
}

export const dashboardRouter = Router()
dashboardRouter.use(authenticate)

// Lightweight numbers for the sidebar badges
dashboardRouter.get('/counts', asyncHandler(async (req, res) => {
  const u = req.user as U
  const sc = scopes(u)
  const apps = await tenantModules(u.tenantId)
  const [a, tasks, announcements] = await Promise.all([
    approvalsWaiting(u, apps, sc),
    u.employeeId ? prisma.activity.count({ where: { tenantId: u.tenantId, assignedToId: u.employeeId, status: { in: ['planned', 'overdue'] } } }) : 0,
    announcementService.unreadCount(u as any),
  ])
  res.json({ success: true, data: { approvals: a.leave + a.attendance + a.expenses + a.finance + a.signoffs, tasks, announcements } })
}))

dashboardRouter.get('/', asyncHandler(async (req, res) => {
  const u = req.user as U
  const sc = scopes(u)
  const apps = await tenantModules(u.tenantId)
  const today = await businessToday(u.tenantId)
  const todayStr = ymd(today)
  const { start: monthStart, end: monthEnd } = monthRange(today.getUTCFullYear(), today.getUTCMonth() + 1)
  const weekStart = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * dayMs)
  const weekEnd = new Date(weekStart.getTime() + 6 * dayMs)
  const has = (a: string) => apps.includes(a)

  const self = sc.self ? (async () => {
    const me = u.employeeId!
    const [balances, upcoming, att7, todayRec, monthRecs, tasks, payslip, holidayRows, target] = await Promise.all([
      has('leave') ? prisma.leaveBalance.findMany({ where: { employeeId: me, leaveType: { active: true } }, select: { balanceDays: true, usedDays: true, pendingDays: true, leaveType: { select: { name: true, code: true } } } }) : [],
      has('leave') ? prisma.leaveRequest.findMany({ where: { employeeId: me, status: { in: ['approved', 'pending'] }, endDate: { gte: today } }, select: { id: true, startDate: true, endDate: true, totalDays: true, status: true, leaveType: { select: { name: true } } }, orderBy: { startDate: 'asc' }, take: 4 }) : [],
      has('attendance') ? prisma.attendanceRecord.findMany({ where: { employeeId: me, date: { gte: new Date(today.getTime() - 6 * dayMs), lte: today } }, select: { date: true, workedHours: true, status: true } }) : [],
      has('attendance') ? prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: me, date: today } }, select: { checkInTime: true, checkOutTime: true, workedHours: true, status: true } }) : null,
      has('attendance') ? prisma.attendanceRecord.findMany({ where: { employeeId: me, date: { gte: monthStart, lt: today } }, select: { status: true, workedHours: true } }) : [],
      prisma.activity.findMany({ where: { tenantId: u.tenantId, assignedToId: me, status: { in: ['planned', 'overdue'] } }, select: { id: true, title: true, dueDate: true, activityType: { select: { name: true } } }, orderBy: { dueDate: 'asc' }, take: 8 }),
      has('payroll') ? prisma.payslip.findFirst({ where: { employeeId: me, payrollCycle: { status: { in: ['disbursed', 'locked'] }, payPeriodEnd: { lte: today } } }, select: { id: true, netPay: true, currency: true, payrollCycle: { select: { payPeriodStart: true, payPeriodEnd: true } } }, orderBy: { payrollCycle: { payPeriodEnd: 'desc' } } }) : null,
      holidaysBetween(u.tenantId, monthStart.getTime() < weekStart.getTime() ? monthStart : weekStart, new Date(today.getTime() + 120 * dayMs)),
      holidayTargetOf(me),
    ])
    const myHolidays = holidayMap(holidayRows, target)
    let workingSoFar = 0
    for (let d = new Date(monthStart); d < today; d = new Date(d.getTime() + dayMs)) if (![0, 6].includes(d.getUTCDay()) && !myHolidays.has(ymd(d))) workingSoFar++
    const present = monthRecs.filter((r) => ['present', 'half_day', 'on_leave'].includes(r.status)).length
    return {
      leave: has('leave') ? {
        balances: balances.map((b) => ({ name: b.leaveType.name, code: b.leaveType.code, total: b.balanceDays, used: b.usedDays, pending: b.pendingDays, available: Math.max(0, b.balanceDays - b.usedDays - b.pendingDays) })),
        upcoming: upcoming.map((l) => ({ id: l.id, type: l.leaveType.name, start: ymd(l.startDate), end: ymd(l.endDate), days: l.totalDays, status: l.status })),
      } : null,
      attendance: has('attendance') ? {
        today: { clockedIn: !!todayRec?.checkInTime, clockedOut: !!todayRec?.checkOutTime, checkInTime: todayRec?.checkInTime ?? null, workedHours: todayRec?.workedHours ?? 0, status: todayRec?.status ?? 'not_started' },
        last7: Array.from({ length: 7 }, (_, i) => { const d = ymd(new Date(today.getTime() - (6 - i) * dayMs)); const r = att7.find((x) => ymd(x.date) === d); return { date: d, hours: r?.workedHours ?? 0, status: r?.status ?? null } }),
        month: { workingDays: workingSoFar, present, hours: monthRecs.reduce((a, r) => a + (r.workedHours || 0), 0) },
      } : null,
      holidays: [...myHolidays].filter(([d]) => d >= todayStr).slice(0, 3).map(([date, name]) => ({ date, name })),
      tasks: { open: tasks.length, overdue: tasks.filter((t) => ymd(t.dueDate) < todayStr).length, items: tasks.map((t) => ({ id: t.id, title: t.title, due: ymd(t.dueDate), type: t.activityType?.name ?? null })) },
      payslip: payslip ? { id: payslip.id, net: Number(payslip.netPay), currency: payslip.currency, start: ymd(payslip.payrollCycle.payPeriodStart), end: ymd(payslip.payrollCycle.payPeriodEnd) } : null,
    }
  })() : null

  const team = sc.team ? (async () => {
    const where = teamWhere(u, sc.hr)
    const [members, recsToday, leaveToday, leaveWeek, approvals, weekHolidayRows, viewer] = await Promise.all([
      prisma.employee.findMany({ where: { ...where, NOT: { id: u.employeeId ?? '' } }, select: { id: true, firstName: true, lastName: true, user: { select: { avatarUrl: true } }, jobPosition: { select: { title: true } } }, orderBy: { firstName: 'asc' }, take: 500 }),
      has('attendance') ? prisma.attendanceRecord.findMany({ where: { date: today, employee: where }, select: { employeeId: true, status: true, checkInTime: true } }) : [],
      has('leave') ? prisma.leaveRequest.findMany({ where: { status: 'approved', startDate: { lte: today }, endDate: { gte: today }, employee: where }, select: { employeeId: true } }) : [],
      has('leave') ? prisma.leaveRequest.findMany({ where: { status: 'approved', startDate: { lte: weekEnd }, endDate: { gte: weekStart }, employee: where }, select: { id: true, startDate: true, endDate: true, employee: { select: { id: true, firstName: true, lastName: true } }, leaveType: { select: { name: true } } }, orderBy: { startDate: 'asc' }, take: 30 }) : [],
      approvalsWaiting(u, apps, sc),
      holidaysBetween(u.tenantId, weekStart, weekEnd),
      u.employeeId ? holidayTargetOf(u.employeeId) : Promise.resolve({ countryCode: null, workLocationId: null }),
    ])
    const weekHolidays = [...holidayMap(weekHolidayRows, viewer)].map(([date, name]) => ({ date, name }))
    const onLeave = new Set(leaveToday.map((l) => l.employeeId))
    const rec = new Map(recsToday.map((r) => [r.employeeId, r]))
    const statusOf = (id: string) => (onLeave.has(id) ? 'on_leave' : rec.get(id)?.checkInTime ? 'in' : rec.get(id)?.status === 'absent' ? 'absent' : 'not_in')
    const people = members.map((m) => ({ id: m.id, name: `${m.firstName} ${m.lastName}`, title: m.jobPosition?.title ?? null, avatarUrl: m.user?.avatarUrl ?? null, status: statusOf(m.id) }))
    const tally = (s: string) => people.filter((p) => p.status === s).length
    return {
      scope: sc.hr ? 'company' : 'reports',
      size: people.length,
      today: has('attendance') ? { in: tally('in'), onLeave: tally('on_leave'), absent: tally('absent'), notIn: tally('not_in') } : null,
      people: people.sort((a, b) => ['in', 'on_leave', 'not_in', 'absent'].indexOf(a.status) - ['in', 'on_leave', 'not_in', 'absent'].indexOf(b.status)).slice(0, 10),
      week: { start: ymd(weekStart), end: ymd(weekEnd), holidays: weekHolidays, leave: leaveWeek.map((l) => ({ id: l.id, name: `${l.employee.firstName} ${l.employee.lastName}`, employeeId: l.employee.id, type: l.leaveType.name, start: ymd(l.startDate), end: ymd(l.endDate) })) },
      approvals,
    }
  })() : null

  const company = sc.company ? (async () => {
    const [headcount, joiners, exitsOpen, noLogin, departments] = await Promise.all([
      prisma.employee.count({ where: { tenantId: u.tenantId, active: true } }),
      prisma.employee.count({ where: { tenantId: u.tenantId, active: true, hireDate: { gte: monthStart, lte: monthEnd } } }),
      has('exits') ? prisma.employeeExit.count({ where: { tenantId: u.tenantId, status: { notIn: ['paid', 'cancelled'] } } }) : 0,
      prisma.employee.count({ where: { tenantId: u.tenantId, active: true, user: { passwordHash: null, googleSub: null } } }),
      prisma.orgUnit.findMany({ where: { tenantId: u.tenantId, active: true }, select: { name: true, _count: { select: { employees: { where: { active: true } } } } }, orderBy: { name: 'asc' }, take: 8 }),
    ])
    return { headcount, joiners, exitsOpen, noLogin, departments: departments.map((d) => ({ name: d.name, count: d._count.employees })).filter((d) => d.count) }
  })() : null

  const payroll = sc.payroll && has('payroll') ? (async () => {
    const [cycles, inputs, finance] = await Promise.all([
      prisma.payrollCycle.findMany({ where: { tenantId: u.tenantId }, select: { id: true, payPeriodStart: true, payPeriodEnd: true, status: true, _count: { select: { payslips: true } } }, orderBy: { payPeriodStart: 'desc' }, take: 24 }),
      prisma.payrollInput.count({ where: { approvedBy: null, payslipLineId: null, employeeId: { not: '' }, inputType: { tenantId: u.tenantId } } }),
      has('expenses') && sc.finance ? prisma.reimbursementClaim.count({ where: { tenantId: u.tenantId, status: 'manager_approved' } }) : 0,
    ])
    const open = cycles.filter((c) => c.status !== 'disbursed')
    const focus = open[open.length - 1] ?? cycles[0] ?? null
    const last = cycles.find((c) => c.status === 'disbursed') ?? null
    const shape = (c: typeof cycles[number] | null) => c && { id: c.id, start: ymd(c.payPeriodStart), end: ymd(c.payPeriodEnd), status: c.status, payslips: c._count.payslips }
    return { current: shape(focus), lastPaid: shape(last), openCycles: open.length, inputsToApprove: inputs, expensesAwaitingFinance: finance }
  })() : null

  const [s, t, c, p] = await Promise.all([self, team, company, payroll])
  res.json({ success: true, data: { today: todayStr, apps, scopes: sc, self: s, team: t, company: c, payroll: p } })
}))

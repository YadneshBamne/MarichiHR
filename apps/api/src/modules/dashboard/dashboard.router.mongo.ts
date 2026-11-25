import { Router } from 'express'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { tenantModules } from '../../middleware/module.middleware.mongo'
import { hrScope } from '../../shared/utils/access.mongo'
import { z } from 'zod'
import { validate } from '../../middleware/validate.middleware'
import { CATEGORIES } from '../../infrastructure/notifications/preferences'
import { pushPublicKey, subscribe, unsubscribe } from '../../infrastructure/notifications/push'
import { prisma as mongoPrisma } from '../../infrastructure/database/prisma.mongo'
import { prisma } from '../../infrastructure/database/prisma.stub' // a .mongo file needs the stub to get the Prisma-compatible client
import { Employee, OrgUnit, User, PayrollCycle, PayrollInput, Payslip, Notification } from '../../infrastructure/mongo/mongo'
import { businessToday, monthRange } from '../../shared/utils/businessDate'
import { holidayMap, holidaysBetween, holidayTargetOf } from '../../shared/utils/holidays'
import { workDaysOf, isoWeekday } from '../attendance/policy.service'
import { announcementService } from '../announcements/announcements.service'
import { policyService } from '../policies/policies.service'
import { buildInbox } from '../approvals/inbox.mongo'

// MongoDB version of the home dashboard, the sidebar counts and the notification bell. Each section is returned only when the caller's roles
// (and the company's installed apps) allow it:
//   self    – anyone with an employee record: today's clock-in, hours, leave, tasks, holidays, latest payslip
//   team    – managers (their direct reports) and HR (everyone): who is in today, who is off this week, everything waiting for them
//   company – HR / system admins: headcount, joiners, exits, people without a login
//   payroll – payroll staff: the cycle in flight and what needs approving
// Approvals come from the unified inbox (modules/approvals/inbox.mongo.ts), so the dashboard and the Approvals page never disagree.

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const dayMs = 86_400_000
type U = { tenantId: string; userId: string; employeeId?: string; roleIds: string[] }

// limited = an HR Business Partner (HR admin limited to departments): no company-wide sections
function scopes(u: U, limited = false) {
  const r = u.roleIds
  const hr = !limited && (r.includes('hr_admin') || r.includes('system_admin'))
  return {
    self: !!u.employeeId, team: hr || (r.includes('manager') && !!u.employeeId), company: hr,
    payroll: r.some((x) => ['payroll_admin', 'compliance_officer'].includes(x)), finance: r.some((x) => ['hr_admin', 'payroll_admin'].includes(x)), hr,
  }
}
const teamWhere = (u: U, hr: boolean) => (hr ? { tenantId: u.tenantId, active: true } : { tenantId: u.tenantId, active: true, managerId: u.employeeId })

export const dashboardRouter = Router()
dashboardRouter.use(authenticate)

// Lightweight numbers for the sidebar badges
dashboardRouter.get('/counts', asyncHandler(async (req, res) => {
  const u = req.user as U
  const [inbox, tasks, announcements, policies] = await Promise.all([
    buildInbox(u as any).then((i) => i.total).catch(() => 0),
    u.employeeId ? prisma.activity.count({ where: { tenantId: u.tenantId, assignedToId: u.employeeId, status: { in: ['planned', 'overdue'] } } }) : 0,
    announcementService.unreadCount(u as any).catch(() => 0),
    policyService.pendingCount(u as any).catch(() => 0),
  ])
  res.json({ success: true, data: { approvals: inbox, tasks, announcements, policies } })
}))

// Each person's own arrangement of their dashboard cards: which card sits in which slot ({ 'half-0': 'approvals', ... }). null = the default.
const layouts = () => mongoose.connection.collection('dashboard_layouts')
// It also holds which cards the person chose to hide (`hidden`, a list of card ids). Each field is saved on its own: leaving one out leaves it as it was.
dashboardRouter.get('/layout', asyncHandler(async (req, res) => {
  const d: any = await layouts().findOne({ _id: req.user!.userId } as any)
  res.json({ success: true, data: { slots: d?.slots ?? null, hidden: d?.hidden ?? [] } })
}))
const CardId = z.string().regex(/^[a-z0-9_-]{1,30}$/)
const Slots = z.record(z.string().regex(/^slot-\d{1,2}$/), CardId).refine((o) => Object.keys(o).length <= 40, 'Too many slots')
dashboardRouter.put('/layout', validate(z.object({ body: z.object({ slots: Slots.nullable().optional(), hidden: z.array(CardId).max(40).optional() }).strict() })), asyncHandler(async (req, res) => {
  const { userId, tenantId } = req.user!
  const { slots, hidden } = req.body
  const set: any = { tenantId, updatedAt: new Date() }, unset: any = {}
  if (slots === null) unset.slots = ''; else if (slots) set.slots = slots
  if (hidden) set.hidden = [...new Set(hidden)]
  await layouts().updateOne({ _id: userId } as any, { $set: set, ...(Object.keys(unset).length && { $unset: unset }) }, { upsert: true })
  const d: any = await layouts().findOne({ _id: userId } as any)
  res.json({ success: true, data: { slots: d?.slots ?? null, hidden: d?.hidden ?? [] } })
}))

dashboardRouter.get('/', asyncHandler(async (req, res) => {
  const u = req.user as U
  const sc = scopes(u, !!(await hrScope(u)))
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
      has('payroll') ? (async () => {
        const cycles: any[] = await PayrollCycle.find({ tenantId: u.tenantId, status: { $in: ['disbursed', 'locked'] }, payPeriodEnd: { $lte: today } }).sort({ payPeriodEnd: -1 }).lean()
        for (const c of cycles) {
          const p: any = await Payslip.findOne({ payrollCycleId: c._id, employeeId: me, withheld: { $ne: true } }).lean()
          if (p) return { id: p._id, net: p.netPay, currency: p.currency, start: ymd(c.payPeriodStart), end: ymd(c.payPeriodEnd) }
        }
        return null
      })() : null,
      holidaysBetween(u.tenantId, monthStart.getTime() < weekStart.getTime() ? monthStart : weekStart, new Date(today.getTime() + 120 * dayMs)),
      holidayTargetOf(me),
    ])
    const myHolidays = holidayMap(holidayRows, target)
    let workingSoFar = 0
    const myWeek = await workDaysOf(me) // the person's own working week (a 6-day company counts Saturdays)
    for (let d = new Date(monthStart); d < today; d = new Date(d.getTime() + dayMs)) if (myWeek.has(isoWeekday(d)) && !myHolidays.has(ymd(d))) workingSoFar++
    const present = monthRecs.filter((r: any) => ['present', 'half_day', 'on_leave'].includes(r.status)).length
    return {
      leave: has('leave') ? {
        balances: balances.map((b: any) => ({ name: b.leaveType.name, code: b.leaveType.code, total: b.balanceDays, used: b.usedDays, pending: b.pendingDays, available: Math.max(0, b.balanceDays - b.usedDays - b.pendingDays) })),
        upcoming: upcoming.map((l: any) => ({ id: l.id, type: l.leaveType.name, start: ymd(l.startDate), end: ymd(l.endDate), days: l.totalDays, status: l.status })),
      } : null,
      attendance: has('attendance') ? {
        today: { clockedIn: !!todayRec?.checkInTime, clockedOut: !!todayRec?.checkOutTime, checkInTime: todayRec?.checkInTime ?? null, workedHours: todayRec?.workedHours ?? 0, status: todayRec?.status ?? 'not_started' },
        last7: Array.from({ length: 7 }, (_, i) => { const d = ymd(new Date(today.getTime() - (6 - i) * dayMs)); const r = att7.find((x: any) => ymd(x.date) === d); return { date: d, hours: r?.workedHours ?? 0, status: r?.status ?? null } }),
        month: { workingDays: workingSoFar, present, hours: monthRecs.reduce((a: number, r: any) => a + (r.workedHours || 0), 0) },
      } : null,
      holidays: [...myHolidays].filter(([d]) => d >= todayStr).slice(0, 3).map(([date, name]) => ({ date, name })),
      tasks: { open: tasks.length, overdue: tasks.filter((t: any) => ymd(t.dueDate) < todayStr).length, items: tasks.map((t: any) => ({ id: t.id, title: t.title, due: ymd(t.dueDate), type: t.activityType?.name ?? null })) },
      payslip,
    }
  })() : null

  const team = sc.team ? (async () => {
    const where = teamWhere(u, sc.hr)
    const [members, recsToday, leaveToday, leaveWeek, inbox, weekHolidayRows, viewer] = await Promise.all([
      prisma.employee.findMany({ where: { ...where, NOT: { id: u.employeeId ?? '' } }, select: { id: true, firstName: true, lastName: true, user: { select: { avatarUrl: true } }, jobPosition: { select: { title: true } } }, orderBy: { firstName: 'asc' }, take: 500 }),
      has('attendance') ? prisma.attendanceRecord.findMany({ where: { date: today, employee: where }, select: { employeeId: true, status: true, checkInTime: true } }) : [],
      has('leave') ? prisma.leaveRequest.findMany({ where: { status: 'approved', startDate: { lte: today }, endDate: { gte: today }, employee: where }, select: { employeeId: true } }) : [],
      has('leave') ? prisma.leaveRequest.findMany({ where: { status: 'approved', startDate: { lte: weekEnd }, endDate: { gte: weekStart }, employee: where }, select: { id: true, startDate: true, endDate: true, employee: { select: { id: true, firstName: true, lastName: true } }, leaveType: { select: { name: true } } }, orderBy: { startDate: 'asc' }, take: 30 }) : [],
      buildInbox(u as any).catch(() => ({ items: [], groups: { time: 0, money: 0, people: 0, review: 0 }, total: 0 })),
      holidaysBetween(u.tenantId, weekStart, weekEnd),
      u.employeeId ? holidayTargetOf(u.employeeId) : Promise.resolve({ countryCode: null, workLocationId: null }),
    ])
    const weekHolidays = [...holidayMap(weekHolidayRows, viewer)].map(([date, name]) => ({ date, name }))
    const onLeave = new Set(leaveToday.map((l: any) => l.employeeId))
    const rec = new Map(recsToday.map((r: any) => [r.employeeId, r]))
    const statusOf = (id: string) => (onLeave.has(id) ? 'on_leave' : (rec.get(id) as any)?.checkInTime ? 'in' : (rec.get(id) as any)?.status === 'absent' ? 'absent' : 'not_in')
    const people = members.map((m: any) => ({ id: m.id, name: `${m.firstName} ${m.lastName}`, title: m.jobPosition?.title ?? null, avatarUrl: m.user?.avatarUrl ?? null, status: statusOf(m.id) }))
    const tally = (s: string) => people.filter((p: any) => p.status === s).length
    return {
      scope: sc.hr ? 'company' : 'reports',
      size: people.length,
      today: has('attendance') ? { in: tally('in'), onLeave: tally('on_leave'), absent: tally('absent'), notIn: tally('not_in') } : null,
      people: people.sort((a: any, b: any) => ['in', 'on_leave', 'not_in', 'absent'].indexOf(a.status) - ['in', 'on_leave', 'not_in', 'absent'].indexOf(b.status)).slice(0, 10),
      week: { start: ymd(weekStart), end: ymd(weekEnd), holidays: weekHolidays, leave: leaveWeek.map((l: any) => ({ id: l.id, name: `${l.employee.firstName} ${l.employee.lastName}`, employeeId: l.employee.id, type: l.leaveType.name, start: ymd(l.startDate), end: ymd(l.endDate) })) },
      approvals: { total: inbox.total, groups: inbox.groups, items: inbox.items.slice(0, 6).map((a: any) => ({ key: a.key, type: a.type, label: a.label, who: a.employee, summary: a.summary, count: a.count, at: a.at, link: a.link })) },
    }
  })() : null

  const company = sc.company ? (async () => {
    const [headcount, joiners, noLogin, units, heads, exitsOpen]: any[] = await Promise.all([
      Employee.countDocuments({ tenantId: u.tenantId, active: true }),
      Employee.countDocuments({ tenantId: u.tenantId, active: true, hireDate: { $gte: monthStart, $lte: monthEnd } }),
      (async () => {
        const noPw: any[] = await User.find({ tenantId: u.tenantId, passwordHash: { $in: [null, undefined] }, googleSub: { $in: [null, undefined] } }).select('_id').lean()
        return Employee.countDocuments({ tenantId: u.tenantId, active: true, userId: { $in: noPw.map((x) => x._id) } })
      })(),
      OrgUnit.find({ tenantId: u.tenantId, active: true }).sort({ name: 1 }).limit(8).select('name').lean(),
      Employee.aggregate([{ $match: { tenantId: u.tenantId, active: true } }, { $group: { _id: '$orgUnitId', n: { $sum: 1 } } }]),
      has('exits') ? prisma.employeeExit.count({ where: { tenantId: u.tenantId, status: { notIn: ['paid', 'cancelled'] } } }) : 0,
    ])
    const H = new Map<string, number>(heads.map((h: any) => [h._id, h.n]))
    return { headcount, joiners, exitsOpen, noLogin, departments: units.map((d: any) => ({ name: d.name, count: H.get(d._id) ?? 0 })).filter((d: any) => d.count) }
  })() : null

  const payroll = sc.payroll && has('payroll') ? (async () => {
    const [cycles, inputs, finance]: any[] = await Promise.all([
      PayrollCycle.find({ tenantId: u.tenantId }).sort({ payPeriodStart: -1 }).limit(12).lean(),
      PayrollInput.countDocuments({ tenantId: u.tenantId, approvedBy: { $in: [null, undefined] } }),
      has('expenses') && sc.finance ? prisma.reimbursementClaim.count({ where: { tenantId: u.tenantId, status: 'manager_approved' } }) : 0,
    ])
    const counts: any[] = await Payslip.aggregate([{ $match: { payrollCycleId: { $in: cycles.map((c: any) => c._id) } } }, { $group: { _id: '$payrollCycleId', n: { $sum: 1 } } }])
    const N = new Map<string, number>(counts.map((c: any) => [c._id, c.n]))
    const chrono = [...cycles].reverse() // oldest first, like the Postgres query
    const open = chrono.filter((c: any) => c.status !== 'disbursed')
    const focus = open[open.length - 1] ?? chrono[chrono.length - 1] ?? null
    const last = cycles.find((c: any) => c.status === 'disbursed') ?? null
    const shape = (c: any) => c && { id: c._id, start: ymd(c.payPeriodStart), end: ymd(c.payPeriodEnd), status: c.status, payslips: N.get(c._id) ?? 0 }
    return { current: shape(focus), lastPaid: shape(last), openCycles: open.length, inputsToApprove: inputs, expensesAwaitingFinance: finance }
  })() : null

  const [s, t, c, p] = await Promise.all([self, team, company, payroll])
  res.json({ success: true, data: { today: todayStr, apps, scopes: sc, self: s, team: t, company: c, payroll: p } })
}))

// ─── Notification bell ───
export const notificationsRouter = Router()
notificationsRouter.use(authenticate)

notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const { userId, tenantId } = req.user!
  const where: any = { tenantId, userId, ...(req.query.unread === 'true' && { read: false }) }
  const [rows, unread]: any[] = await Promise.all([
    Notification.find(where).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit) || 30, 100)).lean(),
    Notification.countDocuments({ tenantId, userId, read: { $ne: true } }),
  ])
  const items = rows.map((n: any) => ({ id: n._id, type: n.type, title: n.title, body: n.body, link: n.link, entityType: n.entityType, entityId: n.entityId, readAt: n.read ? n.updatedAt : null, createdAt: n.createdAt }))
  res.json({ success: true, data: { items, unread } })
}))
notificationsRouter.post('/read-all', asyncHandler(async (req, res) => {
  const { userId, tenantId } = req.user!
  const r = await Notification.updateMany({ tenantId, userId, read: { $ne: true } }, { read: true })
  res.json({ success: true, data: { updated: r.modifiedCount } })
}))
notificationsRouter.post('/:id/read', asyncHandler(async (req, res) => {
  const { userId, tenantId } = req.user!
  const n: any = await Notification.findOneAndUpdate({ _id: String(req.params.id), tenantId, userId }, { read: true }, { returnDocument: 'after' }).lean()
  if (!n) throw new AppError('Notification not found', 404)
  res.json({ success: true, data: { id: n._id, readAt: n.updatedAt } })
}))
// Each person's delivery choices per category (the bell always gets everything), and web push on their devices
type Prefs = Record<string, { email?: boolean; whatsapp?: boolean; push?: boolean }>
notificationsRouter.get('/preferences', asyncHandler(async (req, res) => {
  const u: any = await User.findOne({ _id: req.user!.userId, tenantId: req.user!.tenantId }).select('notifyPrefs').lean()
  const prefs = (u?.notifyPrefs ?? {}) as Prefs
  const on = (process.env.NOTIFY_CHANNELS || 'email').split(',').map((c) => c.trim())
  res.json({ success: true, data: {
    channels: { email: on.includes('email'), whatsapp: on.includes('whatsapp'), push: !!pushPublicKey() },
    devices: await mongoPrisma.pushSubscription.count({ where: { userId: req.user!.userId } }),
    categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label, hint: c.hint, mandatory: c.mandatory, email: c.mandatory || prefs[c.key]?.email !== false, whatsapp: c.mandatory || prefs[c.key]?.whatsapp !== false, push: c.mandatory || prefs[c.key]?.push !== false })),
  } })
}))
const Channel = z.object({ email: z.boolean().optional(), whatsapp: z.boolean().optional(), push: z.boolean().optional() }).strict()
const PrefsBody = z.object({ prefs: z.object(Object.fromEntries(CATEGORIES.map((c) => [c.key, Channel.optional()]))).strict() }).strict()
notificationsRouter.put('/preferences', validate(z.object({ body: PrefsBody })), asyncHandler(async (req, res) => {
  const { userId, tenantId } = req.user!
  const u: any = await User.findOne({ _id: userId, tenantId }).select('notifyPrefs').lean()
  if (!u) throw new AppError('User not found', 404)
  const merged: Record<string, unknown> = { ...(u.notifyPrefs ?? {}) }
  for (const [k, v] of Object.entries(req.body.prefs as Record<string, object | undefined>)) {
    if (!v || CATEGORIES.find((c) => c.key === k)?.mandatory) continue // mandatory categories cannot be switched off
    merged[k] = { ...((merged[k] as object) ?? {}), ...v }
  }
  await User.updateOne({ _id: userId, tenantId }, { $set: { notifyPrefs: merged } })
  res.json({ success: true, data: merged })
}))
notificationsRouter.get('/push/key', asyncHandler(async (_req, res) => { res.json({ success: true, data: { key: pushPublicKey() } }) }))
const Sub = z.object({ endpoint: z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'https only'), keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }).strict(), expirationTime: z.number().nullable().optional() }).strict()
notificationsRouter.post('/push/subscribe', validate(z.object({ body: Sub })), asyncHandler(async (req, res) => {
  if (!pushPublicKey()) throw new AppError('Push notifications are not set up on this server', 503)
  await subscribe(req.user!.tenantId, req.user!.userId, req.body, req.headers['user-agent'])
  res.status(201).json({ success: true, data: { subscribed: true } })
}))
notificationsRouter.post('/push/unsubscribe', validate(z.object({ body: z.object({ endpoint: z.string().url().max(1000) }).strict() })), asyncHandler(async (req, res) => {
  await unsubscribe(req.user!.userId, req.body.endpoint)
  res.json({ success: true, data: { subscribed: false } })
}))

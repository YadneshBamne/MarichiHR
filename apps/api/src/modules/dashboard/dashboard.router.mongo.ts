import { Router } from 'express'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { tenantModules } from '../../middleware/module.middleware.mongo'
import { hrScope } from '../../shared/utils/access.mongo'
import { Employee, OrgUnit, User, PayrollCycle, PayrollInput, Payslip, Notification } from '../../infrastructure/mongo/mongo'

// MongoDB version of the home dashboard, the sidebar counts and the notification bell. Only what is ported is shown: the
// people and payroll sections are real; leave, attendance, tasks and holidays come back empty until those modules are ported.

const ymd = (d: Date) => d.toISOString().slice(0, 10)
type U = { tenantId: string; userId: string; employeeId?: string; roleIds: string[] }

function scopes(u: U, limited = false) {
  const r = u.roleIds
  const hr = !limited && (r.includes('hr_admin') || r.includes('system_admin'))
  return {
    self: !!u.employeeId, team: hr || (r.includes('manager') && !!u.employeeId), company: hr,
    payroll: r.some((x) => ['payroll_admin', 'compliance_officer'].includes(x)), finance: r.some((x) => ['hr_admin', 'payroll_admin'].includes(x)), hr,
  }
}

// Payroll runs waiting for a System admin's sign-off (a System admin sees totals only)
async function signoffsWaiting(u: U) {
  if (!u.roleIds.includes('system_admin')) return 0
  const t: any = await mongoose.connection.collection('tenants').findOne({ _id: u.tenantId } as any)
  if (t?.payrollSignoffAbove == null) return 0
  const threshold = Number(t.payrollSignoffAbove.toString())
  const cycles: any[] = await PayrollCycle.find({ tenantId: u.tenantId, status: 'approved', financeApprovedBy: { $ne: null }, signoffBy: { $in: [null, undefined] } }).select('_id').lean()
  let n = 0
  for (const c of cycles) {
    const [r]: any[] = await Payslip.aggregate([{ $match: { payrollCycleId: c._id } }, { $group: { _id: null, net: { $sum: '$netPay' } } }])
    if ((r?.net ?? 0) > threshold) n++
  }
  return n
}

export const dashboardRouter = Router()
dashboardRouter.use(authenticate)

// Lightweight numbers for the sidebar badges
dashboardRouter.get('/counts', asyncHandler(async (req, res) => {
  const u = req.user as U
  const signoffs = await signoffsWaiting(u)
  res.json({ success: true, data: { approvals: signoffs, tasks: 0, announcements: 0, policies: 0 } })
}))

dashboardRouter.get('/', asyncHandler(async (req, res) => {
  const u = req.user as U
  const sc = scopes(u, !!(await hrScope(u)))
  const apps = await tenantModules(u.tenantId)
  const today = new Date(`${ymd(new Date())}T00:00:00.000Z`)
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
  const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0))

  const self = sc.self ? await (async () => {
    const latest: any = apps.includes('payroll') ? await (async () => {
      const cycles: any[] = await PayrollCycle.find({ tenantId: u.tenantId, status: { $in: ['disbursed', 'locked'] }, payPeriodEnd: { $lte: today } }).sort({ payPeriodEnd: -1 }).lean()
      for (const c of cycles) {
        const p: any = await Payslip.findOne({ payrollCycleId: c._id, employeeId: u.employeeId, withheld: { $ne: true } }).lean()
        if (p) return { id: p._id, net: p.netPay, currency: p.currency, start: ymd(c.payPeriodStart), end: ymd(c.payPeriodEnd) }
      }
      return null
    })() : null
    return { leave: null, attendance: null, holidays: [], tasks: { open: 0, overdue: 0, items: [] }, payslip: latest }
  })() : null

  const company = sc.company ? await (async () => {
    const [headcount, joiners, noLogin, units, heads]: any[] = await Promise.all([
      Employee.countDocuments({ tenantId: u.tenantId, active: true }),
      Employee.countDocuments({ tenantId: u.tenantId, active: true, hireDate: { $gte: monthStart, $lte: monthEnd } }),
      (async () => {
        const noPw: any[] = await User.find({ tenantId: u.tenantId, passwordHash: { $in: [null, undefined] }, googleSub: { $in: [null, undefined] } }).select('_id').lean()
        return Employee.countDocuments({ tenantId: u.tenantId, active: true, userId: { $in: noPw.map((x) => x._id) } })
      })(),
      OrgUnit.find({ tenantId: u.tenantId, active: true }).sort({ name: 1 }).limit(8).select('name').lean(),
      Employee.aggregate([{ $match: { tenantId: u.tenantId, active: true } }, { $group: { _id: '$orgUnitId', n: { $sum: 1 } } }]),
    ])
    const H = new Map<string, number>(heads.map((h: any) => [h._id, h.n]))
    return { headcount, joiners, exitsOpen: 0, noLogin, departments: units.map((d: any) => ({ name: d.name, count: H.get(d._id) ?? 0 })).filter((d: any) => d.count) }
  })() : null

  const payroll = sc.payroll && apps.includes('payroll') ? await (async () => {
    const [cycles, inputs]: any[] = await Promise.all([
      PayrollCycle.find({ tenantId: u.tenantId }).sort({ payPeriodStart: -1 }).limit(12).lean(),
      PayrollInput.countDocuments({ tenantId: u.tenantId, approvedBy: { $in: [null, undefined] } }),
    ])
    const counts: any[] = await Payslip.aggregate([{ $match: { payrollCycleId: { $in: cycles.map((c: any) => c._id) } } }, { $group: { _id: '$payrollCycleId', n: { $sum: 1 } } }])
    const N = new Map<string, number>(counts.map((c: any) => [c._id, c.n]))
    const chrono = [...cycles].reverse() // oldest first, like the Postgres query
    const open = chrono.filter((c: any) => c.status !== 'disbursed')
    const focus = open[open.length - 1] ?? chrono[chrono.length - 1] ?? null
    const last = cycles.find((c: any) => c.status === 'disbursed') ?? null
    const shape = (c: any) => c && { id: c._id, start: ymd(c.payPeriodStart), end: ymd(c.payPeriodEnd), status: c.status, payslips: N.get(c._id) ?? 0 }
    return { current: shape(focus), lastPaid: shape(last), openCycles: open.length, inputsToApprove: inputs, expensesAwaitingFinance: 0 }
  })() : null

  const team = sc.team ? { scope: sc.hr ? 'company' : 'reports', size: await Employee.countDocuments({ tenantId: u.tenantId, active: true, ...(sc.hr ? {} : { managerId: u.employeeId }) }), today: null, people: [], week: { start: ymd(today), end: ymd(today), holidays: [], leave: [] }, approvals: { leave: 0, attendance: 0, expenses: 0, finance: 0, signoffs: await signoffsWaiting(u), total: await signoffsWaiting(u), items: [] } } : null

  res.json({ success: true, data: { today: ymd(today), apps, scopes: sc, self, team, company, payroll } })
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
notificationsRouter.get('/preferences', asyncHandler(async (_req, res) => { res.json({ success: true, data: { prefs: {} } }) }))
notificationsRouter.get('/push/key', asyncHandler(async (_req, res) => { res.json({ success: true, data: { key: null } }) }))

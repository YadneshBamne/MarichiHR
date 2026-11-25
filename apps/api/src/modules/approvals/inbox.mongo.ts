import { Router } from 'express'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { tenantHasFeature, tenantModules } from '../../middleware/module.middleware.mongo'
import { Employee, TsWeek, ConfirmationCase, PayrollCycle, PayrollInput, HelpdeskTicket } from '../../infrastructure/mongo/mongo'
import { prisma } from '../../infrastructure/database/prisma.stub' // a .mongo file needs the stub to get the Prisma-compatible client
import { AccessUser } from '../../shared/utils/access'
import { leaveService } from '../leave/leave.service'
import { balancesService } from '../leave/balances.service'
import { attendanceService } from '../attendance/attendance.service'
import { expensesService } from '../expenses/expenses.service'
import { pendingApprovals } from './approvals.service'

// One inbox for everything that is waiting on this person. The server gathers it in one go (one request instead of one per screen)
// and says, for each item, which existing endpoint approves or rejects it, so the screen needs no per-type code. Some things are
// not decided inline (a payroll run, flagged clock-ins, face photos): they show as a counted line that opens the right page.
// MongoDB mode only.
export type Act = { path: string; body?: Record<string, unknown>; noteField?: 'comments' | 'reason' | 'note'; needsNote?: boolean; label?: string }
export type Item = {
  key: string; type: string; group: 'time' | 'money' | 'people' | 'review'; label: string; count: number
  employeeId: string | null; employee: string | null; summary: string; detail: string | null; step: string | null
  at: Date | null; link: string; approve?: Act; reject?: Act; extra?: Act[]; shortfallDays?: number
}

const col = (n: string) => mongoose.connection.collection(n)
const ymd = (d: Date | string) => new Date(d).toISOString().slice(0, 10)
const nm = (e: { firstName: string; lastName: string } | null | undefined) => (e ? `${e.firstName} ${e.lastName}` : null)
const safe = async <T,>(p: () => Promise<T[]>): Promise<T[]> => { try { return await p() } catch { return [] } }

// The five request types that run through approval chains are decided through one route
const chained = (type: string, id: string, label = 'Approve'): Pick<Item, 'approve' | 'reject'> => ({
  approve: { path: `/approvals/${type}/${id}/approve`, body: {}, noteField: 'comments', label },
  reject: { path: `/approvals/${type}/${id}/reject`, noteField: 'comments', needsNote: true },
})
const summary = (key: string, type: string, group: Item['group'], label: string, link: string, count: number, text: string): Item => ({ key, type, group, label, count, employeeId: null, employee: null, summary: text, detail: null, step: null, at: null, link })

export async function buildInbox(u: AccessUser) {
  const { tenantId, userId, employeeId } = u
  const hr = u.roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
  const manager = u.roleIds.includes('manager') || hr
  const payroll = u.roleIds.some((r) => ['payroll_admin', 'compliance_officer'].includes(r))
  const [apps, hasTs, hasConf, hasGeo, hasDev, hasHelp] = await Promise.all([
    tenantModules(tenantId), tenantHasFeature(tenantId, 'timesheets'), tenantHasFeature(tenantId, 'confirmation'),
    tenantHasFeature(tenantId, 'geomark'), tenantHasFeature(tenantId, 'biometricDevices'), tenantHasFeature(tenantId, 'helpdesk'),
  ])
  const has = (a: string) => apps.includes(a)
  const notMine = (id?: string | null) => !employeeId || id !== employeeId

  // Things that run through an approval chain (or the plain manager rule) and are decided on one route
  const chainItems = safe<Item>(async () => (await pendingApprovals(u, false)).filter((c) => c.canAct && notMine(c.employeeId)).map((c) => {
    const type = c.requestType as string
    const group: Item['group'] = type === 'pre_approval' ? 'money' : type === 'policy_exception' ? 'review' : 'time'
    const label = { leave: 'Leave', regularisation: 'Attendance fix', overtime: 'Overtime', pre_approval: 'Pre-approval', policy_exception: 'Policy exception' }[type] ?? type
    return { key: `${type}:${c.requestId}`, type, group, label, count: 1, employeeId: c.employeeId, employee: c.employee, summary: c.summary, detail: null, step: c.of > 1 ? `Step ${c.level} of ${c.of}` : null, at: c.pendingSince, link: '/approvals', ...chained(type, c.requestId) }
  }))
  const leave = manager && has('leave') ? safe<Item>(async () => (await leaveService.listPendingApprovals(employeeId ?? '', tenantId, hr)).filter((r: any) => notMine(r.employeeId)).map((r: any) => ({
    key: `leave:${r.id}`, type: 'leave', group: 'time' as const, label: 'Leave', count: 1, employeeId: r.employeeId, employee: nm(r.employee),
    summary: `${r.leaveType?.name}, ${r.totalDays} day${r.totalDays === 1 ? '' : 's'} (${ymd(r.startDate)} to ${ymd(r.endDate)})`, detail: r.reason ?? null, step: null, at: r.appliedAt, link: '/approvals',
    shortfallDays: r.shortfallDays > 0 ? r.shortfallDays : undefined, ...chained('leave', r.id),
    extra: [{ path: `/leave/requests/${r.id}/return`, noteField: 'note' as const, needsNote: true, label: 'Send back' }],
  }))) : Promise.resolve([] as Item[])
  const regs = manager && has('attendance') ? safe<Item>(async () => (await attendanceService.listPendingRegularisations(employeeId ?? '', tenantId, hr)).filter((r: any) => notMine(r.employeeId)).map((r: any) => ({
    key: `regularisation:${r.id}`, type: 'regularisation', group: 'time' as const, label: 'Attendance fix', count: 1, employeeId: r.employeeId, employee: nm(r.employee),
    summary: `${ymd(r.date)}: in ${r.actualIn ?? '?'}, out ${r.actualOut ?? '?'}`, detail: r.reason ?? null, step: null, at: r.createdAt, link: '/approvals', ...chained('regularisation', r.id),
  }))) : Promise.resolve([] as Item[])
  // (the overtime service only lists a manager's own reports; HR is shown everyone's)
  const overtime = manager && has('attendance') ? safe<Item>(async () => (hr
    ? await prisma.overtimeRequest.findMany({ where: { status: 'pending', employee: { tenantId } }, include: { employee: { select: { firstName: true, lastName: true } } }, orderBy: { createdAt: 'asc' }, take: 200 })
    : await attendanceService.listPendingOvertime(employeeId ?? '')).filter((r: any) => notMine(r.employeeId)).map((r: any) => ({
    key: `overtime:${r.id}`, type: 'overtime', group: 'time' as const, label: 'Overtime', count: 1, employeeId: r.employeeId, employee: nm(r.employee),
    summary: `${r.overtimeHours} h on ${ymd(r.date)}`, detail: r.reason ?? null, step: null, at: r.createdAt, link: '/approvals', ...chained('overtime', r.id),
  }))) : Promise.resolve([] as Item[])
  const allocations = manager && has('leave') ? safe<Item>(async () => (await balancesService.pendingRequests(u)).map((r: any) => ({
    key: `leave_allocation:${r.id}`, type: 'leave_allocation', group: 'time' as const, label: 'Extra leave', count: 1, employeeId: r.employeeId, employee: r.employee,
    summary: `${r.requestedDays} day${r.requestedDays === 1 ? '' : 's'} of ${r.leaveType}`, detail: r.reason ?? null, step: null, at: r.createdAt, link: '/approvals',
    approve: { path: `/leave/allocation-requests/${r.id}/approve`, body: { approvedDays: r.requestedDays }, noteField: 'note' as const, label: 'Approve' },
    reject: { path: `/leave/allocation-requests/${r.id}/reject`, noteField: 'note' as const, needsNote: true },
  }))) : Promise.resolve([] as Item[])

  // Expenses: the manager's step, then finance's
  const claim = (c: any, finance: boolean): Item => ({
    key: `${finance ? 'expense_finance' : 'expense'}:${c.id}`, type: finance ? 'expense_finance' : 'expense', group: 'money', label: finance ? 'Expense (finance)' : 'Expense claim', count: 1,
    employeeId: c.employeeId, employee: nm(c.employee), summary: `${c.homeCurrency} ${Number(c.homeAmount).toLocaleString('en')} · ${c.category?.name ?? 'Expense'}`, detail: c.description ?? null,
    step: c.overLimit ? 'Over the category limit' : null, at: c.createdAt, link: '/expenses',
    approve: { path: `/expenses/claims/${c.id}/${finance ? 'finance-approve' : 'approve'}`, body: {}, label: 'Approve' },
    reject: { path: `/expenses/claims/${c.id}/${finance ? 'finance-reject' : 'reject'}`, noteField: 'reason', needsNote: true },
  })
  const expenses = has('expenses') && manager ? safe<Item>(async () => (await expensesService.listPending(u)).filter((c: any) => notMine(c.employeeId)).map((c: any) => claim(c, false))) : Promise.resolve([] as Item[])
  const finance = has('expenses') && u.roleIds.some((r) => ['hr_admin', 'payroll_admin'].includes(r)) ? safe<Item>(async () => (await expensesService.listAwaitingFinance(u)).filter((c: any) => notMine(c.employeeId)).map((c: any) => claim(c, true))) : Promise.resolve([] as Item[])

  const timesheets = hasTs && manager ? safe<Item>(async () => {
    const team: any[] = hr ? [] : await Employee.find({ tenantId, managerId: employeeId ?? '__none__', active: true }).select('_id').lean()
    const rows: any[] = await TsWeek.find({ tenantId, status: 'submitted', ...(hr ? {} : { employeeId: { $in: team.map((t) => t._id) } }) }).sort({ submittedAt: 1 }).limit(100).lean()
    const emps: any[] = await Employee.find({ tenantId, _id: { $in: rows.map((r) => r.employeeId) } }).select('firstName lastName').lean()
    return rows.filter((r) => notMine(r.employeeId)).map((r) => ({
      key: `timesheet:${r._id}`, type: 'timesheet', group: 'time' as const, label: 'Timesheet', count: 1, employeeId: r.employeeId, employee: nm(emps.find((e) => e._id === r.employeeId)),
      summary: `Week of ${ymd(r.weekStart)}, ${(r.entries ?? []).reduce((a: number, e: any) => a + (e.hours || 0), 0)} h`, detail: null, step: null, at: r.submittedAt ?? r.updatedAt, link: '/timesheets',
      approve: { path: `/timesheets/weeks/${r._id}/decide`, body: { approve: true }, noteField: 'note' as const, label: 'Approve' },
      reject: { path: `/timesheets/weeks/${r._id}/decide`, body: { approve: false }, noteField: 'note' as const, needsNote: true },
    }))
  }) : Promise.resolve([] as Item[])

  // Counted lines that open the right page (decided there, not inline)
  const lines = safe<Item>(async () => {
    const out: Item[] = []
    if (hasConf && manager) {
      const team: any[] = hr ? [] : await Employee.find({ tenantId, managerId: employeeId ?? '__none__', active: true }).select('_id').lean()
      const n = await ConfirmationCase.countDocuments({ tenantId, ...(hr ? { status: 'hr_decision' } : { status: 'manager_review', employeeId: { $in: team.map((t) => t._id) } }) })
      if (n) out.push(summary('confirmation', 'confirmation', 'people', 'Confirmations', '/confirmation', n, `${n} probation review${n === 1 ? '' : 's'} ${hr ? 'to decide' : 'to write'}`))
    }
    if (has('exits')) {
      const n = await prisma.exitClearance.count({ where: { responsibleUserId: userId, status: 'pending', exit: { tenantId, status: 'initiated' } } })
      if (n) out.push(summary('exit_clearance', 'exit_clearance', 'people', 'Exit clearance', '/exits', n, `${n} exit clearance${n === 1 ? '' : 's'} to sign off`))
    }
    if (has('payroll') && payroll) {
      const first = await PayrollCycle.countDocuments({ tenantId, status: 'review' })
      const second = await PayrollCycle.countDocuments({ tenantId, status: 'approved', approvedBy: { $ne: userId } })
      const inputs = await PayrollInput.countDocuments({ tenantId, approvedBy: { $in: [null, undefined] }, addedBy: { $ne: userId } })
      if (first) out.push(summary('payroll_first', 'payroll', 'money', 'Payroll', '/payroll', first, `${first} payroll run${first === 1 ? '' : 's'} waiting for first approval`))
      if (second) out.push(summary('payroll_second', 'payroll', 'money', 'Payroll', '/payroll', second, `${second} payroll run${second === 1 ? '' : 's'} waiting for second approval`))
      if (inputs) out.push(summary('payroll_inputs', 'payroll', 'money', 'Payroll', '/payroll', inputs, `${inputs} payroll input${inputs === 1 ? '' : 's'} to approve`))
    }
    if (has('payroll') && u.roleIds.includes('system_admin')) {
      const t: any = await col('tenants').findOne({ _id: tenantId } as any)
      if (t?.payrollSignoffAbove != null) {
        const n = await PayrollCycle.countDocuments({ tenantId, status: 'approved', financeApprovedBy: { $ne: null }, signoffBy: { $in: [null, undefined] } })
        if (n) out.push(summary('payroll_signoff', 'payroll', 'money', 'Payroll sign-off', '/approvals?tab=signoff', n, `${n} payroll run${n === 1 ? '' : 's'} may need your sign-off`))
      }
    }
    if (hasGeo && manager && has('attendance')) {
      const team: any[] = hr ? [] : await Employee.find({ tenantId, managerId: employeeId ?? '__none__', active: true }).select('_id').lean()
      const n = await col('geomark_checks').countDocuments({ tenantId, status: 'flagged', ...(hr ? {} : { employeeId: { $in: team.map((t) => t._id) } }) } as any)
      if (n) out.push(summary('clock_check', 'clock_check', 'review', 'Clock-in checks', '/geomark', n, `${n} clock-in${n === 1 ? '' : 's'} flagged for a look`))
    }
    if (hasGeo && hr) {
      const n = await col('geomark_enrolments').countDocuments({ tenantId, status: 'pending' } as any)
      if (n) out.push(summary('face_photo', 'face_photo', 'review', 'Face photos', '/geomark', n, `${n} face photo${n === 1 ? '' : 's'} to approve`))
    }
    if (hasDev && hr) {
      const n = await col('device_punches').countDocuments({ tenantId, status: { $in: ['unknown_user', 'rejected'] } } as any)
      if (n) out.push(summary('terminal_punch', 'terminal_punch', 'review', 'Terminals', '/devices', n, `${n} terminal punch${n === 1 ? '' : 'es'} could not be recorded`))
    }
    if (hasHelp && hr) {
      const n = await HelpdeskTicket.countDocuments({ tenantId, status: { $in: ['open', 'in_progress'] }, $or: [{ assigneeUserId: null }, { assigneeUserId: userId }] })
      if (n) out.push(summary('ticket', 'ticket', 'review', 'Helpdesk', '/helpdesk', n, `${n} helpdesk ticket${n === 1 ? '' : 's'} to answer`))
    }
    return out
  })

  const [a, b, c, d, e, f, g, h, i] = await Promise.all([chainItems, leave, regs, overtime, allocations, expenses, finance, timesheets, lines])
  // chain items first (they know the step); the plain lists only add what the chain did not already give
  const seen = new Map<string, Item>()
  for (const it of [...a, ...b, ...c, ...d, ...e, ...f, ...g, ...h, ...i]) if (!seen.has(it.key)) seen.set(it.key, it)
  const items = [...seen.values()].sort((x, y) => (x.at ? +new Date(x.at) : Infinity) - (y.at ? +new Date(y.at) : Infinity)).slice(0, 200)
  const groups = { time: 0, money: 0, people: 0, review: 0 }
  for (const it of items) groups[it.group] += it.count
  return { items, groups, total: groups.time + groups.money + groups.people + groups.review }
}

export const inboxRouter = Router()
inboxRouter.use(authenticate)
inboxRouter.get('/', asyncHandler(async (req, res) => { res.json({ success: true, data: await buildInbox(req.user!) }) }))
inboxRouter.get('/count', asyncHandler(async (req, res) => { res.json({ success: true, data: { total: (await buildInbox(req.user!)).total } }) }))

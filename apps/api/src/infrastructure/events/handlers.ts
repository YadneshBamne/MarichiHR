import { prisma } from '../database/prisma'
import { notify, userIdsWithRole, userIdOfEmployee } from '../notifications/notify'
import { normaliseDateInput } from '../../shared/utils/businessDate'
import { audienceUsers } from '../../shared/utils/audience'
import { runAutomations } from '../../modules/automation/automation.service'
import { queueWebhooks } from '../../modules/automation/integrations.service'
import { creditLeave } from '../../modules/leave/credits.service'
import { postNews } from '../../modules/forums/forum-extras.service'

// Consumers of domain_events, run by the domain-events worker. Each handler must be safe to run twice:
// notifications dedupe on (eventId, userId, type) and data fixes are idempotent.
type Event = { id: string; tenantId: string; eventType: string; payload: any }
type Handler = (e: Event) => Promise<void>

const ymd = (d: unknown) => String(d instanceof Date ? d.toISOString() : d).slice(0, 10)
const hr = (tenantId: string) => userIdsWithRole(tenantId, 'hr_admin')

const toEmployee = (type: string, title: string, body: (p: any) => string, link?: (p: any) => string): Handler => async (e) => {
  const userId = await userIdOfEmployee(e.tenantId, e.payload.employeeId)
  if (userId) await notify({ tenantId: e.tenantId, userIds: [userId], type, title, body: body(e.payload), link: link?.(e.payload), eventId: e.id })
}

const toHR = (type: string, title: string, body: (p: any) => string, link?: (p: any) => string, who = hr): Handler => async (e) => {
  await notify({ tenantId: e.tenantId, userIds: await who(e.tenantId), type, title, body: body(e.payload), link: link?.(e.payload), eventId: e.id })
}
// Contracts are kept by Payroll admins; HR still needs to know when employment ends
const hrAndPayroll = async (tenantId: string) => [...new Set([...(await hr(tenantId)), ...(await userIdsWithRole(tenantId, 'payroll_admin'))])]

export const EVENT_HANDLERS: Record<string, Handler[]> = {
  // A new person gets this month's accrual and the share of this year's lump sums at once (idempotent)
  'employee.created': [
    async (e) => {
      const t = await prisma.tenant.findUnique({ where: { id: e.tenantId }, select: { modules: true } })
      if (t?.modules.includes('leave')) await creditLeave(e.tenantId, { employeeId: e.payload.employeeId })
    },
  ],
  // A new grievance: HR admins learn the ticket, category and severity, never who raised it
  'grievance.raised': [
    async (e) => {
      const g = await prisma.grievance.findFirst({ where: { id: e.payload.grievanceId, tenantId: e.tenantId } })
      if (!g) return
      await notify({ tenantId: e.tenantId, userIds: await hr(e.tenantId), type: 'grievance.raised', title: `New grievance ${g.ticketNo}`, body: `${g.category} · ${g.severity} severity${g.anonymous ? ' · anonymous' : ''}`, link: `/grievances/${g.id}`, entityType: 'grievance', entityId: g.id, eventId: e.id })
    },
  ],
  // A new policy version: everyone in its audience (asked to accept when the policy requires it)
  'policy.published': [
    async (e) => {
      const p = await prisma.policy.findFirst({ where: { id: e.payload.policyId, tenantId: e.tenantId, active: true } })
      if (!p) return
      const users = (await audienceUsers(e.tenantId, p)).map((u) => u.id)
      await notify({ tenantId: e.tenantId, userIds: users, type: 'policy.published', title: p.requiresAcceptance ? 'Policy to read and accept' : 'Policy updated', body: `${p.title} (version ${e.payload.version})`, link: `/policies/${p.id}`, entityType: 'policy', entityId: p.id, eventId: e.id })
    },
    // Company-wide policies are also posted in Community > News (targeted ones stay with their audience)
    async (e) => {
      const p = await prisma.policy.findFirst({ where: { id: e.payload.policyId, tenantId: e.tenantId, active: true } })
      if (!p || p.departmentIds.length || p.workLocationIds.length || p.countries.length) return
      const v = await prisma.policyVersion.findFirst({ where: { policyId: p.id, version: e.payload.version } })
      await postNews(e.tenantId, v?.publishedById ?? p.createdById, `${e.payload.version > 1 ? 'Updated' : 'New'} policy: ${p.title}`, `${p.title} (version ${e.payload.version}) is published.${v?.changeNote ? ` What changed: ${v.changeNote}` : ''}\n\n[Read it](/policies/${p.id})${p.requiresAcceptance ? ' and accept it' : ''}.`, ['policy'], e.id)
    },
  ],
  // Attendance locked for a pay period: the other Payroll admins know the run can be calculated
  'attendance.locked': [
    async (e) => {
      const c = await prisma.payrollCycle.findFirst({ where: { id: e.payload.payrollCycleId, tenantId: e.tenantId } })
      if (!c) return
      const month = c.payPeriodStart.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      await notify({ tenantId: e.tenantId, userIds: (await userIdsWithRole(e.tenantId, 'payroll_admin')).filter((x) => x !== e.payload.lockedBy), type: 'payroll.locked', title: `Attendance locked for ${month}`, body: `${e.payload.recordsLocked} attendance records are now read-only. The payroll can be run.`, link: `/payroll/cycles/${c.id}`, entityType: 'payroll_cycle', entityId: c.id, eventId: e.id })
    },
  ],
  // A payroll was paid: Payroll and System admins get the confirmation; a regular run is announced in News
  'payroll.cycle.disbursed': [
    async (e) => {
      const c = await prisma.payrollCycle.findFirst({ where: { id: e.payload.payrollCycleId, tenantId: e.tenantId } })
      if (!c) return
      const [slips, total] = await Promise.all([prisma.payslip.count({ where: { payrollCycleId: c.id } }), prisma.payslip.aggregate({ where: { payrollCycleId: c.id }, _sum: { netPay: true } })])
      const month = c.payPeriodStart.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      const admins = [...new Set([...(await userIdsWithRole(e.tenantId, 'payroll_admin')), ...(await userIdsWithRole(e.tenantId, 'system_admin'))])]
      await notify({ tenantId: e.tenantId, userIds: admins, type: 'payroll.disbursed', title: `${c.offCycle ? 'Off-cycle payroll' : 'Payroll'} for ${month} paid`, body: `${slips} payslip${slips === 1 ? '' : 's'}, net ${Number(total._sum.netPay ?? 0).toFixed(2)}. Download the bank file from the run if you have not yet.`, link: `/payroll/cycles/${c.id}`, entityType: 'payroll_cycle', entityId: c.id, eventId: e.id })
      if (!c.offCycle) await postNews(e.tenantId, e.payload.disbursedBy, `${month} payroll is paid`, `Payslips for ${month} are ready in [My payslips](/payroll).`, ['payroll'], e.id)
    },
  ],
  // Everyone in the audience except the author
  'announcement.published': [
    async (e) => {
      const a = await prisma.announcement.findFirst({ where: { id: e.payload.announcementId, tenantId: e.tenantId, active: true } })
      if (!a) return
      const users = (await audienceUsers(e.tenantId, a)).map((u) => u.id).filter((id) => id !== a.createdById)
      await notify({ tenantId: e.tenantId, userIds: users, type: 'announcement', title: a.requiresAck ? 'New announcement · please acknowledge' : 'New announcement', body: a.title, link: '/announcements', entityType: 'announcement', entityId: a.id, eventId: e.id })
    },
  ],
  'leave.request.submitted': [
    async (e) => {
      const p = e.payload
      const managerUser = await userIdOfEmployee(e.tenantId, p.managerId)
      await notify({
        tenantId: e.tenantId,
        userIds: managerUser ? [managerUser] : await hr(e.tenantId),
        type: 'leave.approval.requested',
        title: 'Leave request awaiting your approval',
        body: `${p.totalDays} day(s) of ${p.leaveTypeName} from ${ymd(p.startDate)} to ${ymd(p.endDate)}.`,
        link: '/approvals', entityType: 'leave_request', entityId: p.leaveRequestId, eventId: e.id,
      })
    },
  ],
  'leave.request.approved': [
    toEmployee('leave.request.approved', 'Leave approved', (p) => `${p.totalDays} day(s) of ${p.leaveTypeName} from ${ymd(p.startDate)} to ${ymd(p.endDate)} approved.`, () => '/leave'),
    // Approved leave replaces any absence the nightly job marked for those days
    async (e) => {
      const p = e.payload
      await prisma.attendanceRecord.deleteMany({
        where: {
          employeeId: p.employeeId, employee: { tenantId: e.tenantId },
          date: { gte: normaliseDateInput(ymd(p.startDate)), lte: normaliseDateInput(ymd(p.endDate)) },
          source: 'system', status: 'absent', isLocked: false,
        },
      })
    },
  ],
  'leave.request.rejected': [toEmployee('leave.request.rejected', 'Leave rejected', (p) => `Your leave request was rejected. Reason: ${p.reason}.`, () => '/leave')],
  'leave.approval.escalated': [
    async (e) => {
      const p = e.payload
      const skip = await userIdOfEmployee(e.tenantId, p.skipLevelManagerId)
      await notify({
        tenantId: e.tenantId,
        userIds: [...(await hr(e.tenantId)), ...(skip ? [skip] : [])],
        type: 'leave.approval.escalated',
        title: 'Leave approval overdue',
        body: `A leave request from ${p.employeeName} has waited past its ${p.slaHours}h approval SLA.`,
        link: '/approvals', entityType: 'leave_request', entityId: p.leaveRequestId, eventId: e.id,
      })
    },
  ],
  'contract.expiring.soon': [toHR('contract.expiring.soon', 'Contract expiring soon', (p) => `Contract for ${p.name} expires in ${p.daysRemaining} days.`, (p) => `/employees/${p.employeeId}`, hrAndPayroll)],
  'contract.expired': [toHR('contract.expired', 'Contract expired', (p) => `Contract for ${p.name} has expired. Action needed.`, (p) => `/employees/${p.employeeId}`, hrAndPayroll)],
  'exit.initiated': [toHR('exit.initiated', 'Exit initiated', (p) => `Exit (${p.exitType}) initiated; last working day ${ymd(p.lastWorkingDate)}.`, (p) => (p.exitId ? `/exits/${p.exitId}` : '/exits'))],
  'attendance.absent.marked': [toEmployee('attendance.absent.marked', 'Marked absent', (p) => `No attendance or approved leave on ${p.date}; you were marked absent. Apply for leave or request regularisation if this is wrong.`, () => '/attendance')],
}

export async function dispatchEvent(eventId: string) {
  const event = await prisma.domainEvent.findUnique({ where: { id: eventId } })
  if (!event || event.status === 'delivered') return
  try {
    for (const handler of EVENT_HANDLERS[event.eventType] ?? []) await handler(event)
    // Company-defined automation and webhooks; neither throws (failures are recorded and retried on their own)
    await runAutomations(event)
    await queueWebhooks(event)
    await prisma.domainEvent.update({ where: { id: eventId }, data: { status: 'delivered', deliveredAt: new Date() } })
  } catch (err) {
    await prisma.domainEvent.update({ where: { id: eventId }, data: { status: 'failed', retryCount: { increment: 1 } } })
    throw err
  }
}

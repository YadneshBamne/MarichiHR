import { prisma } from '../database/prisma'
import { notify, userIdsWithRole, userIdOfEmployee } from '../notifications/notify'
import { normaliseDateInput } from '../../shared/utils/businessDate'
import { audienceUsers } from '../../shared/utils/audience'

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

const toHR = (type: string, title: string, body: (p: any) => string, link?: (p: any) => string): Handler => async (e) => {
  await notify({ tenantId: e.tenantId, userIds: await hr(e.tenantId), type, title, body: body(e.payload), link: link?.(e.payload), eventId: e.id })
}

export const EVENT_HANDLERS: Record<string, Handler[]> = {
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
  'contract.expiring.soon': [toHR('contract.expiring.soon', 'Contract expiring soon', (p) => `Contract for ${p.name} expires in ${p.daysRemaining} days.`, (p) => `/employees/${p.employeeId}`)],
  'contract.expired': [toHR('contract.expired', 'Contract expired', (p) => `Contract for ${p.name} has expired. HR action required.`, (p) => `/employees/${p.employeeId}`)],
  'exit.initiated': [toHR('exit.initiated', 'Exit initiated', (p) => `Exit (${p.exitType}) initiated; last working day ${ymd(p.lastWorkingDate)}.`, (p) => (p.exitId ? `/exits/${p.exitId}` : '/exits'))],
  'payslip.released': [toEmployee('payslip.released', 'Payslip available', (p) => `Your payslip is ready. Net pay ${p.netPay} ${p.currency}.`, (p) => `/payroll/payslips/${p.payslipId}`)],
  'attendance.absent.marked': [toEmployee('attendance.absent.marked', 'Marked absent', (p) => `No attendance or approved leave on ${p.date}; you were marked absent. Apply for leave or request regularisation if this is wrong.`, () => '/attendance')],
}

export async function dispatchEvent(eventId: string) {
  const event = await prisma.domainEvent.findUnique({ where: { id: eventId } })
  if (!event || event.status === 'delivered') return
  try {
    for (const handler of EVENT_HANDLERS[event.eventType] ?? []) await handler(event)
    await prisma.domainEvent.update({ where: { id: eventId }, data: { status: 'delivered', deliveredAt: new Date() } })
  } catch (err) {
    await prisma.domainEvent.update({ where: { id: eventId }, data: { status: 'failed', retryCount: { increment: 1 } } })
    throw err
  }
}

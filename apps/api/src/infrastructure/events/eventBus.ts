import { prisma } from '../database/prisma'
import { Queue } from 'bullmq'
import { redis } from '../cache/redis'
import { logSystemChatter } from '../../modules/activities/activities.repository'

let eventQueue: Queue | null = null

function getEventQueue(): Queue {
  if (!eventQueue) {
    eventQueue = new Queue('domain-events', { connection: redis })
  }
  return eventQueue
}

// Date-only values are shown as YYYY-MM-DD in UTC, never via Date.toString()
const ymd = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10)

const CHATTER_EVENTS: Record<string, (payload: any) => { entityType: string; entityId: string; message: string } | null> = {
  'employee.created': (p) => ({
    entityType: 'employee',
    entityId: p.employeeId,
    message: `Employee profile created. Code: ${p.employeeCode}. Welcome email will be sent to ${p.email}.`,
  }),
  'employee.archived': (p) => ({
    entityType: 'employee',
    entityId: p.employeeId,
    message: `Employee archived. Reason: ${p.reason}.`,
  }),
  'leave.request.approved': (p) => ({
    entityType: 'leave_request',
    entityId: p.leaveRequestId,
    message: `Leave request approved. ${p.totalDays} day(s) of ${p.leaveTypeName} approved from ${ymd(p.startDate)} to ${ymd(p.endDate)}.`,
  }),
  'leave.request.rejected': (p) => ({
    entityType: 'leave_request',
    entityId: p.leaveRequestId,
    message: `Leave request rejected. Reason: ${p.reason}.`,
  }),
  'contract.activated': (p) => ({
    entityType: 'contract',
    entityId: p.contractId,
    message: `Contract activated for ${p.name}. Status changed to running.`,
  }),
  'contract.expired': (p) => ({
    entityType: 'contract',
    entityId: p.contractId,
    message: `Contract expired for ${p.name}. HR action required.`,
  }),
  'contract.expiring.soon': (p) => ({
    entityType: 'contract',
    entityId: p.contractId,
    message: `Contract expiring in ${p.daysRemaining} days for ${p.name}. Please initiate renewal.`,
  }),
  'exit.initiated': (p) => ({
    entityType: 'employee',
    entityId: p.employeeId,
    message: `Exit initiated (${p.exitType}). Last working day ${ymd(p.lastWorkingDate)}.`,
  }),
  'fnf.paid': (p) => ({
    entityType: 'employee',
    entityId: p.employeeId,
    message: `Full & final settlement paid: ${p.netPayable} ${p.currency}.`,
  }),
  'attendance.locked': (_p) => null,
}

export const eventBus = {
  async publish(tenantId: string, eventType: string, payload: Record<string, any>) {
    const event = await prisma.domainEvent.create({
      data: { tenantId, eventType, payload, status: 'pending' },
    })

    const chatterFn = CHATTER_EVENTS[eventType]
    if (chatterFn) {
      try {
        const chatterData = chatterFn(payload)
        if (chatterData) {
          await logSystemChatter(chatterData.entityType, chatterData.entityId, chatterData.message)
        }
      } catch (err) {
        console.error(`Failed to log chatter for event ${eventType}:`, err)
      }
    }

    try {
      await getEventQueue().add(
        'dispatch',
        { eventId: event.id },
        { attempts: 5, backoff: { type: 'exponential', delay: 2000 } }
      )
    } catch (err) {
      console.error('Failed to enqueue event:', err)
    }

    return event
  },
}

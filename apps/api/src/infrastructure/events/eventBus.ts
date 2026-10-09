import crypto from 'crypto'
import { prisma } from '../database/prisma'
import { Queue } from 'bullmq'
import { redis, soft } from '../cache/redis'
import { logSystemChatter } from '../../modules/activities/activities.repository'

let eventQueue: Queue | null = null

function getEventQueue(): Queue {
  if (!eventQueue) {
    eventQueue = new Queue('domain-events', { connection: redis })
  }
  return eventQueue
}

// jobId = eventId, so a sweep never queues an event that is already waiting
export async function enqueueEvent(eventId: string) {
  await getEventQueue().add('dispatch', { eventId }, {
    jobId: eventId, attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: true,
  })
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

// Rows for a domain event (and its chatter line) to insert together with other rows via insertRows(), plus the
// queue push to call after the write commits. Same effect as publish(), minus two round trips.
export function prepareEvent(tenantId: string, eventType: string, payload: Record<string, any>) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const rows: Record<string, Record<string, unknown>[]> = {
    domain_events: [{ id, tenantId, eventType, payload, status: 'pending', retryCount: 0, createdAt: now }],
  }
  try {
    const c = CHATTER_EVENTS[eventType]?.(payload)
    if (c) rows.chatter_messages = [{ id: crypto.randomUUID(), tenantId, entityType: c.entityType, entityId: c.entityId, messageType: 'system_log', authorName: 'System', body: c.message, isInternal: false, createdAt: now }]
  } catch (err) {
    console.error(`Failed to build chatter for event ${eventType}:`, err)
  }
  // The events-sweep job re-enqueues pending events, so a Redis outage only delays delivery (and never hangs a request)
  return { rows, after: () => soft(() => enqueueEvent(id), undefined) }
}

export const eventBus = {
  async publish(tenantId: string, eventType: string, payload: Record<string, any>) {
    const event = await prisma.domainEvent.create({
      data: { tenantId, eventType, payload, status: 'pending' },
    })

    const chatter = async () => {
      const chatterFn = CHATTER_EVENTS[eventType]
      if (!chatterFn) return
      try {
        const chatterData = chatterFn(payload)
        if (chatterData) await logSystemChatter(tenantId, chatterData.entityType, chatterData.entityId, chatterData.message)
      } catch (err) {
        console.error(`Failed to log chatter for event ${eventType}:`, err)
      }
    }
    // The events-sweep job re-enqueues pending events, so a Redis outage only delays delivery (and never hangs a request)
    const enqueue = () => soft(() => enqueueEvent(event.id), undefined)
    await Promise.all([chatter(), enqueue()])

    return event
  },
}

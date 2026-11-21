import { DomainEvent } from '../mongo/mongo'
import { runAutomations } from '../../modules/automation/automation.service'
import { queueWebhooks, retryWebhooks } from '../../modules/automation/integrations.service'

// MongoDB API: delivers recorded domain events to company automation rules and signed webhooks, in this process, without Redis or a queue.
// Every pending event is claimed atomically (so several API instances never send the same event twice), handed to the rules and webhooks
// of its company, and marked delivered. Only these two consumers run here: the other event handlers of the Postgres API are not ported.
// Events written by the hand-made Mongo services carry `type`; the Prisma-compatible client writes `eventType`. Both are read.
const STUCK_MS = 5 * 60_000

export async function pumpOnce(limit = 50): Promise<number> {
  await DomainEvent.updateMany({ status: 'processing', processingAt: { $lt: new Date(Date.now() - STUCK_MS) } }, { $set: { status: 'pending' } })
  let n = 0
  for (; n < limit; n++) {
    const raw: any = await DomainEvent.findOneAndUpdate({ status: 'pending' }, { $set: { status: 'processing', processingAt: new Date() } }, { sort: { createdAt: 1 }, returnDocument: 'after' }).lean()
    if (!raw) break
    const eventType = raw.eventType ?? raw.type
    try {
      if (!raw.eventType && eventType) await DomainEvent.updateOne({ _id: raw._id }, { $set: { eventType } }) // webhook deliveries read the event back by id
      const e = { id: raw._id as string, tenantId: raw.tenantId as string, eventType: eventType as string, payload: raw.payload ?? {}, createdAt: raw.createdAt }
      await runAutomations(e as any) // neither throws: failures are recorded on their own rows
      await queueWebhooks(e)
      await DomainEvent.updateOne({ _id: raw._id }, { $set: { status: 'delivered', deliveredAt: new Date() } })
    } catch (err: any) {
      console.error('[events] dispatch failed:', eventType, err?.message)
      await DomainEvent.updateOne({ _id: raw._id }, { $set: { status: 'failed' }, $inc: { retryCount: 1 } })
    }
  }
  return n
}

let timers: NodeJS.Timeout[] = []
export function startEventPump() {
  if (timers.length) return
  let busy = false
  const guard = (fn: () => Promise<unknown>) => async () => { if (busy) return; busy = true; try { await fn() } catch (e: any) { console.error('[events] pump:', e?.message) } finally { busy = false } }
  timers = [setInterval(guard(() => pumpOnce()), 5_000), setInterval(guard(() => retryWebhooks()), 60_000)]
  timers.forEach((t) => t.unref())
  console.log('✓ Events       : delivering to automations and webhooks every 5 s')
}
export const stopEventPump = () => { timers.forEach(clearInterval); timers = [] }

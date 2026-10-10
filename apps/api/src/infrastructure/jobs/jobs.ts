import { Queue, Worker } from 'bullmq'
import { redis, QUEUE_PREFIX } from '../cache/redis'
import { prisma } from '../database/prisma'
import { dispatchEvent } from '../events/handlers'
import { enqueueEvent } from '../events/eventBus'
import { leaveService } from '../../modules/leave/leave.service'
import { contractService } from '../../modules/employees/contracts.service'
import { attendanceService } from '../../modules/attendance/attendance.service'
import { announcementService } from '../../modules/announcements/announcements.service'

// Optionally only companies that installed a given app
const activeTenants = (app?: string) => prisma.tenant.findMany({ where: { active: true, ...(app && { modules: { has: app } }) }, select: { id: true } })

// Scheduled runs cover every active tenant; a manual run (POST /system/jobs/:name/run) only the caller's tenant
async function perTenant(only: string | undefined, fn: (tenantId: string) => Promise<unknown>, app?: string) {
  const out: Record<string, unknown> = {}
  for (const t of only ? [{ id: only }] : await activeTenants(app)) out[t.id] = await fn(t.id)
  return out
}

// Cron patterns are UTC. Every job is idempotent, so a manual run or a retry never double-applies.
export const JOBS: Record<string, { pattern: string; description: string; run: (tenantId?: string) => Promise<unknown> }> = {
  'events-sweep': {
    pattern: '*/10 * * * *',
    description: 'Re-dispatch domain events that were never enqueued or whose handlers failed; publish scheduled announcements',
    run: async (tenantId) => {
      const stale = await prisma.domainEvent.findMany({
        where: {
          ...(tenantId && { tenantId }),
          OR: [
            { status: 'pending', createdAt: { lt: new Date(Date.now() - 2 * 60_000) } },
            { status: 'failed', retryCount: { lt: 10 } },
          ],
        },
        select: { id: true },
        take: 500,
      })
      for (const e of stale) await enqueueEvent(e.id)
      // Scheduled announcements that just went live notify their audience
      const announced = await announcementService.publishDue()
      if (announced) console.log(`[cron] events-sweep: ${announced} scheduled announcement(s) published`)
      return stale.length
    },
  },
  'leave-sla-escalation': {
    pattern: '15 * * * *',
    description: 'Escalate leave approvals that are past their SLA deadline',
    run: (t) => perTenant(t, (id) => leaveService.runSlaEscalation(id), 'leave'),
  },
  'absent-marking': {
    pattern: '30 0 * * *',
    description: 'Mark working days with no attendance or approved leave as absent (last 3 business days)',
    run: (t) => perTenant(t, async (id) => (await attendanceService.markAbsences(id)).marked, 'attendance'),
  },
  'contracts': {
    pattern: '0 1 * * *',
    description: 'Activate contracts on their start date, expire them after their end date, alert 30 days before expiry',
    run: async (t) => ({
      activated: await contractService.runAutoActivateCron(t),
      expired: await contractService.runAutoExpireCron(t),
      alerted: await contractService.runExpiryAlertCron(t),
    }),
  },
  'leave-accrual': {
    pattern: '0 2 1 * *',
    description: 'Monthly leave accrual (once per employee, leave type and month)',
    run: (t) => perTenant(t, (id) => leaveService.runMonthlyAccrual(id), 'leave'),
  },
}

// Upstash bills every Redis command. Idle workers wait in one blocking call of up to 5 min (a new job wakes them at
// once) and check for stalled jobs every 5 min, instead of BullMQ's defaults of 5 s and 30 s: ~50x fewer commands.
const IDLE_CHEAP = { drainDelay: 300, stalledInterval: 300_000 }

let cronQueue: Queue | null = null
const workers: Worker[] = []

export function getCronQueue() {
  if (!cronQueue) cronQueue = new Queue('cron', { connection: redis, prefix: QUEUE_PREFIX })
  return cronQueue
}

export async function startJobs() {
  workers.push(
    new Worker('domain-events', async (job) => dispatchEvent(job.data.eventId), { connection: redis, prefix: QUEUE_PREFIX, concurrency: 5, ...IDLE_CHEAP }),
    new Worker(
      'cron',
      async (job) => {
        const def = JOBS[job.name]
        if (!def) throw new Error(`Unknown job ${job.name}`)
        const result = await def.run()
        console.log(`[cron] ${job.name}:`, JSON.stringify(result))
        return result
      },
      { connection: redis, prefix: QUEUE_PREFIX, concurrency: 1, ...IDLE_CHEAP }
    )
  )
  for (const w of workers) w.on('failed', (job, err) => console.error(`[jobs] ${job?.queueName}/${job?.name} failed:`, err.message))

  const queue = getCronQueue()
  for (const [name, def] of Object.entries(JOBS)) {
    await queue.upsertJobScheduler(name, { pattern: def.pattern, tz: 'UTC' }, { name, opts: { removeOnComplete: 50, removeOnFail: 50 } })
  }
  // Drop schedulers for jobs that no longer exist
  for (const s of await queue.getJobSchedulers()) if (!JOBS[s.key]) await queue.removeJobScheduler(s.key)
  console.log(`✓ Jobs         : workers started, ${Object.keys(JOBS).length} cron schedules registered`)
}

export async function stopJobs() {
  await Promise.all(workers.map((w) => w.close()))
}

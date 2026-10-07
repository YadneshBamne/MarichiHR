// Standalone worker: domain-event consumers + cron, for when the API runs with JOBS_ENABLED=false
import dotenv from 'dotenv'
dotenv.config()

import { startJobs, stopJobs } from './infrastructure/jobs/jobs'

startJobs().catch((err) => {
  console.error('Failed to start jobs:', err)
  process.exit(1)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await stopJobs()
    process.exit(0)
  })
}

// Standalone worker: domain-event consumers + cron, for when the API runs with JOBS_ENABLED=false
import dotenv from 'dotenv'
dotenv.config()

import http from 'http'
import { startJobs, stopJobs } from './infrastructure/jobs/jobs'

// Hosts that run the worker as a web service need something listening on PORT: Cloud Run (K_SERVICE is set there)
// or any host with WORKER_HEALTH=true. Locally the API already has PORT.
if (process.env.K_SERVICE || process.env.WORKER_HEALTH === 'true') http.createServer((_, res) => res.end('worker ok')).listen(Number(process.env.PORT))

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

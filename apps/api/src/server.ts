import dotenv from 'dotenv'
dotenv.config()

import { createApp } from './app'
import { prisma } from './infrastructure/database/prisma'
import { createServer } from 'http'
import { closePdfBrowser } from './modules/payroll/payslip.pdf'
import { startJobs, stopJobs } from './infrastructure/jobs/jobs'

const PORT = process.env.PORT || 4000

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  MarichiHR API — Starting up')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  console.log(`✓ Environment  : ${process.env.NODE_ENV}`)
  console.log(`✓ Port         : ${PORT}`)
  console.log(`✓ Database URL : ${!!process.env.DATABASE_URL}`)
  console.log(`✓ Redis URL    : ${!!process.env.REDIS_URL}`)

  // Test database connection
  try {
    await prisma.$connect()
    const result = await prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'public'`
    console.log(`✓ Database     : Connected (${result[0].count} tables found)`)
  } catch (err) {
    console.error('✗ Database connection failed:', err)
    process.exit(1)
  }

  const app = createApp()
  const httpServer = createServer(app)

  // Workers + cron run in the API process unless JOBS_ENABLED=false (then run `npm run worker` separately)
  // A Redis outage (or exhausted quota) must not stop the API from serving; jobs resume on the next restart
  if (process.env.JOBS_ENABLED !== 'false') await startJobs().catch((err) => console.error('✗ Jobs not started (Redis unavailable):', err.message))

  httpServer.listen(PORT, () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`✓ API running at http://localhost:${PORT}`)
    console.log(`✓ Health check : http://localhost:${PORT}/health`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  })
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await closePdfBrowser()
    await stopJobs()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})

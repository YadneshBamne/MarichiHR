import dotenv from 'dotenv'
dotenv.config()
import './mongo-mode' // must come before the app is loaded

import { createServer } from 'http'
import { connectMongo, syncMongoIndexes } from './infrastructure/mongo/mongo'

const PORT = process.env.PORT || 4000

// A stray rejection from code that is not ported yet must never take the API down
process.on('unhandledRejection', (reason: any) => console.error('Unhandled rejection:', reason?.message ?? reason))

async function main() {
  // A wrong encryption key would only show up later as 500s on bank details, ID numbers, API keys and two-step sign-in: refuse to start instead
  if (process.env.NODE_ENV === 'production' && !/^[0-9a-fA-F]{64}$/.test(process.env.BANK_ENCRYPTION_KEY ?? '')) {
    console.error('✗ BANK_ENCRYPTION_KEY must be exactly 64 hex characters (make one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")')
    process.exit(1)
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  MarichiHR API — MongoDB mode')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  await connectMongo()
  await syncMongoIndexes()
  await require('./infrastructure/database/prisma.mongo').ensureEnabledModels()
  console.log('✓ MongoDB      : Connected')
  const { createApp } = await import('./app')
  const httpServer = createServer(createApp())
  httpServer.listen(PORT, () => console.log(`✓ API running at http://localhost:${PORT} (MongoDB)`))
  if (process.env.EVENT_PUMP !== 'false') require('./infrastructure/events/pump.mongo').startEventPump()
  if (process.env.JOBS_ENABLED === 'true') await require('./infrastructure/jobs/jobs').startJobs().catch((err: any) => console.error('✗ Jobs not started:', err.message))
}

main().catch((err) => { console.error('Failed to start server:', err); process.exit(1) })

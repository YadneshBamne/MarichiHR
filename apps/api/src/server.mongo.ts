import dotenv from 'dotenv'
dotenv.config()
import './mongo-mode' // must come before the app is loaded

import { createServer } from 'http'
import { connectMongo, syncMongoIndexes } from './infrastructure/mongo/mongo'

const PORT = process.env.PORT || 4000

// A stray rejection from code that is not ported yet must never take the API down
process.on('unhandledRejection', (reason: any) => console.error('Unhandled rejection:', reason?.message ?? reason))

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  MarichiHR API — MongoDB mode')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  await connectMongo()
  await syncMongoIndexes()
  console.log('✓ MongoDB      : Connected')
  const { createApp } = await import('./app')
  const httpServer = createServer(createApp())
  httpServer.listen(PORT, () => console.log(`✓ API running at http://localhost:${PORT} (MongoDB)`))
  if (process.env.JOBS_ENABLED === 'true') await require('./infrastructure/jobs/jobs').startJobs().catch((err: any) => console.error('✗ Jobs not started:', err.message))
}

main().catch((err) => { console.error('Failed to start server:', err); process.exit(1) })

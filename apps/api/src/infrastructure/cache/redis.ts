import { Redis } from 'ioredis'

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL environment variable is not set')
}

export const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})

redis.on('connect', () => {
  console.log('✓ Redis connected')
})

redis.on('error', (err) => {
  console.error('Redis error:', err.message)
})

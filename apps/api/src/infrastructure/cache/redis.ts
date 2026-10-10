import { Redis } from 'ioredis'

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL environment variable is not set')
}

export const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})

// BullMQ key prefix. Servers that share one Redis (e.g. a laptop and production) must use different prefixes, or
// either one may pick up the other's jobs and run them with different code. Set QUEUE_PREFIX in local .env.
export const QUEUE_PREFIX = process.env.QUEUE_PREFIX || 'bull'

redis.on('connect', () => {
  console.log('✓ Redis connected')
})

redis.on('error', (err) => {
  console.error('Redis error:', err.message)
})

// For non-essential Redis use (rate limits, failure counters, queue pushes): if Redis is down, out of quota or slow,
// carry on with `fallback` instead of failing or hanging the request. Login and sign-up keep working without it.
export async function soft<T>(op: () => Promise<T>, fallback: T, ms = 1500): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([op(), new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`no reply in ${ms} ms`)), ms) })])
  } catch (err) {
    console.warn('Redis unavailable, continuing without it:', (err as Error).message)
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

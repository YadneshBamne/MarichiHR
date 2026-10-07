import { prisma } from '../../infrastructure/database/prisma'

const tzCache = new Map<string, string>()

export async function getTenantTimezone(tenantId: string): Promise<string> {
  const cached = tzCache.get(tenantId)
  if (cached) return cached
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } })
  const tz = t?.timezone || 'UTC'
  tzCache.set(tenantId, tz)
  return tz
}

// YYYY-MM-DD calendar date of an instant in a given timezone
export function localDateString(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant)
}

// UTC-midnight Date for a YYYY-MM-DD string — the only form to store in or query against @db.Date columns
export function dateOnly(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`)
}

// Today's business date for a tenant
export async function businessToday(tenantId: string): Promise<Date> {
  const tz = await getTenantTimezone(tenantId)
  return dateOnly(localDateString(new Date(), tz))
}

// Normalise a client-supplied date (Date or 'YYYY-MM-DD' / ISO string) to UTC-midnight of its calendar date
export function normaliseDateInput(input: string | Date): Date {
  const s = typeof input === 'string' ? input.slice(0, 10) : input.toISOString().slice(0, 10)
  return dateOnly(s)
}

function tzOffsetMs(instant: Date, timeZone: string): number {
  const p: Record<string, number> = {}
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant.getTime() / 1000) * 1000
}

// UTC instant for a tenant-local wall-clock time ('HH:mm') on a YYYY-MM-DD business date
export function zonedTimeToUtc(ymd: string, hm: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  const [h, mi] = hm.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, h, mi)
  let utc = guess - tzOffsetMs(new Date(guess), timeZone)
  const off2 = tzOffsetMs(new Date(utc), timeZone)
  utc = guess - off2
  return new Date(utc)
}

// 'HH:mm' wall-clock time of an instant in a given timezone
export function localTimeString(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(instant)
}

// Month range as UTC-midnight dates (month is 1-12)
export function monthRange(year: number, month: number): { start: Date; end: Date; daysInMonth: number } {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month - 1, daysInMonth)),
    daysInMonth,
  }
}

// Call after a tenant's timezone changes
export const forgetTenantTimezone = (tenantId: string) => tzCache.delete(tenantId)

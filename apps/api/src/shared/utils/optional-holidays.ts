import mongoose from 'mongoose'
import { normaliseDateInput } from './businessDate'

// Optional holidays people have picked (MongoDB API only, collection optional_holiday_picks). A pick is a day off for that person alone:
// absent marking skips it, the attendance calendar shows it as a holiday and leave day counting does not count it.
// Read through the holidays themselves, so a holiday HR moves, removes or archives stops counting at once.
// Tolerant on purpose: outside MongoDB mode, or on any error, the answer is "no picks" and callers behave as before.
const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10))

// `${employeeId}|YYYY-MM-DD` -> holiday name
export async function optionalPicksFor(tenantId: string, employeeIds: string[], from: Date | string, to: Date | string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (process.env.DB_PROVIDER !== 'mongo' || !employeeIds.length) return out
  try {
    const c = (n: string) => mongoose.connection.collection(n)
    const cals = await c('holiday_calendars').find({ tenantId, active: true } as any).project({ _id: 1 }).toArray()
    if (!cals.length) return out
    const hols = await c('holidays').find({ calendarId: { $in: cals.map((x) => x._id) }, active: true, isOptional: true, date: { $gte: normaliseDateInput(ymd(from)), $lte: normaliseDateInput(ymd(to)) } } as any).project({ _id: 1, name: 1, date: 1 }).toArray()
    if (!hols.length) return out
    const byId = new Map(hols.map((h: any) => [h._id as string, h]))
    const picks = await c('optional_holiday_picks').find({ tenantId, holidayId: { $in: [...byId.keys()] }, employeeId: { $in: employeeIds } } as any).project({ employeeId: 1, holidayId: 1 }).toArray()
    for (const p of picks) { const h: any = byId.get(p.holidayId); if (h) out.set(`${p.employeeId}|${ymd(h.date)}`, h.name) }
  } catch { /* behave as before */ }
  return out
}

// One person: date -> holiday name
export async function optionalPickDays(tenantId: string, employeeId: string, from: Date | string, to: Date | string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const [k, v] of await optionalPicksFor(tenantId, [employeeId], from, to)) out.set(k.split('|')[1], v)
  return out
}

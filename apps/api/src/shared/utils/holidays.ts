import { prisma } from '../../infrastructure/database/prisma'

// Which holidays apply to whom. A calendar applies to an employee when its country is unset or equals the employee's
// country (work location's country, else tax jurisdiction) and its work location is unset or equals theirs.
// Optional holidays never count as days off by themselves.

export interface HolidayTarget { countryCode: string | null; workLocationId: string | null }
export interface HolidayRow { date: Date; name: string; type: string; isOptional: boolean; calendar: { id: string; name: string; countryCode: string | null; workLocationId: string | null } }

const ymd = (d: Date) => d.toISOString().slice(0, 10)

export const calendarApplies = (cal: { countryCode: string | null; workLocationId: string | null }, who: HolidayTarget) =>
  (!cal.countryCode || cal.countryCode === who.countryCode) && (!cal.workLocationId || cal.workLocationId === who.workLocationId)

export async function holidaysBetween(tenantId: string, from: Date, to: Date): Promise<HolidayRow[]> {
  return prisma.holiday.findMany({
    where: { active: true, date: { gte: from, lte: to }, calendar: { tenantId, active: true } },
    select: { date: true, name: true, type: true, isOptional: true, calendar: { select: { id: true, name: true, countryCode: true, workLocationId: true } } },
    orderBy: { date: 'asc' },
  })
}

// YYYY-MM-DD -> holiday name, for one person; mandatory holidays only unless asked
export function holidayMap(rows: HolidayRow[], who: HolidayTarget, includeOptional = false) {
  const m = new Map<string, string>()
  for (const h of rows) if ((includeOptional || !h.isOptional) && calendarApplies(h.calendar, who)) m.set(ymd(h.date), h.name)
  return m
}

export async function holidayTargetOf(employeeId: string): Promise<HolidayTarget> {
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { workLocationId: true, taxJurisdiction: true, workLocation: { select: { countryCode: true } } } })
  return { countryCode: e?.workLocation?.countryCode ?? e?.taxJurisdiction ?? null, workLocationId: e?.workLocationId ?? null }
}

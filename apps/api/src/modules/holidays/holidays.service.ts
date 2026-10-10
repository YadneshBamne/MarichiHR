import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { normaliseDateInput } from '../../shared/utils/businessDate'
import { calendarApplies, holidayTargetOf, holidaysBetween, HolidayTarget } from '../../shared/utils/holidays'

type HolidayIn = { name: string; date: string; type?: string; isOptional?: boolean }
type CalendarIn = { name: string; year: number; countryCode?: string | null; workLocationId?: string | null; holidays?: HolidayIn[] }

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const viewerTarget = async (user: AccessUser): Promise<HolidayTarget | null> => (user.employeeId ? holidayTargetOf(user.employeeId) : null)

async function calendarOf(user: AccessUser, id: string) {
  const cal = await prisma.holidayCalendar.findFirst({ where: { id, tenantId: user.tenantId, active: true } })
  if (!cal) throw new AppError('Holiday calendar not found', 404)
  return cal
}

async function assertLocation(tenantId: string, workLocationId?: string | null) {
  if (workLocationId && !(await prisma.workLocation.findFirst({ where: { id: workLocationId, tenantId }, select: { id: true } }))) {
    throw new AppError('Work location not found', 404)
  }
}

// Every date must fall in the calendar's year and appear once
function checkDates(year: number, holidays: HolidayIn[], existing: Date[] = []) {
  const seen = new Set(existing.map(ymd))
  for (const h of holidays) {
    if (Number(h.date.slice(0, 4)) !== year) throw new AppError(`${h.name}: ${h.date} is not in ${year}`, 400)
    if (seen.has(h.date)) throw new AppError(`${h.date} already has a holiday in this calendar`, 409)
    seen.add(h.date)
  }
}

const audit = (user: AccessUser, action: string, entityId: string, newValue?: any) =>
  prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action, entityType: 'holiday_calendar', entityId, newValue } })

export const holidayService = {
  async list(user: AccessUser, year: number) {
    const [calendars, locations, me] = await Promise.all([
      prisma.holidayCalendar.findMany({
        where: { tenantId: user.tenantId, year, active: true },
        include: { holidays: { where: { active: true }, orderBy: { date: 'asc' } } },
        orderBy: { name: 'asc' },
      }),
      prisma.workLocation.findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true } }),
      viewerTarget(user),
    ])
    const locName = new Map(locations.map((l) => [l.id, l.name]))
    return {
      year,
      calendars: calendars.map((c) => ({
        id: c.id, name: c.name, year: c.year, countryCode: c.countryCode, workLocationId: c.workLocationId,
        workLocation: c.workLocationId ? locName.get(c.workLocationId) ?? null : null,
        appliesToMe: me ? calendarApplies(c, me) : false,
        holidays: c.holidays.map((h) => ({ id: h.id, name: h.name, date: ymd(h.date), type: h.type, isOptional: h.isOptional })),
      })),
    }
  },

  // The viewer's own holidays in a range (dashboard, leave planner); optional ones are included and flagged
  async mine(user: AccessUser, from: string, to: string) {
    if (!user.employeeId) return []
    const [rows, me] = await Promise.all([holidaysBetween(user.tenantId, normaliseDateInput(from), normaliseDateInput(to)), holidayTargetOf(user.employeeId)])
    const out = new Map<string, { date: string; name: string; type: string; isOptional: boolean }>()
    for (const h of rows) {
      if (!calendarApplies(h.calendar, me)) continue
      const key = ymd(h.date)
      const prev = out.get(key)
      if (!prev || (prev.isOptional && !h.isOptional)) out.set(key, { date: key, name: h.name, type: h.type, isOptional: h.isOptional })
    }
    return [...out.values()].sort((a, b) => a.date.localeCompare(b.date))
  },

  async createCalendar(user: AccessUser, body: CalendarIn) {
    await assertLocation(user.tenantId, body.workLocationId)
    checkDates(body.year, body.holidays ?? [])
    const cal = await prisma.holidayCalendar.create({
      data: {
        tenantId: user.tenantId, name: body.name, year: body.year, countryCode: body.countryCode ?? null, workLocationId: body.workLocationId ?? null,
        holidays: { create: (body.holidays ?? []).map((h) => ({ name: h.name, date: normaliseDateInput(h.date), type: h.type ?? 'national', isOptional: h.isOptional ?? false })) },
      },
    })
    await audit(user, 'HOLIDAY_CALENDAR_CREATED', cal.id, { name: cal.name, year: cal.year, holidays: body.holidays?.length ?? 0 })
    return cal
  },

  async updateCalendar(user: AccessUser, id: string, body: Partial<CalendarIn>) {
    await calendarOf(user, id)
    await assertLocation(user.tenantId, body.workLocationId)
    const data: Record<string, unknown> = {}
    for (const k of ['name', 'countryCode', 'workLocationId'] as const) if (body[k] !== undefined) data[k] = body[k]
    const cal = await prisma.holidayCalendar.update({ where: { id }, data })
    await audit(user, 'HOLIDAY_CALENDAR_UPDATED', id, data)
    return cal
  },

  async archiveCalendar(user: AccessUser, id: string) {
    await calendarOf(user, id)
    await prisma.holidayCalendar.update({ where: { id }, data: { active: false } })
    await audit(user, 'HOLIDAY_CALENDAR_ARCHIVED', id)
    return { archived: true }
  },

  // Next year's calendar from this one: same names and types, same day and month (adjust moving festivals after)
  async copyCalendar(user: AccessUser, id: string, year: number) {
    const src = await calendarOf(user, id)
    if (year === src.year) throw new AppError('Pick a different year to copy to', 400)
    const holidays = await prisma.holiday.findMany({ where: { calendarId: id, active: true }, orderBy: { date: 'asc' } })
    const moved = holidays.flatMap((h) => {
      const d = `${year}${ymd(h.date).slice(4)}`
      return d.endsWith('02-29') && new Date(`${d}T00:00:00Z`).getUTCMonth() !== 1 ? [] : [{ name: h.name, date: d, type: h.type, isOptional: h.isOptional }]
    })
    const name = src.name.includes(String(src.year)) ? src.name.replace(String(src.year), String(year)) : src.name
    return holidayService.createCalendar(user, { name, year, countryCode: src.countryCode, workLocationId: src.workLocationId, holidays: moved })
  },

  async addHolidays(user: AccessUser, id: string, holidays: HolidayIn[]) {
    const cal = await calendarOf(user, id)
    const existing = await prisma.holiday.findMany({ where: { calendarId: id, active: true }, select: { date: true } })
    checkDates(cal.year, holidays, existing.map((e) => e.date))
    await prisma.holiday.createMany({ data: holidays.map((h) => ({ calendarId: id, name: h.name, date: normaliseDateInput(h.date), type: h.type ?? 'national', isOptional: h.isOptional ?? false })) })
    await audit(user, 'HOLIDAYS_ADDED', id, { holidays })
    return prisma.holiday.findMany({ where: { calendarId: id, active: true }, orderBy: { date: 'asc' } })
  },

  async updateHoliday(user: AccessUser, holidayId: string, body: Partial<HolidayIn>) {
    const h = await prisma.holiday.findFirst({ where: { id: holidayId, active: true, calendar: { tenantId: user.tenantId, active: true } }, include: { calendar: true } })
    if (!h) throw new AppError('Holiday not found', 404)
    if (body.date && body.date !== ymd(h.date)) {
      const others = await prisma.holiday.findMany({ where: { calendarId: h.calendarId, active: true, id: { not: h.id } }, select: { date: true } })
      checkDates(h.calendar.year, [{ name: body.name ?? h.name, date: body.date }], others.map((o) => o.date))
    }
    const data: Record<string, unknown> = {}
    if (body.name !== undefined) data.name = body.name
    if (body.date !== undefined) data.date = normaliseDateInput(body.date)
    if (body.type !== undefined) data.type = body.type
    if (body.isOptional !== undefined) data.isOptional = body.isOptional
    const updated = await prisma.holiday.update({ where: { id: h.id }, data })
    await audit(user, 'HOLIDAY_UPDATED', h.calendarId, { holidayId: h.id, ...body })
    return updated
  },

  async archiveHoliday(user: AccessUser, holidayId: string) {
    const h = await prisma.holiday.findFirst({ where: { id: holidayId, active: true, calendar: { tenantId: user.tenantId, active: true } } })
    if (!h) throw new AppError('Holiday not found', 404)
    await prisma.holiday.update({ where: { id: h.id }, data: { active: false } })
    await audit(user, 'HOLIDAY_REMOVED', h.calendarId, { holidayId: h.id, name: h.name, date: ymd(h.date) })
    return { archived: true }
  },
}

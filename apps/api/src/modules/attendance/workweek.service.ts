import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { DEFAULT_WORK_DAYS } from './policy.service'

// The company's working week: which weekdays count as working days (0 = Monday ... 6 = Sunday). It is stored in the company's default
// resource calendar (the oldest active one, which new people are given), so leave counting, absence marking, the attendance calendar, Team Today
// and payroll all read the same thing. Mon-Fri by default; a 6-day company ticks Saturday too.
export const WorkWeekBody = z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7) }).strict()

async function defaultCalendar(tenantId: string): Promise<{ id: string; name: string; days: { dayOfWeek: number; hourFrom: number; hourTo: number }[] } | null> {
  if (process.env.DB_PROVIDER === 'mongo') {
    const { ResourceCalendar } = require('../../infrastructure/mongo/mongo')
    const c: any = await ResourceCalendar.findOne({ tenantId, active: true }).sort({ createdAt: 1 }).lean()
    return c ? { id: c._id, name: c.name, days: c.days ?? [] } : null
  }
  const c = await prisma.resourceCalendar.findFirst({ where: { tenantId, active: true }, orderBy: { createdAt: 'asc' }, include: { days: true } })
  return c ? { id: c.id, name: c.name, days: c.days } : null
}

export const workWeekService = {
  async get(tenantId: string) {
    const c = await defaultCalendar(tenantId)
    const days = [...new Set((c?.days ?? []).map((d) => d.dayOfWeek))].sort((a, b) => a - b)
    return { days: days.length ? days : DEFAULT_WORK_DAYS, calendar: c?.name ?? null }
  },

  async set(u: AccessUser, input: z.infer<typeof WorkWeekBody>) {
    const days = [...new Set(input.days)].sort((a, b) => a - b)
    const c = await defaultCalendar(u.tenantId)
    if (!c) throw new AppError('This company has no working calendar yet', 404)
    const hourFrom = c.days[0]?.hourFrom ?? 9, hourTo = c.days[0]?.hourTo ?? 18
    const rows = days.map((dayOfWeek) => ({ dayOfWeek, hourFrom, hourTo }))
    if (process.env.DB_PROVIDER === 'mongo') {
      const { ResourceCalendar } = require('../../infrastructure/mongo/mongo')
      await ResourceCalendar.updateOne({ _id: c.id, tenantId: u.tenantId }, { $set: { days: rows, hoursPerWeek: days.length * Math.max(1, hourTo - hourFrom - 1) } })
    } else {
      await prisma.$transaction([
        prisma.resourceCalendarDay.deleteMany({ where: { calendarId: c.id } }),
        prisma.resourceCalendarDay.createMany({ data: rows.map((r) => ({ ...r, calendarId: c.id })) }),
      ])
    }
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'WORKING_WEEK_CHANGED', entityType: 'resource_calendar', entityId: c.id, oldValue: { days: c.days.map((d) => d.dayOfWeek).sort() }, newValue: { days } } })
    return { days, calendar: c.name }
  },
}

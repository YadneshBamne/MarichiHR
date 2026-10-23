import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { businessToday, getTenantTimezone } from '../../shared/utils/businessDate'

// Attendance extras: shift templates (fixed, flexible, split) and rosters (a shift or a day off per person and date,
// filled from a repeating pattern); QR check-in at an office; punches from devices (biometric, turnstile) through
// the integration API; an organisation-wide heatmap; a flag when unapproved absences pass the policy's threshold;
// and an adjustment log for changes made after attendance was locked for payroll.
const ymdArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const day = (s: string) => new Date(`${s}T00:00:00.000Z`)
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const round2 = (n: number) => Math.round(n * 100) / 100

export const ShiftBody = z.object({
  name: z.string().trim().min(2).max(60),
  shiftType: z.enum(['fixed', 'flexible', 'split']),
  startTime: hhmm.nullable().optional(), endTime: hhmm.nullable().optional(),
  splitStartTime: hhmm.nullable().optional(), splitEndTime: hhmm.nullable().optional(),
  graceLateMinutes: z.number().int().min(0).max(240).optional(), graceEarlyOutMinutes: z.number().int().min(0).max(240).optional(),
  halfDayHours: z.number().min(0).max(24).optional(), fullDayHours: z.number().min(0).max(24).optional(), overtimeThresholdHours: z.number().min(0).max(24).optional(),
  overnight: z.boolean().optional(), active: z.boolean().optional(),
}).strict()
// A repeating pattern from a start date: each entry is a shift id or null for a day off (e.g. [early, early, late, late, off, off])
export const RosterBody = z.object({
  employeeIds: z.array(z.string().uuid()).min(1).max(500),
  from: ymdArg, to: ymdArg,
  pattern: z.array(z.string().uuid().nullable()).min(1).max(28),
}).strict()
export const PunchesBody = z.object({
  punches: z.array(z.object({ employeeId: z.string().trim().min(1).max(200), at: z.string().datetime({ offset: true }), type: z.enum(['in', 'out']), deviceId: z.string().trim().max(80).optional() }).strict()).min(1).max(500),
}).strict()

export const attendanceExtras = {
  // ─── Shifts ───────────────────────────────────────────────
  shifts: (tenantId: string) => prisma.shiftTemplate.findMany({ where: { tenantId }, orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
  async saveShift(u: AccessUser, id: string | null, b: z.infer<typeof ShiftBody>) {
    if (b.shiftType !== 'flexible' && (!b.startTime || !b.endTime) && !id) throw new AppError('Set the start and end time', 400)
    if (b.shiftType === 'split' && (!b.splitStartTime || !b.splitEndTime)) throw new AppError('A split shift needs the second part\'s start and end', 400)
    const data = { ...b, ...(b.shiftType !== 'split' && { splitStartTime: null, splitEndTime: null }) }
    if (id) {
      const r = await prisma.shiftTemplate.updateMany({ where: { id, tenantId: u.tenantId }, data })
      if (!r.count) throw new AppError('Shift not found', 404)
      return prisma.shiftTemplate.findUnique({ where: { id } })
    }
    return prisma.shiftTemplate.create({ data: { ...data, tenantId: u.tenantId, name: b.name } })
  },

  // ─── Rosters ──────────────────────────────────────────────
  async assignRoster(u: AccessUser, b: z.infer<typeof RosterBody>) {
    if (b.to < b.from) throw new AppError('The end date is before the start date', 400)
    const span = (day(b.to).getTime() - day(b.from).getTime()) / 86_400_000 + 1
    if (span > 92) throw new AppError('Roster up to 3 months at a time', 400)
    const shiftIds = [...new Set(b.pattern.filter(Boolean) as string[])]
    if ((await prisma.shiftTemplate.count({ where: { tenantId: u.tenantId, id: { in: shiftIds }, active: true } })) !== shiftIds.length) throw new AppError('Shift not found', 404)
    if ((await prisma.employee.count({ where: { tenantId: u.tenantId, id: { in: b.employeeIds }, active: true } })) !== b.employeeIds.length) throw new AppError('Employee not found', 404)
    const rows: { tenantId: string; employeeId: string; date: Date; shiftTemplateId: string | null; createdBy: string }[] = []
    for (let i = 0; i < span; i++) {
      const date = new Date(day(b.from).getTime() + i * 86_400_000)
      for (const e of b.employeeIds) rows.push({ tenantId: u.tenantId, employeeId: e, date, shiftTemplateId: b.pattern[i % b.pattern.length], createdBy: u.userId })
    }
    await prisma.$transaction([
      prisma.rosterDay.deleteMany({ where: { tenantId: u.tenantId, employeeId: { in: b.employeeIds }, date: { gte: day(b.from), lte: day(b.to) } } }),
      prisma.rosterDay.createMany({ data: rows }),
    ])
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'ROSTER_ASSIGNED', entityType: 'roster', entityId: b.from, newValue: { people: b.employeeIds.length, from: b.from, to: b.to, pattern: b.pattern } } })
    return { days: rows.length }
  },
  async roster(u: AccessUser, from: string, to: string, employeeId?: string) {
    const isAdmin = u.roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
    const rows = await prisma.rosterDay.findMany({ where: { tenantId: u.tenantId, date: { gte: day(from), lte: day(to) }, ...(isAdmin ? (employeeId ? { employeeId } : {}) : { employeeId: u.employeeId ?? '-' }) }, orderBy: { date: 'asc' } })
    const [shifts, emps] = await Promise.all([
      prisma.shiftTemplate.findMany({ where: { tenantId: u.tenantId, id: { in: [...new Set(rows.map((r) => r.shiftTemplateId).filter(Boolean) as string[])] } } }),
      prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } }),
    ])
    return rows.map((r) => {
      const s = shifts.find((x) => x.id === r.shiftTemplateId)
      const e = emps.find((x) => x.id === r.employeeId)
      return { employeeId: r.employeeId, employee: e ? `${e.firstName} ${e.lastName}` : null, date: ymd(r.date), off: !r.shiftTemplateId, shift: s ? { id: s.id, name: s.name, startTime: s.startTime, endTime: s.splitEndTime ?? s.endTime, shiftType: s.shiftType } : null }
    })
  },
  // The roster entry for a person on a date: undefined = no roster (use the standing shift); null = day off
  async rosterShift(employeeId: string, date: Date) {
    const r = await prisma.rosterDay.findUnique({ where: { employeeId_date: { employeeId, date: day(ymd(date)) } } })
    if (!r) return undefined
    return r.shiftTemplateId ? prisma.shiftTemplate.findUnique({ where: { id: r.shiftTemplateId } }) : null
  },

  // ─── QR check-in ──────────────────────────────────────────
  async qrToken(u: AccessUser, locationId: string, rotate = false) {
    const loc = await prisma.workLocation.findFirst({ where: { id: locationId, tenantId: u.tenantId } })
    if (!loc) throw new AppError('Office not found', 404)
    if (loc.qrToken && !rotate) return { token: loc.qrToken, location: loc.name }
    const token = crypto.randomBytes(18).toString('base64url')
    await prisma.workLocation.update({ where: { id: loc.id }, data: { qrToken: token } })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'OFFICE_QR_ISSUED', entityType: 'work_location', entityId: loc.id } })
    return { token, location: loc.name }
  },
  async locationForQr(tenantId: string, token: string) {
    const loc = await prisma.workLocation.findFirst({ where: { tenantId, qrToken: token, active: true } })
    if (!loc) throw new AppError('This QR code is not valid any more; ask HR for the current one', 404)
    return loc
  },

  // ─── Device punches ───────────────────────────────────────
  // Each punch names the person by employee ID or work email. Clock-in keeps the first punch of the day; clock-out
  // closes the open session and adds its hours. Punches on locked days are refused one by one, never in bulk.
  async ingestPunches(tenantId: string, punches: z.infer<typeof PunchesBody>['punches']) {
    const tz = await getTenantTimezone(tenantId)
    const keys = [...new Set(punches.map((p) => p.employeeId))]
    const emps = await prisma.employee.findMany({ where: { tenantId, active: true, OR: [{ employeeCode: { in: keys } }, { workEmail: { in: keys } }] }, select: { id: true, employeeCode: true, workEmail: true } })
    const find = (k: string) => emps.find((e) => e.employeeCode === k || e.workEmail === k)
    const results: { employeeId: string; at: string; status: 'ok' | 'skipped'; reason?: string }[] = []
    for (const p of [...punches].sort((a, b) => a.at.localeCompare(b.at))) {
      const e = find(p.employeeId)
      if (!e) { results.push({ employeeId: p.employeeId, at: p.at, status: 'skipped', reason: 'unknown person' }); continue }
      const at = new Date(p.at)
      const date = day(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at))
      const rec = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: e.id, date } } })
      if (rec?.isLocked) { results.push({ employeeId: p.employeeId, at: p.at, status: 'skipped', reason: 'day is locked for payroll' }); continue }
      if (p.type === 'in') {
        if (!rec) await prisma.attendanceRecord.create({ data: { employeeId: e.id, date, status: 'present', checkInTime: at, checkInMethod: 'biometric', openSince: at, source: 'device' } })
        else if (!rec.openSince) await prisma.attendanceRecord.update({ where: { id: rec.id }, data: { openSince: at, ...(!rec.checkInTime && { checkInTime: at, checkInMethod: 'biometric' }), status: rec.status === 'absent' ? 'present' : rec.status } })
        else { results.push({ employeeId: p.employeeId, at: p.at, status: 'skipped', reason: 'already in' }); continue }
      } else {
        if (!rec?.openSince) { results.push({ employeeId: p.employeeId, at: p.at, status: 'skipped', reason: 'no clock-in to close' }); continue }
        const hours = Math.max(0, (at.getTime() - rec.openSince.getTime()) / 3_600_000)
        await prisma.attendanceRecord.update({ where: { id: rec.id }, data: { checkOutTime: at, checkOutMethod: 'biometric', openSince: null, workedHours: round2((rec.workedHours ?? 0) + hours) } })
      }
      results.push({ employeeId: p.employeeId, at: p.at, status: 'ok' })
    }
    return { accepted: results.filter((r) => r.status === 'ok').length, skipped: results.filter((r) => r.status === 'skipped'), }
  },

  // ─── Heatmap ──────────────────────────────────────────────
  // Per department and day of a month: people present, on leave, absent (share of headcount)
  async heatmap(tenantId: string, month: string) {
    const from = day(`${month}-01`)
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0))
    const [emps, records] = await Promise.all([
      prisma.employee.findMany({ where: { tenantId, active: true }, select: { id: true, orgUnit: { select: { name: true } } } }),
      prisma.attendanceRecord.findMany({ where: { employee: { tenantId, active: true }, date: { gte: from, lte: to } }, select: { employeeId: true, date: true, status: true } }),
    ])
    const dept = new Map(emps.map((e) => [e.id, e.orgUnit?.name ?? 'Unassigned']))
    const size = new Map<string, number>()
    for (const d of dept.values()) size.set(d, (size.get(d) ?? 0) + 1)
    const cells = new Map<string, { present: number; leave: number; absent: number }>()
    for (const r of records) {
      const k = `${dept.get(r.employeeId) ?? 'Unassigned'}|${ymd(r.date)}`
      const c = cells.get(k) ?? { present: 0, leave: 0, absent: 0 }
      if (['present', 'late', 'half_day', 'wfh'].includes(r.status)) c.present++
      else if (['leave', 'on_leave'].includes(r.status)) c.leave++
      else if (['absent', 'lwp'].includes(r.status)) c.absent++
      cells.set(k, c)
    }
    const days: string[] = []
    for (let d = from; d <= to; d = new Date(d.getTime() + 86_400_000)) days.push(ymd(d))
    return {
      month, days,
      departments: [...size].sort((a, b) => a[0].localeCompare(b[0])).map(([name, headcount]) => ({
        name, headcount,
        days: days.map((d) => { const c = cells.get(`${name}|${d}`) ?? { present: 0, leave: 0, absent: 0 }; return { date: d, ...c, presentShare: headcount ? round2(c.present / headcount) : 0 } }),
      })),
    }
  },

  // ─── Unapproved absences ──────────────────────────────────
  // Daily: people whose unapproved absences this month reached their policy's threshold; HR is told once a month each
  async absenceFlags(tenantId: string) {
    const policies = await prisma.attendancePolicy.findMany({ where: { tenantId, active: true, lwpFlagAfterAbsences: { not: null } } })
    if (!policies.length) return { flagged: 0 }
    const threshold = Math.min(...policies.map((p) => p.lwpFlagAfterAbsences!))
    const today = await businessToday(tenantId)
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
    const counts = await prisma.attendanceRecord.groupBy({ by: ['employeeId'], where: { employee: { tenantId, active: true }, date: { gte: monthStart, lte: today }, status: 'absent' }, _count: true })
    const flagged = counts.filter((c) => c._count >= threshold)
    let told = 0
    for (const c of flagged) {
      const key = `absence-flag:${c.employeeId}:${ymd(monthStart).slice(0, 7)}`
      if (await prisma.notification.findFirst({ where: { tenantId, eventId: key } })) continue
      const e = await prisma.employee.findUnique({ where: { id: c.employeeId }, select: { firstName: true, lastName: true } })
      await notify({ tenantId, userIds: await userIdsWithRole(tenantId, 'hr_admin'), type: 'attendance.absence_flag', title: `${e?.firstName} ${e?.lastName}: ${c._count} unapproved absences this month`, body: 'Review for leave without pay', link: `/employees/${c.employeeId}`, entityType: 'employee', entityId: c.employeeId, eventId: key })
      told++
    }
    return { flagged: told }
  },

  // ─── Changes after lock ───────────────────────────────────
  async adjustments(tenantId: string, pending: boolean) {
    const rows = await prisma.attendanceAdjustment.findMany({ where: { tenantId, ...(pending && { appliedCycleId: null }) }, orderBy: { date: 'asc' }, take: 500 })
    const emps = await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
    // Days of pay the change moves: absent/lwp → present gives a day back; present → absent/lwp takes one
    const unpaid = (s: string) => ['absent', 'lwp'].includes(s)
    return rows.map((r) => { const e = emps.find((x) => x.id === r.employeeId); return { ...r, date: ymd(r.date), employee: e ? `${e.firstName} ${e.lastName} (${e.employeeCode})` : null, payDays: unpaid(r.fromStatus) === unpaid(r.toStatus) ? 0 : unpaid(r.toStatus) ? -1 : 1 } })
  },
}

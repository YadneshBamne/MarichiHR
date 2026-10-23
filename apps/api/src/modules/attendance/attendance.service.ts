import { attendanceRepository } from './attendance.repository'
import { startApproval, actOnApproval, closeApproval } from '../approvals/approvals.service'
import { ClockInDto, ClockOutDto, RegularisationDto, OvertimeRequestDto, AttendanceOverrideDto } from './attendance.types'
import { AppError } from '../../shared/utils/AppError'
import { eventBus } from '../../infrastructure/events/eventBus'
import { prisma } from '../../infrastructure/database/prisma'
import { attendanceExtras } from './attendance-extras.service'
import {
  businessToday, getTenantTimezone, normaliseDateInput, monthRange, zonedTimeToUtc, localTimeString,
} from '../../shared/utils/businessDate'

import { AccessUser, assertCanApprove, assertProfileAccess } from '../../shared/utils/access'
import { PAYROLL_CONFIG } from '../payroll/payroll.config'
import { calendarApplies, holidayMap, holidaysBetween, holidayTargetOf, HolidayTarget } from '../../shared/utils/holidays'
import { policyFor, minutesOf, isWorkingDay, PolicyRules } from './policy.service'

const ymdOf = (d: Date) => d.toISOString().slice(0, 10)

// Kept to the second (6 decimals of an hour), so the UI can show exact HH:MM:SS totals
function computeWorkedHours(checkIn: Date, checkOut: Date): number {
  const ms = checkOut.getTime() - checkIn.getTime()
  return Math.round((ms / 3_600_000) * 1e6) / 1e6
}

// The session running now: a record clocked in and not out, from today or the two days before (a shift that runs past
// midnight stays on the day it started). Older open records are forgotten clock-outs, left for regularisation.
async function findOpenRecord(employeeId: string, today: Date) {
  return prisma.attendanceRecord.findFirst({
    where: { employeeId, checkInTime: { not: null }, checkOutTime: null, date: { gte: new Date(today.getTime() - 2 * 86_400_000), lte: today } },
    orderBy: { date: 'desc' },
  })
}

function computeStatus(workedHours: number, fullDayHours: number, halfDayHours: number): string {
  if (workedHours >= fullDayHours) return 'present'
  if (workedHours >= halfDayHours) return 'half_day'
  if (workedHours > 0) return 'half_day'
  return 'absent'
}

function computeOvertimeHours(workedHours: number, threshold: number): number {
  return Math.max(0, Math.round((workedHours - threshold) * 100) / 100)
}

// The employee's own shift (if assigned for the day) sets the hours; otherwise their attendance policy does
async function dayRules(employeeId: string, when: Date) {
  const [policy, assigned, rostered] = await Promise.all([
    policyFor(employeeId),
    prisma.employeeShift.findFirst({ where: { employeeId, effectiveFrom: { lte: when }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: when } }] }, include: { shiftTemplate: true }, orderBy: { effectiveFrom: 'desc' } }),
    attendanceExtras.rosterShift(employeeId, when),
  ])
  const shift = rostered === undefined ? assigned?.shiftTemplate : rostered ?? undefined
  return {
    policy,
    flexible: shift ? shift.shiftType === 'flexible' : policy.flexible,
    startTime: shift?.startTime ?? policy.startTime,
    endTime: shift?.splitEndTime ?? shift?.endTime ?? policy.endTime,
    graceIn: shift ? shift.graceLateMinutes : policy.graceInMinutes,
    graceOut: shift ? shift.graceEarlyOutMinutes : policy.graceOutMinutes,
    halfDayHours: shift?.halfDayHours ?? policy.halfDayHours,
    fullDayHours: shift?.fullDayHours ?? policy.fullDayHours,
    overtimeAfter: shift?.overtimeThresholdHours ?? policy.overtimeAfterHours,
  }
}

// Late and early instances this month beyond the policy's allowance cost half or a full day of pay
async function latePenalty(employeeId: string, recordId: string, date: Date, policy: PolicyRules) {
  if (policy.latePenalty === 'none') return null
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  const earlier = await prisma.attendanceRecord.count({
    where: { employeeId, id: { not: recordId }, date: { gte: first, lte: date }, source: { not: 'regularisation' }, OR: [{ lateMinutes: { gt: 0 } }, { earlyOutMinutes: { gt: 0 } }] },
  })
  return earlier + 1 > policy.lateEarlyAllowedPerMonth ? policy.latePenalty : null
}

// Comp-off leave for working a weekly off or a holiday; the balance moves by the change, so repeated clock-outs never double-count
async function grantCompOff(tenantId: string, employeeId: string, record: { id: string; date: Date; compOffDays: number | null }, workedHours: number, policy: PolicyRules) {
  if (!policy.compOffEnabled || (await isWorkingDay(employeeId, tenantId, record.date))) return null
  const days = workedHours >= policy.compOffFullDayHours ? 1 : workedHours >= policy.compOffHalfDayHours ? 0.5 : 0
  const delta = days - (record.compOffDays ?? 0)
  if (delta !== 0) {
    const type = await prisma.leaveType.findFirst({ where: { tenantId, active: true, OR: [{ code: { in: ['COMP_OFF', 'CO', 'COMPOFF'] } }, { name: { contains: 'comp', mode: 'insensitive' } }] } })
    if (!type) return days
    await prisma.leaveBalance.upsert({
      where: { employeeId_leaveTypeId: { employeeId, leaveTypeId: type.id } },
      create: { employeeId, leaveTypeId: type.id, balanceDays: Math.max(0, delta), asOfDate: new Date() },
      update: { balanceDays: { increment: delta } },
    })
  }
  return days
}

function validateGeoFence(
  lat: number,
  lng: number,
  locationLat: number,
  locationLng: number,
  radiusMeters: number
): boolean {
  const R = 6371000
  const dLat = ((lat - locationLat) * Math.PI) / 180
  const dLon = ((lng - locationLng) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((locationLat * Math.PI) / 180) *
      Math.cos((lat * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  const distance = R * c
  return distance <= radiusMeters
}

export const attendanceService = {
  // Several check-in/out pairs a day are fine: clocking in again after clocking out reopens today's record, keeping
  // the first check-in time and the hours already worked (workedHours = closed sessions, openSince = running one)
  async clockIn(employeeId: string, tenantId: string, data: ClockInDto) {
    const today = await businessToday(tenantId)
    const [open, existing] = await Promise.all([findOpenRecord(employeeId, today), attendanceRepository.findTodayRecord(employeeId, today)])
    if (open) throw new AppError('You are already clocked in', 400)
    if (existing?.isLocked) throw new AppError('Attendance record is locked and cannot be modified', 400)
    if (data.qrToken) { const loc = await attendanceExtras.locationForQr(tenantId, data.qrToken); data = { ...data, method: 'qr', locationId: loc.id, latitude: undefined, longitude: undefined } }
    const rules = await dayRules(employeeId, new Date())
    if (!rules.policy.allowWeb && (data.method || 'web') === 'web') throw new AppError('Your attendance policy does not allow clocking in from the web', 403)
    if (rules.policy.requireGeofence && data.method !== 'qr' && !(data.locationId && data.latitude != null && data.longitude != null)) throw new AppError('Your attendance policy needs your location to clock in', 400)

    if (data.locationId && data.latitude && data.longitude) {
      const location = await prisma.workLocation.findUnique({ where: { id: data.locationId } })
      if (location?.latitude && location?.longitude && location?.geoFenceRadiusMeters) {
        const withinFence = validateGeoFence(
          data.latitude,
          data.longitude,
          location.latitude,
          location.longitude,
          location.geoFenceRadiusMeters
        )
        if (!withinFence) {
          throw new AppError(
            `You are outside the allowed geo-fence radius of ${location.geoFenceRadiusMeters}m for ${location.name}`,
            400
          )
        }
      }
    }

    const now = new Date()
    if (existing?.checkInTime) {
      return prisma.attendanceRecord.update({ where: { id: existing.id }, data: { openSince: now, checkOutTime: null } })
    }
    // First clock-in of the day: minutes late after the grace period (none for flexible hours)
    const tz = await getTenantTimezone(tenantId)
    const late = rules.flexible ? 0 : minutesOf(localTimeString(now, tz)) - (minutesOf(rules.startTime) + rules.graceIn)
    const created = await attendanceRepository.createOrUpdateClockIn(employeeId, today, {
      checkInTime: now,
      checkInMethod: data.method || 'web',
      checkInLat: data.latitude,
      checkInLng: data.longitude,
      checkInLocationId: data.locationId,
    })
    if (late > 0) return prisma.attendanceRecord.update({ where: { id: created.id }, data: { lateMinutes: late } })
    return created
  },

  async clockOut(employeeId: string, tenantId: string, data: ClockOutDto) {
    const today = await businessToday(tenantId)
    const record = await findOpenRecord(employeeId, today)

    if (!record?.checkInTime) {
      throw new AppError('You are not clocked in. Please clock in first.', 400)
    }

    if (record.isLocked) {
      throw new AppError('Attendance record is locked and cannot be modified', 400)
    }

    // The day's total: sessions already closed plus the one ending now
    const checkOut = new Date()
    const workedHours = Math.round(((record.workedHours ?? 0) + computeWorkedHours(record.openSince ?? record.checkInTime, checkOut)) * 1e6) / 1e6

    const rules = await dayRules(employeeId, record.date)
    const tz = await getTenantTimezone(tenantId)
    let status = computeStatus(workedHours, rules.fullDayHours, rules.halfDayHours)
    const overtimeHours = rules.policy.overtimeEnabled ? computeOvertimeHours(workedHours, rules.overtimeAfter) : 0
    const earlyOutMinutes = rules.flexible ? 0 : Math.max(0, minutesOf(rules.endTime) - rules.graceOut - minutesOf(localTimeString(checkOut, tz)))
    const penalty = (record.lateMinutes ?? 0) > 0 || earlyOutMinutes > 0 ? await latePenalty(employeeId, record.id, record.date, rules.policy) : null
    if (penalty === 'full_day_lop') status = 'absent'
    else if (penalty === 'half_day_lop') status = status === 'present' ? 'half_day' : 'absent'
    const compOffDays = await grantCompOff(tenantId, employeeId, record, workedHours, rules.policy)

    const updated = await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: {
        checkOutTime: checkOut,
        openSince: null,
        checkOutMethod: data.method || 'web',
        checkOutLat: data.latitude,
        checkOutLng: data.longitude,
        workedHours,
        overtimeHours,
        status,
        earlyOutMinutes: earlyOutMinutes || null,
        penalty,
        ...(compOffDays !== null && { compOffDays }),
      },
    })

    if (overtimeHours > 0) {
      await eventBus.publish(tenantId, 'attendance.exception.flagged', {
        employeeId,
        date: ymdOf(record.date),
        exceptionType: 'overtime',
        overtimeHours,
      })
    }

    return updated
  },

  async getEmployeeCalendar(employeeId: string, year: number, month: number, user: AccessUser) {
    await assertProfileAccess(user, employeeId)
    return attendanceService.getMonthlyCalendar(employeeId, year, month)
  },

  async getMonthlyCalendar(employeeId: string, year: number, month: number) {
    const { start: mStart, end: mEnd, daysInMonth } = monthRange(year, month)
    const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { tenantId: true } })
    const [records, holidayRows, target] = await Promise.all([
      attendanceRepository.getMonthlyCalendar(employeeId, year, month),
      emp ? holidaysBetween(emp.tenantId, mStart, mEnd) : [],
      holidayTargetOf(employeeId),
    ])
    const holidays = holidayMap(holidayRows, target)

    const calendar = []

    for (let day = 1; day <= daysInMonth; day++) {
      const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6

      const record = records.find((r) => new Date(r.date).getUTCDate() === day)

      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const holiday = holidays.get(date) ?? null
      calendar.push({
        date,
        dayOfWeek,
        isWeekend,
        holiday,
        record: record || null,
        status: record?.status || (isWeekend ? 'week_off' : holiday ? 'holiday' : 'no_record'),
      })
    }

    const summary = {
      present: calendar.filter((d) => d.status === 'present').length,
      absent: calendar.filter((d) => d.status === 'absent').length,
      halfDay: calendar.filter((d) => d.status === 'half_day').length,
      onLeave: calendar.filter((d) => d.status === 'on_leave').length,
      weekOff: calendar.filter((d) => d.isWeekend).length,
      holidays: calendar.filter((d) => d.holiday && !d.isWeekend).length,
      totalWorkedHours: records.reduce((sum, r) => sum + (r.workedHours || 0), 0),
      totalOvertimeHours: records.reduce((sum, r) => sum + (r.overtimeHours || 0), 0),
    }

    return { calendar, summary, year, month }
  },

  // The tracker runs from openSince on the server (not browser memory), so a refresh, new tab or new sign-in resumes
  // it exactly; serverTime lets the browser correct for its own clock being off
  async getTodayStatus(employeeId: string, tenantId: string) {
    const today = await businessToday(tenantId)
    const [open, todays] = await Promise.all([findOpenRecord(employeeId, today), attendanceRepository.findTodayRecord(employeeId, today)])
    const record = open ?? todays
    return {
      date: ymdOf(record?.date ?? today),
      clockedIn: !!record?.checkInTime,
      clockedOut: !!record?.checkInTime && !open,
      running: !!open,
      checkInTime: record?.checkInTime || null,
      checkOutTime: record?.checkOutTime || null,
      openSince: open ? open.openSince ?? open.checkInTime : null,
      workedHours: record?.workedHours || 0,
      status: record?.status || 'not_started',
      serverTime: new Date(),
    }
  },

  async getTeamAttendanceToday(managerId: string, tenantId: string, isHR: boolean) {
    const today = await businessToday(tenantId)
    if (isHR) {
      return attendanceRepository.getOrgAttendanceToday(tenantId, today)
    }
    return attendanceRepository.getTeamAttendanceToday(managerId, today)
  },

  async raiseRegularisation(employeeId: string, tenantId: string, data: RegularisationDto) {
    const date = normaliseDateInput(data.date)
    const tz = await getTenantTimezone(tenantId)
    const [policy, today] = await Promise.all([policyFor(employeeId), businessToday(tenantId)])
    if (date > today) throw new AppError('You cannot regularise a future day', 400)
    if ((today.getTime() - date.getTime()) / 86_400_000 > policy.regularisationDaysBack) throw new AppError(`Your attendance policy allows regularising up to ${policy.regularisationDaysBack} days back`, 400)
    const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)), monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
    const used = await prisma.attendanceRegularisation.count({ where: { employeeId, date: { gte: monthStart, lte: monthEnd }, status: { in: ['pending', 'approved'] } } })
    if (used >= policy.regularisationPerMonth) throw new AppError(`Your attendance policy allows ${policy.regularisationPerMonth} regularisations a month`, 400)

    const record = await attendanceRepository.findByDate(employeeId, date)
    if (record?.isLocked) {
      throw new AppError('Attendance record is locked. Contact HR for corrections.', 400)
    }

    const existing = await prisma.attendanceRegularisation.findFirst({
      where: { employeeId, date, status: { in: ['pending', 'approved'] } },
    })
    if (existing) {
      throw new AppError('A regularisation request already exists for this date', 409)
    }

    const created = await attendanceRepository.createRegularisation(employeeId, {
      date,
      actualIn: data.actualIn,
      actualOut: data.actualOut,
      reason: data.reason,
      expectedIn: record?.checkInTime ? localTimeString(record.checkInTime, tz) : undefined,
      expectedOut: record?.checkOutTime ? localTimeString(record.checkOutTime, tz) : undefined,
    })
    await startApproval(tenantId, 'regularisation', created.id, employeeId)
    return created
  },

  async approveRegularisation(id: string, user: AccessUser, opts: { override?: boolean; comments?: string } = {}) {
    const { tenantId } = user
    const reg = await attendanceRepository.findRegularisationById(id)
    if (!reg || reg.employee.tenantId !== tenantId) throw new AppError('Regularisation not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can approve requests', 403)
    const approverId = user.employeeId
    if (reg.status !== 'pending') throw new AppError(`Already ${reg.status}`, 400)
    const step = await actOnApproval(user, 'regularisation', id, reg.employeeId, true, opts.comments, opts)
    if (!step.final) return attendanceRepository.findRegularisationById(id)

    await attendanceRepository.approveRegularisation(id, approverId)

    const regDate = normaliseDateInput(reg.date)
    const tz = await getTenantTimezone(tenantId)
    const checkIn = zonedTimeToUtc(ymdOf(regDate), reg.actualIn!, tz)
    const checkOut = zonedTimeToUtc(ymdOf(regDate), reg.actualOut!, tz)

    const workedHours = computeWorkedHours(checkIn, checkOut)
    const rules = await dayRules(reg.employeeId, regDate)
    const status = computeStatus(workedHours, rules.fullDayHours, rules.halfDayHours)
    const overtime = rules.policy.overtimeEnabled ? computeOvertimeHours(workedHours, rules.overtimeAfter) : 0

    await prisma.attendanceRecord.upsert({
      where: {
        employeeId_date: {
          employeeId: reg.employeeId,
          date: regDate,
        },
      },
      update: {
        checkInTime: checkIn,
        checkOutTime: checkOut,
        openSince: null,
        workedHours,
        overtimeHours: overtime,
        status,
        lateMinutes: null,
        earlyOutMinutes: null,
        penalty: null,
        source: 'regularisation',
        overrideReason: reg.reason ?? undefined,
        overrideBy: approverId,
        updatedAt: new Date(),
      },
      create: {
        employeeId: reg.employeeId,
        date: regDate,
        checkInTime: checkIn,
        checkOutTime: checkOut,
        workedHours,
        overtimeHours: overtime,
        status,
        source: 'regularisation',
        overrideReason: reg.reason ?? undefined,
        overrideBy: approverId,
      },
    })

    return attendanceRepository.findRegularisationById(id)
  },

  async rejectRegularisation(id: string, user: AccessUser, opts: { override?: boolean; comments?: string } = {}) {
    const { tenantId } = user
    const reg = await attendanceRepository.findRegularisationById(id)
    if (!reg || reg.employee.tenantId !== tenantId) throw new AppError('Regularisation not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can reject requests', 403)
    const approverId = user.employeeId
    if (reg.status !== 'pending') throw new AppError(`Already ${reg.status}`, 400)
    await actOnApproval(user, 'regularisation', id, reg.employeeId, false, opts.comments, opts)

    return attendanceRepository.rejectRegularisation(id, approverId)
  },

  async listMyRegularisations(employeeId: string) {
    return attendanceRepository.listMyRegularisations(employeeId)
  },

  async listPendingRegularisations(approverId: string, tenantId: string, isHR: boolean) {
    if (isHR) return attendanceRepository.listAllPendingRegularisations(tenantId)
    return attendanceRepository.listPendingRegularisations(approverId)
  },

  async requestOvertime(employeeId: string, tenantId: string, data: OvertimeRequestDto) {
    const policy = await policyFor(employeeId)
    if (!policy.overtimeEnabled) throw new AppError('Your attendance policy does not pay overtime', 400)
    if (policy.overtimeMaxHoursPerMonth != null) {
      const d = normaliseDateInput(data.date)
      const agg = await prisma.overtimeRequest.aggregate({ _sum: { overtimeHours: true }, where: { employeeId, status: { in: ['pending', 'approved'] }, date: { gte: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), lte: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)) } } })
      if ((agg._sum.overtimeHours ?? 0) + data.overtimeHours > policy.overtimeMaxHoursPerMonth) throw new AppError(`Your attendance policy caps overtime at ${policy.overtimeMaxHoursPerMonth} hours a month`, 400)
    }
    const ot = await attendanceRepository.createOvertimeRequest(employeeId, {
      date: normaliseDateInput(data.date),
      overtimeHours: data.overtimeHours,
      reason: data.reason,
    })
    await startApproval(tenantId, 'overtime', ot.id, employeeId)
    return ot
  },

  async approveOvertime(id: string, user: AccessUser, rate?: number, opts: { override?: boolean; comments?: string } = {}) {
    const { tenantId } = user
    const req = await prisma.overtimeRequest.findUnique({ where: { id }, include: { employee: { select: { tenantId: true } } } })
    if (!req || req.employee.tenantId !== tenantId) throw new AppError('Overtime request not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can approve requests', 403)
    const approverId = user.employeeId
    const approvedRate = rate ?? (await policyFor(req.employeeId)).overtimeRate // the policy's rate unless the approver sets one
    if (typeof approvedRate !== 'number' || !Number.isFinite(approvedRate) || approvedRate < 1 || approvedRate > 5) {
      throw new AppError('Approved rate must be a number between 1 and 5', 400)
    }
    if (req.status !== 'pending') throw new AppError(`Already ${req.status}`, 400)
    const step = await actOnApproval(user, 'overtime', id, req.employeeId, true, opts.comments, opts)
    if (!step.final) return prisma.overtimeRequest.findUnique({ where: { id } })

    return attendanceRepository.approveOvertimeRequest(id, approverId, approvedRate)
  },

  async rejectOvertime(id: string, user: AccessUser, opts: { override?: boolean; comments?: string } = {}) {
    const { tenantId } = user
    const req = await prisma.overtimeRequest.findUnique({ where: { id }, include: { employee: { select: { tenantId: true } } } })
    if (!req || req.employee.tenantId !== tenantId) throw new AppError('Overtime request not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can reject requests', 403)
    const approverId = user.employeeId
    if (req.status !== 'pending') throw new AppError(`Already ${req.status}`, 400)
    await actOnApproval(user, 'overtime', id, req.employeeId, false, opts.comments, opts)

    return attendanceRepository.rejectOvertimeRequest(id, approverId)
  },

  async listMyOvertime(employeeId: string) {
    return attendanceRepository.listMyOvertimeRequests(employeeId)
  },

  async listPendingOvertime(approverId: string) {
    return attendanceRepository.listPendingOvertimeRequests(approverId)
  },

  async overrideAttendance(tenantId: string, data: AttendanceOverrideDto, overrideBy: string) {
    const employee = await prisma.employee.findFirst({ where: { id: data.employeeId, tenantId }, select: { id: true } })
    if (!employee) throw new AppError('Employee not found', 404)
    const before = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: data.employeeId, date: normaliseDateInput(data.date) } } })
    if (before?.isLocked && before.status !== data.status) {
      await prisma.attendanceAdjustment.create({ data: { tenantId, employeeId: data.employeeId, date: normaliseDateInput(data.date), fromStatus: before.status, toStatus: data.status, reason: data.reason, adjustedBy: overrideBy } })
    }
    return attendanceRepository.overrideStatus(
      data.employeeId,
      normaliseDateInput(data.date),
      data.status,
      data.reason,
      overrideBy
    )
  },

  async lockAttendance(tenantId: string, startDate: string, endDate: string, lockedBy: string) {
    const result = await attendanceRepository.lockAttendanceForCycle(
      tenantId,
      normaliseDateInput(startDate),
      normaliseDateInput(endDate),
      lockedBy
    )

    await eventBus.publish(tenantId, 'attendance.locked', {
      startDate,
      endDate,
      lockedBy,
      recordsLocked: result.count,
    })

    return {
      message: `Attendance locked for ${startDate} to ${endDate}`,
      recordsLocked: result.count,
    }
  },

  // Nightly job: a working day (resource calendar, minus the employee's public holidays) that has no attendance record
  // and no approved leave becomes an 'absent' record with source 'system'. Looks back a few days so a missed run
  // catches up; days already recorded or inside a payroll cycle whose attendance is locked are never touched.
  // `asOf` (YYYY-MM-DD) and `employeeIds` narrow a run for tests and back-fills; the scheduled job passes neither.
  async markAbsences(tenantId: string, opts: { lookbackDays?: number; asOf?: string; employeeIds?: string[] } = {}) {
    const lookbackDays = opts.lookbackDays ?? 3
    const today = opts.asOf ? normaliseDateInput(opts.asOf) : await businessToday(tenantId)
    const dates: string[] = []
    for (let i = lookbackDays; i >= 1; i--) dates.push(ymdOf(new Date(today.getTime() - i * 86_400_000)))
    const from = normaliseDateInput(dates[0])
    const to = normaliseDateInput(dates[dates.length - 1])

    const [employees, holidays, records, leaves, lockedCycles] = await Promise.all([
      prisma.employee.findMany({
        where: { tenantId, active: true, employmentStatus: { not: 'terminated' }, ...(opts.employeeIds && { id: { in: opts.employeeIds } }) },
        select: {
          id: true, hireDate: true, exitDate: true, taxJurisdiction: true, workLocationId: true,
          workLocation: { select: { countryCode: true } },
          resourceCalendar: { select: { days: { select: { dayOfWeek: true } } } },
        },
      }),
      holidaysBetween(tenantId, from, to),
      prisma.attendanceRecord.findMany({
        where: { employee: { tenantId }, date: { gte: from, lte: to } },
        select: { employeeId: true, date: true },
      }),
      prisma.leaveRequest.findMany({
        where: { status: 'approved', employee: { tenantId }, startDate: { lte: to }, endDate: { gte: from } },
        select: { employeeId: true, startDate: true, endDate: true },
      }),
      prisma.payrollCycle.findMany({
        where: { tenantId, attendanceLockedAt: { not: null }, payPeriodStart: { lte: to }, payPeriodEnd: { gte: from } },
        select: { payPeriodStart: true, payPeriodEnd: true },
      }),
    ])

    const recorded = new Set(records.map((r) => `${r.employeeId}|${ymdOf(r.date)}`))
    const locked = (d: string) => lockedCycles.some((c) => ymdOf(c.payPeriodStart) <= d && d <= ymdOf(c.payPeriodEnd))
    const onLeave = (empId: string, d: string) => leaves.some((l) => l.employeeId === empId && ymdOf(l.startDate) <= d && d <= ymdOf(l.endDate))
    const isHoliday = (who: HolidayTarget, d: string) => holidays.some((h) => !h.isOptional && ymdOf(h.date) === d && calendarApplies(h.calendar, who))

    const created: { employeeId: string; date: string }[] = []
    for (const emp of employees) {
      // dayOfWeek in resource calendars: 0 = Monday ... 6 = Sunday
      // ponytail: two-week calendars (weekType) are treated as one repeating week
      const workDays = new Set<number>(emp.resourceCalendar?.days?.length ? emp.resourceCalendar.days.map((d) => d.dayOfWeek) : PAYROLL_CONFIG.DEFAULT_WORKING_DAYS)
      const who = { countryCode: emp.workLocation?.countryCode || emp.taxJurisdiction || null, workLocationId: emp.workLocationId ?? null }
      const marked: string[] = []
      for (const d of dates) {
        if (d < ymdOf(emp.hireDate) || (emp.exitDate && d > ymdOf(emp.exitDate))) continue
        if (!workDays.has((normaliseDateInput(d).getUTCDay() + 6) % 7)) continue
        if (isHoliday(who, d) || recorded.has(`${emp.id}|${d}`) || onLeave(emp.id, d) || locked(d)) continue
        const res = await prisma.attendanceRecord.createMany({
          data: [{ employeeId: emp.id, date: normaliseDateInput(d), status: 'absent', source: 'system', overrideReason: 'No attendance or approved leave (nightly job)' }],
          skipDuplicates: true,
        })
        if (res.count) marked.push(d)
      }
      if (marked.length) {
        created.push(...marked.map((date) => ({ employeeId: emp.id, date })))
        await eventBus.publish(tenantId, 'attendance.absent.marked', { employeeId: emp.id, date: marked.join(', ') })
      }
    }
    return { dates, marked: created.length, records: created }
  },
}

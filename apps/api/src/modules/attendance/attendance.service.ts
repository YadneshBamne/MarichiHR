import { attendanceRepository } from './attendance.repository'
import { ClockInDto, ClockOutDto, RegularisationDto, OvertimeRequestDto, AttendanceOverrideDto } from './attendance.types'
import { AppError } from '../../shared/utils/AppError'
import { eventBus } from '../../infrastructure/events/eventBus'
import { prisma } from '../../infrastructure/database/prisma'
import {
  businessToday, getTenantTimezone, normaliseDateInput, monthRange, zonedTimeToUtc, localTimeString,
} from '../../shared/utils/businessDate'

import { AccessUser, assertCanApprove, assertProfileAccess } from '../../shared/utils/access'

const ymdOf = (d: Date) => d.toISOString().slice(0, 10)

function computeWorkedHours(checkIn: Date, checkOut: Date): number {
  const ms = checkOut.getTime() - checkIn.getTime()
  return Math.round((ms / (1000 * 60 * 60)) * 100) / 100
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
  async clockIn(employeeId: string, tenantId: string, data: ClockInDto) {
    const today = await businessToday(tenantId)
    const existing = await attendanceRepository.findTodayRecord(employeeId, today)
    if (existing?.checkInTime) {
      throw new AppError('Already clocked in today', 400)
    }

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

    return attendanceRepository.createOrUpdateClockIn(employeeId, today, {
      checkInTime: new Date(),
      checkInMethod: data.method || 'web',
      checkInLat: data.latitude,
      checkInLng: data.longitude,
      checkInLocationId: data.locationId,
    })
  },

  async clockOut(employeeId: string, tenantId: string, data: ClockOutDto) {
    const today = await businessToday(tenantId)
    const record = await attendanceRepository.findTodayRecord(employeeId, today)

    if (!record?.checkInTime) {
      throw new AppError('No clock-in found for today. Please clock in first.', 400)
    }

    if (record.checkOutTime) {
      throw new AppError('Already clocked out today', 400)
    }

    if (record.isLocked) {
      throw new AppError('Attendance record is locked and cannot be modified', 400)
    }

    const checkOut = new Date()
    const workedHours = computeWorkedHours(record.checkInTime, checkOut)

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: {
        employeeShifts: {
          where: {
            effectiveFrom: { lte: new Date() },
            OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: new Date() } }],
          },
          include: { shiftTemplate: true },
          orderBy: { effectiveFrom: 'desc' },
          take: 1,
        },
      },
    })

    const shift = employee?.employeeShifts?.[0]?.shiftTemplate
    const fullDayHours = shift?.fullDayHours ?? 8
    const halfDayHours = shift?.halfDayHours ?? 4
    const overtimeThreshold = shift?.overtimeThresholdHours ?? 8

    const status = computeStatus(workedHours, fullDayHours, halfDayHours)
    const overtimeHours = computeOvertimeHours(workedHours, overtimeThreshold)

    const updated = await attendanceRepository.updateClockOut(employeeId, today, {
      checkOutTime: checkOut,
      checkOutMethod: data.method || 'web',
      checkOutLat: data.latitude,
      checkOutLng: data.longitude,
      workedHours,
      overtimeHours,
      status,
    })

    if (overtimeHours > 0) {
      await eventBus.publish(tenantId, 'attendance.exception.flagged', {
        employeeId,
        date: ymdOf(today),
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
    const records = await attendanceRepository.getMonthlyCalendar(employeeId, year, month)

    const { daysInMonth } = monthRange(year, month)
    const calendar = []

    for (let day = 1; day <= daysInMonth; day++) {
      const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6

      const record = records.find((r) => new Date(r.date).getUTCDate() === day)

      calendar.push({
        date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        dayOfWeek,
        isWeekend,
        record: record || null,
        status: record?.status || (isWeekend ? 'week_off' : 'no_record'),
      })
    }

    const summary = {
      present: calendar.filter((d) => d.status === 'present').length,
      absent: calendar.filter((d) => d.status === 'absent').length,
      halfDay: calendar.filter((d) => d.status === 'half_day').length,
      onLeave: calendar.filter((d) => d.status === 'on_leave').length,
      weekOff: calendar.filter((d) => d.isWeekend).length,
      totalWorkedHours: records.reduce((sum, r) => sum + (r.workedHours || 0), 0),
      totalOvertimeHours: records.reduce((sum, r) => sum + (r.overtimeHours || 0), 0),
    }

    return { calendar, summary, year, month }
  },

  async getTodayStatus(employeeId: string, tenantId: string) {
    const today = await businessToday(tenantId)
    const record = await attendanceRepository.findTodayRecord(employeeId, today)
    return {
      date: ymdOf(today),
      clockedIn: !!record?.checkInTime,
      clockedOut: !!record?.checkOutTime,
      checkInTime: record?.checkInTime || null,
      checkOutTime: record?.checkOutTime || null,
      workedHours: record?.workedHours || 0,
      status: record?.status || 'not_started',
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

    return attendanceRepository.createRegularisation(employeeId, {
      date,
      actualIn: data.actualIn,
      actualOut: data.actualOut,
      reason: data.reason,
      expectedIn: record?.checkInTime ? localTimeString(record.checkInTime, tz) : undefined,
      expectedOut: record?.checkOutTime ? localTimeString(record.checkOutTime, tz) : undefined,
    })
  },

  async approveRegularisation(id: string, user: AccessUser) {
    const { tenantId } = user
    const reg = await attendanceRepository.findRegularisationById(id)
    if (!reg || reg.employee.tenantId !== tenantId) throw new AppError('Regularisation not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can approve requests', 403)
    const approverId = user.employeeId
    await assertCanApprove(user, reg.employeeId, tenantId, { entityType: 'attendance_regularisation', entityId: id })
    if (reg.status !== 'pending') throw new AppError(`Already ${reg.status}`, 400)

    await attendanceRepository.approveRegularisation(id, approverId)

    const regDate = normaliseDateInput(reg.date)
    const tz = await getTenantTimezone(tenantId)
    const checkIn = zonedTimeToUtc(ymdOf(regDate), reg.actualIn!, tz)
    const checkOut = zonedTimeToUtc(ymdOf(regDate), reg.actualOut!, tz)

    const workedHours = computeWorkedHours(checkIn, checkOut)
    const status = workedHours >= 8 ? 'present' : workedHours >= 4 ? 'half_day' : 'absent'

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
        workedHours,
        overtimeHours: Math.max(0, workedHours - 8),
        status,
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
        overtimeHours: Math.max(0, workedHours - 8),
        status,
        source: 'regularisation',
        overrideReason: reg.reason ?? undefined,
        overrideBy: approverId,
      },
    })

    return attendanceRepository.findRegularisationById(id)
  },

  async rejectRegularisation(id: string, user: AccessUser) {
    const { tenantId } = user
    const reg = await attendanceRepository.findRegularisationById(id)
    if (!reg || reg.employee.tenantId !== tenantId) throw new AppError('Regularisation not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can reject requests', 403)
    const approverId = user.employeeId
    await assertCanApprove(user, reg.employeeId, tenantId, { entityType: 'attendance_regularisation', entityId: id })
    if (reg.status !== 'pending') throw new AppError(`Already ${reg.status}`, 400)

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
    return attendanceRepository.createOvertimeRequest(employeeId, {
      date: normaliseDateInput(data.date),
      overtimeHours: data.overtimeHours,
      reason: data.reason,
    })
  },

  async approveOvertime(id: string, user: AccessUser, approvedRate: number = 1.5) {
    const { tenantId } = user
    const req = await prisma.overtimeRequest.findUnique({ where: { id }, include: { employee: { select: { tenantId: true } } } })
    if (!req || req.employee.tenantId !== tenantId) throw new AppError('Overtime request not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can approve requests', 403)
    const approverId = user.employeeId
    await assertCanApprove(user, req.employeeId, tenantId, { entityType: 'overtime_request', entityId: id })
    if (typeof approvedRate !== 'number' || !Number.isFinite(approvedRate) || approvedRate < 1 || approvedRate > 5) {
      throw new AppError('Approved rate must be a number between 1 and 5', 400)
    }
    if (req.status !== 'pending') throw new AppError(`Already ${req.status}`, 400)

    return attendanceRepository.approveOvertimeRequest(id, approverId, approvedRate)
  },

  async rejectOvertime(id: string, user: AccessUser) {
    const { tenantId } = user
    const req = await prisma.overtimeRequest.findUnique({ where: { id }, include: { employee: { select: { tenantId: true } } } })
    if (!req || req.employee.tenantId !== tenantId) throw new AppError('Overtime request not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can reject requests', 403)
    const approverId = user.employeeId
    await assertCanApprove(user, req.employeeId, tenantId, { entityType: 'overtime_request', entityId: id })
    if (req.status !== 'pending') throw new AppError(`Already ${req.status}`, 400)

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
}

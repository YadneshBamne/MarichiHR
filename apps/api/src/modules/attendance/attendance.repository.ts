import { prisma } from '../../infrastructure/database/prisma'
import { normaliseDateInput, monthRange } from '../../shared/utils/businessDate'

export const attendanceRepository = {
  // ─── ATTENDANCE RECORDS ───────────────────────────────────
  async findTodayRecord(employeeId: string, date: Date) {
    return prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId, date } },
    })
  },

  async findByDate(employeeId: string, date: Date) {
    const d = normaliseDateInput(date)
    return prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId, date: d } },
    })
  },

  async createOrUpdateClockIn(employeeId: string, today: Date, data: {
    checkInTime: Date
    checkInMethod: string
    checkInLat?: number
    checkInLng?: number
    checkInLocationId?: string
  }) {
    return prisma.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId, date: today } },
      update: {
        checkInTime: data.checkInTime,
        openSince: data.checkInTime,
        checkInMethod: data.checkInMethod,
        checkInLat: data.checkInLat,
        checkInLng: data.checkInLng,
        checkInLocationId: data.checkInLocationId,
        status: 'present',
        source: 'auto',
      },
      create: {
        employeeId,
        date: today,
        checkInTime: data.checkInTime,
        openSince: data.checkInTime,
        checkInMethod: data.checkInMethod,
        checkInLat: data.checkInLat,
        checkInLng: data.checkInLng,
        checkInLocationId: data.checkInLocationId,
        status: 'present',
        source: 'auto',
      },
    })
  },

  async getMonthlyCalendar(employeeId: string, year: number, month: number) {
    const { start: startDate, end: endDate } = monthRange(year, month)

    return prisma.attendanceRecord.findMany({
      where: {
        employeeId,
        date: { gte: startDate, lte: endDate },
      },
      include: {
        checkInLocation: { select: { name: true, city: true } },
      },
      orderBy: { date: 'asc' },
    })
  },

  async getTeamAttendanceToday(managerId: string, today: Date) {
    return prisma.attendanceRecord.findMany({
      where: {
        date: today,
        employee: { managerId, active: true },
      },
      include: {
        employee: {
          include: {
            user: { select: { fullName: true, avatarUrl: true } },
            jobPosition: { select: { title: true } },
          },
        },
      },
      orderBy: { checkInTime: 'asc' },
    })
  },

  async getOrgAttendanceToday(tenantId: string, today: Date) {
    return prisma.attendanceRecord.findMany({
      where: {
        date: today,
        employee: { tenantId, active: true },
      },
      include: {
        employee: {
          include: {
            user: { select: { fullName: true, avatarUrl: true } },
            orgUnit: { select: { name: true } },
          },
        },
      },
      orderBy: { status: 'asc' },
    })
  },

  async overrideStatus(employeeId: string, date: Date, status: string, reason: string, overrideBy: string) {
    const d = normaliseDateInput(date)

    return prisma.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId, date: d } },
      update: { status, overrideReason: reason, overrideBy, source: 'hr_override' },
      create: {
        employeeId,
        date: d,
        status,
        source: 'hr_override',
        overrideReason: reason,
        overrideBy,
      },
    })
  },

  async lockAttendanceForCycle(tenantId: string, startDate: Date, endDate: Date, lockedBy: string) {
    return prisma.attendanceRecord.updateMany({
      where: {
        date: { gte: startDate, lte: endDate },
        isLocked: false,
        employee: { tenantId, active: true },
      },
      data: { isLocked: true },
    })
  },

  // ─── REGULARISATIONS ──────────────────────────────────────
  async createRegularisation(employeeId: string, data: {
    date: Date
    actualIn: string
    actualOut: string
    reason: string
    expectedIn?: string
    expectedOut?: string
  }) {
    return prisma.attendanceRegularisation.create({
      data: {
        employeeId,
        date: data.date,
        actualIn: data.actualIn,
        actualOut: data.actualOut,
        reason: data.reason,
        expectedIn: data.expectedIn,
        expectedOut: data.expectedOut,
        status: 'pending',
      },
      include: {
        employee: {
          include: {
            manager: { select: { id: true } },
            user: { select: { fullName: true } },
          },
        },
      },
    })
  },

  async findRegularisationById(id: string) {
    return prisma.attendanceRegularisation.findUnique({
      where: { id },
      include: {
        employee: {
          include: {
            user: { select: { fullName: true } },
            manager: { select: { id: true } },
          },
        },
      },
    })
  },

  async listMyRegularisations(employeeId: string) {
    return prisma.attendanceRegularisation.findMany({
      where: { employeeId },
      orderBy: { date: 'desc' },
    })
  },

  async listPendingRegularisations(managerId: string) {
    return prisma.attendanceRegularisation.findMany({
      where: {
        status: 'pending',
        employee: { managerId },
      },
      include: {
        employee: {
          include: { user: { select: { fullName: true, avatarUrl: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    })
  },

  async listAllPendingRegularisations(tenantId: string) {
    return prisma.attendanceRegularisation.findMany({
      where: {
        status: 'pending',
        employee: { tenantId },
      },
      include: {
        employee: {
          include: { user: { select: { fullName: true, avatarUrl: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    })
  },

  async approveRegularisation(id: string, approverId: string) {
    return prisma.attendanceRegularisation.update({
      where: { id },
      data: { status: 'approved', approverId, actionedAt: new Date() },
    })
  },

  async rejectRegularisation(id: string, approverId: string) {
    return prisma.attendanceRegularisation.update({
      where: { id },
      data: { status: 'rejected', approverId, actionedAt: new Date() },
    })
  },

  // ─── OVERTIME ─────────────────────────────────────────────
  async createOvertimeRequest(employeeId: string, data: {
    date: Date
    overtimeHours: number
    reason: string
  }) {
    return prisma.overtimeRequest.create({
      data: {
        employeeId,
        date: data.date,
        overtimeHours: data.overtimeHours,
        reason: data.reason,
        status: 'pending',
      },
      include: {
        employee: {
          include: { user: { select: { fullName: true } }, manager: { select: { id: true } } },
        },
      },
    })
  },

  async listMyOvertimeRequests(employeeId: string) {
    return prisma.overtimeRequest.findMany({
      where: { employeeId },
      orderBy: { date: 'desc' },
    })
  },

  async listPendingOvertimeRequests(managerId: string) {
    return prisma.overtimeRequest.findMany({
      where: { status: 'pending', employee: { managerId } },
      include: {
        employee: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    })
  },

  async approveOvertimeRequest(id: string, approverId: string, approvedRate: number) {
    return prisma.overtimeRequest.update({
      where: { id },
      data: { status: 'approved', approverId, approvedRate, actionedAt: new Date() },
    })
  },

  async rejectOvertimeRequest(id: string, approverId: string) {
    return prisma.overtimeRequest.update({
      where: { id },
      data: { status: 'rejected', approverId, actionedAt: new Date() },
    })
  },
}

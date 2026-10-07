import { activitiesRepository, logSystemChatter } from './activities.repository'
import { CreateActivityDto, CompleteActivityDto, CreateChatterMessageDto } from './activities.types'
import { AppError } from '../../shared/utils/AppError'
import { prisma } from '../../infrastructure/database/prisma'
import { businessToday } from '../../shared/utils/businessDate'
import { AccessUser, assertProfileAccess, assertCompensationAccess } from '../../shared/utils/access'

interface ResolvedEntity {
  tenantId: string
  ownerEmployeeId: string
  ownerManagerId: string | null
}

const ownerSelect = { select: { id: true, tenantId: true, managerId: true } } as const
const toResolved = (e: { id: string; tenantId: string; managerId: string | null } | null | undefined): ResolvedEntity | null =>
  e ? { tenantId: e.tenantId, ownerEmployeeId: e.id, ownerManagerId: e.managerId } : null

// Entity types with a table behind them resolve to their owning employee; anything else cannot be verified
async function resolveEntity(entityType: string, entityId: string): Promise<ResolvedEntity | null> {
  switch (entityType) {
    case 'employee':
      return toResolved(await prisma.employee.findUnique({ where: { id: entityId }, ...ownerSelect }))
    case 'contract':
      return toResolved((await prisma.employeeContract.findUnique({ where: { id: entityId }, select: { employee: ownerSelect } }))?.employee)
    case 'leave_request':
      return toResolved((await prisma.leaveRequest.findUnique({ where: { id: entityId }, select: { employee: ownerSelect } }))?.employee)
    case 'attendance_regularisation':
      return toResolved((await prisma.attendanceRegularisation.findUnique({ where: { id: entityId }, select: { employee: ownerSelect } }))?.employee)
    default:
      return null
  }
}

// Who may see an entity's activities and chatter. Denials are 404 so existence is never revealed.
async function assertEntityAccess(user: AccessUser, entityType: string, entityId: string) {
  const isHR = user.roleIds.includes('hr_admin')
  if (entityType === 'employee') return assertProfileAccess(user, entityId)

  const entity = await resolveEntity(entityType, entityId)
  if (entity && entity.tenantId !== user.tenantId) throw new AppError('Not found', 404)

  if (entityType === 'contract') {
    if (!entity) throw new AppError('Not found', 404)
    return assertCompensationAccess(user, entity.ownerEmployeeId)
  }
  if (entityType === 'leave_request') {
    if (!entity) throw new AppError('Not found', 404)
    const isOwner = !!user.employeeId && user.employeeId === entity.ownerEmployeeId
    const isManager = !!user.employeeId && user.employeeId === entity.ownerManagerId
    if (isOwner || isManager || isHR) return
    throw new AppError('Not found', 404)
  }
  // Any other or unknown entity type: HR only
  if (!isHR) throw new AppError('Not found', 404)
}

export const activitiesService = {
  async createActivity(tenantId: string, createdBy: string, data: CreateActivityDto) {
    const activityType = await prisma.activityType.findFirst({ where: { id: data.activityTypeId, tenantId }, select: { id: true } })
    if (!activityType) throw new AppError('Activity type not found', 404)
    const assignee = await prisma.employee.findFirst({ where: { id: data.assignedToId, tenantId }, select: { id: true } })
    if (!assignee) throw new AppError('Assignee not found', 404)

    if (['employee', 'contract', 'leave_request', 'attendance_regularisation'].includes(data.entityType)) {
      const entity = await resolveEntity(data.entityType, data.entityId)
      if (!entity || entity.tenantId !== tenantId) throw new AppError('Related record not found', 404)
    }
    return activitiesRepository.create(tenantId, createdBy, data)
  },

  async listForEntity(entityType: string, entityId: string, user: AccessUser) {
    await assertEntityAccess(user, entityType, entityId)
    return activitiesRepository.listForEntity(entityType, entityId, user.tenantId)
  },

  async listMyActivities(assignedToId: string, status?: string) {
    return activitiesRepository.listMyActivities(assignedToId, status)
  },

  async completeActivity(id: string, employeeId: string, tenantId: string, data: CompleteActivityDto) {
    const activity = await prisma.activity.findUnique({ where: { id } })
    if (!activity || activity.tenantId !== tenantId) throw new AppError('Activity not found', 404)
    if (activity.assignedToId !== employeeId) throw new AppError('You can only complete activities assigned to you', 403)
    if (activity.status === 'done') throw new AppError('Activity is already completed', 400)

    const completed = await activitiesRepository.complete(id, data.doneNote)

    await logSystemChatter(
      tenantId,
      activity.entityType,
      activity.entityId,
      `Activity "${activity.title}" marked as done. Note: ${data.doneNote}`
    )

    return completed
  },

  async cancelActivity(id: string, tenantId: string) {
    const activity = await prisma.activity.findUnique({ where: { id } })
    if (!activity || activity.tenantId !== tenantId) throw new AppError('Activity not found', 404)
    return activitiesRepository.cancel(id)
  },

  async postMessage(user: AccessUser, data: CreateChatterMessageDto, isHR: boolean) {
    const employeeId = user.employeeId as string
    await assertEntityAccess(user, data.entityType, data.entityId)
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { user: { select: { fullName: true } } },
    })

    if (data.isInternal && !isHR) {
      throw new AppError('Only HR can post internal notes', 403)
    }

    return activitiesRepository.createMessage({
      tenantId: user.tenantId,
      entityType: data.entityType,
      entityId: data.entityId,
      body: data.body,
      authorId: employeeId,
      authorName: employee?.user?.fullName || 'Unknown',
      messageType: data.messageType || 'comment',
      isInternal: data.isInternal || false,
    })
  },

  async listMessages(entityType: string, entityId: string, isHR: boolean, user: AccessUser) {
    await assertEntityAccess(user, entityType, entityId)
    return activitiesRepository.listMessages(user.tenantId, entityType, entityId, isHR)
  },

  async getDashboardSummary(employeeId: string, tenantId: string, roleIds: string[]) {
    const isHR = roleIds.some((r) => ['hr_admin', 'payroll_admin', 'system_admin'].includes(r))
    const isManager = roleIds.includes('manager') || isHR

    const today = await businessToday(tenantId)

    const [
      leaveBalances,
      pendingLeaveCount,
      todayAttendance,
      pendingActivities,
      teamSize,
      pendingRegularisations,
      myLeaveRequests,
    ] = await Promise.all([
      prisma.leaveBalance.findMany({
        where: { employeeId },
        include: { leaveType: { select: { name: true, code: true, isPaid: true } } },
      }),

      isManager
        ? prisma.leaveRequest.count({
            where: {
              status: 'pending',
              ...(isHR
                ? { employee: { tenantId } }
                : { employee: { managerId: employeeId } }),
            },
          })
        : 0,

      prisma.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId, date: today } },
      }),

      prisma.activity.count({
        where: { assignedToId: employeeId, status: { in: ['planned', 'overdue'] } },
      }),

      isManager
        ? prisma.employee.count({
            where: {
              active: true,
              ...(isHR ? { tenantId } : { managerId: employeeId }),
            },
          })
        : 0,

      isManager
        ? prisma.attendanceRegularisation.count({
            where: {
              status: 'pending',
              ...(isHR
                ? { employee: { tenantId } }
                : { employee: { managerId: employeeId } }),
            },
          })
        : 0,

      prisma.leaveRequest.findMany({
        where: { employeeId, status: { in: ['pending', 'approved'] } },
        include: { leaveType: { select: { name: true, code: true } } },
        orderBy: { appliedAt: 'desc' },
        take: 5,
      }),
    ])

    return {
      employee: {
        id: employeeId,
        leaveBalances: leaveBalances.map((b) => ({
          leaveType: b.leaveType.name,
          code: b.leaveType.code,
          isPaid: b.leaveType.isPaid,
          available: Math.max(0, b.balanceDays - b.usedDays - b.pendingDays),
          used: b.usedDays,
          pending: b.pendingDays,
          total: b.balanceDays,
        })),
        todayAttendance: {
          clockedIn: !!todayAttendance?.checkInTime,
          clockedOut: !!todayAttendance?.checkOutTime,
          status: todayAttendance?.status || 'not_started',
          workedHours: todayAttendance?.workedHours || 0,
          checkInTime: todayAttendance?.checkInTime || null,
          checkOutTime: todayAttendance?.checkOutTime || null,
        },
        pendingActivities,
        recentLeaveRequests: myLeaveRequests,
      },
      ...(isManager && {
        manager: {
          teamSize,
          pendingLeaveApprovals: pendingLeaveCount,
          pendingRegularisations,
        },
      }),
    }
  },
}

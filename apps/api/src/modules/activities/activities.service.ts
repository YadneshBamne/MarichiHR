import { activitiesRepository, logSystemChatter } from './activities.repository'
import { CreateActivityDto, CompleteActivityDto, CreateChatterMessageDto } from './activities.types'
import { AppError } from '../../shared/utils/AppError'
import { prisma } from '../../infrastructure/database/prisma'
import { businessToday } from '../../shared/utils/businessDate'
import { AccessUser, assertProfileAccess, assertCompensationAccess, getReportingSubtreeIds } from '../../shared/utils/access'
import { notify } from '../../infrastructure/notifications/notify'

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

const isHrUser = (u: AccessUser) => u.roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
// Where a task's "about" record lives in the app
const ABOUT_PATH: Record<string, (id: string) => string | null> = { employee: (id) => `/employees/${id}`, leave_request: () => '/leave', attendance_regularisation: () => '/attendance', contract: () => '/compensation', attendance_check: () => '/attendance' }

// Adds who made each task and what it is about, so the screen can say "From Dan · about Mary" and link to the record
async function describeTasks(user: AccessUser, rows: any[]) {
  const tenantId = user.tenantId
  const creators = [...new Set(rows.map((r) => r.createdBy).filter((c) => c && c !== 'system'))]
  const aboutIds = [...new Set(rows.filter((r) => r.entityType === 'employee').map((r) => r.entityId))]
  const [users, emps] = await Promise.all([
    creators.length ? prisma.user.findMany({ where: { id: { in: creators }, tenantId }, select: { id: true, fullName: true } }) : [],
    aboutIds.length ? prisma.employee.findMany({ where: { id: { in: aboutIds }, tenantId }, select: { id: true, firstName: true, lastName: true } }) : [],
  ])
  return rows.map((r) => ({
    ...r,
    canCancel: ['planned', 'overdue'].includes(r.status) && (r.createdBy === user.userId || (r.createdBy === 'system' && (r.assignedToId === user.employeeId || isHrUser(user)))),
    createdByName: r.createdBy === 'system' ? 'Automatic' : users.find((u) => u.id === r.createdBy)?.fullName ?? null,
    about: r.entityType && r.entityType !== 'general' ? { type: r.entityType, id: r.entityId, label: r.entityType === 'employee' ? (() => { const e = emps.find((x) => x.id === r.entityId); return e ? `${e.firstName} ${e.lastName}` : 'Employee' })() : String(r.entityType).replace(/_/g, ' '), path: ABOUT_PATH[r.entityType]?.(r.entityId) ?? null } : null,
  }))
}

export const activitiesService = {
  async types(tenantId: string) {
    return prisma.activityType.findMany({ where: { tenantId }, select: { id: true, name: true, icon: true }, orderBy: { name: 'asc' } })
  },

  // Everyone can make a task for themselves; a manager also for the people under them; HR for anyone. It may be about a record the
  // person can see (their own, their team's), and it always has a due date.
  async createActivity(user: AccessUser, data: CreateActivityDto) {
    const { tenantId } = user
    const activityType = await prisma.activityType.findFirst({ where: { id: data.activityTypeId, tenantId }, select: { id: true } })
    if (!activityType) throw new AppError('Activity type not found', 404)
    const assignee = await prisma.employee.findFirst({ where: { id: data.assignedToId, tenantId, active: true }, select: { id: true, userId: true } })
    if (!assignee) throw new AppError('Assignee not found', 404)
    if (!user.employeeId && !isHrUser(user)) throw new AppError('You need an employee record to make tasks', 403)
    if (assignee.id !== user.employeeId && !isHrUser(user)) {
      const team = user.roleIds.includes('manager') && user.employeeId ? await getReportingSubtreeIds(user.employeeId, tenantId) : []
      if (!team.includes(assignee.id)) throw new AppError('You can make tasks for yourself and the people who report to you', 403)
    }
    const due = new Date(data.dueDate)
    if (Number.isNaN(due.getTime())) throw new AppError('Choose a due date', 400)
    let entityType = data.entityType ?? 'general', entityId = data.entityId ?? assignee.id
    if (entityType !== 'general') {
      if (!['employee', 'leave_request', 'contract', 'attendance_regularisation'].includes(entityType)) throw new AppError('That kind of record cannot be linked', 400)
      const entity = await resolveEntity(entityType, entityId)
      if (!entity || entity.tenantId !== tenantId) throw new AppError('Related record not found', 404)
      await assertEntityAccess(user, entityType, entityId) // 404 when the person may not see that record
    } else entityId = assignee.id
    const created = await activitiesRepository.create(tenantId, user.userId, { ...data, entityType, entityId })
    if (assignee.id !== user.employeeId && assignee.userId) {
      try { await notify({ tenantId, userIds: [assignee.userId], type: 'task.assigned', title: `New task for you: ${data.title}`, body: `Due ${data.dueDate.slice(0, 10)}.${data.note ? ` ${data.note}` : ''}`, link: '/activities', entityType: 'activity', entityId: created.id }) } catch { /* best effort */ }
    }
    return created
  },

  async listForEntity(entityType: string, entityId: string, user: AccessUser) {
    await assertEntityAccess(user, entityType, entityId)
    return activitiesRepository.listForEntity(entityType, entityId, user.tenantId)
  },

  async listMyActivities(user: AccessUser, status?: string) {
    return describeTasks(user, await activitiesRepository.listMyActivities(user.employeeId!, status))
  },
  // Tasks I made for other people (so I can follow and cancel them)
  async listCreated(user: AccessUser, status?: string) {
    return describeTasks(user, await activitiesRepository.listCreated(user.tenantId, user.userId, user.employeeId ?? '', status))
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

  // The person who made a task can cancel it. A task the system made (an automatic follow-up) can be dismissed by whoever it is for, or HR.
  async cancelActivity(id: string, user: AccessUser) {
    const activity = await prisma.activity.findUnique({ where: { id } })
    if (!activity || activity.tenantId !== user.tenantId) throw new AppError('Activity not found', 404)
    const mine = activity.createdBy === user.userId
    const dismiss = activity.createdBy === 'system' && (activity.assignedToId === user.employeeId || isHrUser(user))
    if (!mine && !dismiss) throw new AppError(activity.createdBy === 'system' ? 'Only the person it is for, or HR, can dismiss this task' : 'Only the person who made this task can cancel it', 403)
    if (activity.status !== 'planned' && activity.status !== 'overdue') throw new AppError(`This task is already ${activity.status}`, 400)
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

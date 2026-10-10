import { leaveRepository } from './leave.repository'
import { ApplyLeaveDto, ApproveLeaveDto, RejectLeaveDto, LeaveAllocationRequestDto, ManualAllocationDto } from './leave.types'
import { AppError } from '../../shared/utils/AppError'
import { eventBus } from '../../infrastructure/events/eventBus'
import { prisma } from '../../infrastructure/database/prisma'
import { normaliseDateInput, businessToday } from '../../shared/utils/businessDate'

export const LEAVE_APPROVAL_SLA_HOURS = 24

// Explicit whitelist of configurable leave-type columns (never spread a request body into Prisma)
const LEAVE_TYPE_FIELDS = [
  'name', 'category', 'isPaid', 'isStatutory', 'statutoryCountry', 'accrualType', 'accrualAmount', 'accrualDayOfMonth',
  'carryForward', 'carryForwardMax', 'carryForwardExpiryMonths', 'allowNegative', 'encashable', 'halfDayAllowed',
  'hourlyAllowed', 'leaveUnit', 'approvalLevels', 'requiresHrForStatutory', 'attachmentRequiredAfterDays', 'sandwichRule',
] as const
function pickLeaveTypeFields(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const k of LEAVE_TYPE_FIELDS) if (body[k] !== undefined) out[k] = body[k]
  return out
}
import { AccessUser, assertCanApprove, assertProfileAccess } from '../../shared/utils/access'
import { consistent } from './leave.schema'
import { holidayMap, holidaysBetween, holidayTargetOf } from '../../shared/utils/holidays'

// Weekdays in the range minus the employee's (mandatory) public holidays
function computeWorkingDays(startDate: Date, endDate: Date, startHalf?: string, endHalf?: string, holidays: Map<string, string> = new Map()): number {
  let days = 0
  const current = new Date(startDate)

  while (current <= endDate) {
    const dow = current.getUTCDay()
    if (dow !== 0 && dow !== 6 && !holidays.has(current.toISOString().slice(0, 10))) {
      days++
    }
    current.setUTCDate(current.getUTCDate() + 1)
  }

  if (startHalf || endHalf) {
    if (startHalf && endHalf && startDate.getTime() === endDate.getTime()) {
      days = 0.5
    } else {
      if (startHalf) days -= 0.5
      if (endHalf) days -= 0.5
    }
  }

  return Math.max(0, days)
}

export const leaveService = {
  async listTypes(tenantId: string) {
    return leaveRepository.listTypes(tenantId)
  },

  // ─── Leave-type configuration (HR) ──────────────────────────
  async listAllTypes(tenantId: string) {
    return prisma.leaveType.findMany({ where: { tenantId }, orderBy: [{ active: 'desc' }, { name: 'asc' }] })
  },

  async createType(tenantId: string, userId: string, body: any) {
    const dup = await prisma.leaveType.findFirst({ where: { tenantId, code: body.code }, select: { id: true } })
    if (dup) throw new AppError(`Leave type code ${body.code} already exists`, 409)
    const created = await prisma.leaveType.create({ data: { ...pickLeaveTypeFields(body), code: body.code, name: body.name, category: body.category, tenantId } })
    await prisma.auditLog.create({ data: { tenantId, userId, action: 'LEAVE_TYPE_CREATED', entityType: 'leave_type', entityId: created.id, newValue: created as any } })
    return created
  },

  async updateType(tenantId: string, userId: string, id: string, body: any) {
    const existing = await prisma.leaveType.findFirst({ where: { id, tenantId } })
    if (!existing) throw new AppError('Leave type not found', 404)
    const data = pickLeaveTypeFields(body)
    if (!consistent({ ...existing, ...data } as any)) throw new AppError('Accruing leave types need an accrual amount above 0', 400)
    if (body.active !== undefined) Object.assign(data, { active: body.active, archivedAt: body.active ? null : new Date() })
    const updated = await prisma.leaveType.update({ where: { id: existing.id }, data })
    await prisma.auditLog.create({
      data: { tenantId, userId, action: body.active === false ? 'LEAVE_TYPE_ARCHIVED' : 'LEAVE_TYPE_UPDATED', entityType: 'leave_type', entityId: id, oldValue: existing as any, newValue: updated as any },
    })
    return updated
  },

  async getBalances(employeeId: string) {
    return leaveRepository.getBalances(employeeId)
  },

  async getEmployeeBalances(employeeId: string, user: AccessUser) {
    await assertProfileAccess(user, employeeId)
    return leaveRepository.getBalances(employeeId)
  },

  async applyLeave(employeeId: string, tenantId: string, data: ApplyLeaveDto) {
    const leaveType = await prisma.leaveType.findFirst({
      where: { id: data.leaveTypeId, tenantId, active: true },
    })
    if (!leaveType) throw new AppError('Leave type not found', 404)

    const startDate = normaliseDateInput(data.startDate)
    const endDate = normaliseDateInput(data.endDate)

    if (startDate > endDate) throw new AppError('Start date cannot be after end date', 400)

    const [holidayRows, target] = await Promise.all([holidaysBetween(tenantId, startDate, endDate), holidayTargetOf(employeeId)])
    const totalDays = computeWorkingDays(startDate, endDate, data.startHalf, data.endHalf, holidayMap(holidayRows, target))
    if (totalDays <= 0) throw new AppError('No working days in that range (weekends and public holidays do not count)', 400)

    const lwpDays = leaveType.isPaid ? 0 : totalDays

    if (leaveType.isPaid && !leaveType.allowNegative) {
      const balance = await leaveRepository.getBalance(employeeId, data.leaveTypeId)
      const available = balance ? balance.balanceDays - balance.usedDays - balance.pendingDays : 0
      if (available < totalDays) {
        throw new AppError(
          `Insufficient leave balance. Available: ${available} days, Requested: ${totalDays} days`,
          400
        )
      }
    }

    if (leaveType.attachmentRequiredAfterDays && totalDays > leaveType.attachmentRequiredAfterDays) {
      if (!data.attachmentUrl) {
        throw new AppError(
          `Attachment required for ${leaveType.name} leave exceeding ${leaveType.attachmentRequiredAfterDays} days`,
          400
        )
      }
    }

    const request = await leaveRepository.createRequest(employeeId, data, totalDays, lwpDays)

    await leaveRepository.updateBalance(employeeId, data.leaveTypeId, { pendingDays: totalDays })

    const slaDeadline = new Date(Date.now() + LEAVE_APPROVAL_SLA_HOURS * 3_600_000)

    await leaveRepository.createApproval(
      request.id,
      request.employee.manager?.id || employeeId,
      1,
      'pending',
      undefined,
      slaDeadline
    )

    await eventBus.publish(tenantId, 'leave.request.submitted', {
      leaveRequestId: request.id,
      employeeId,
      leaveTypeId: data.leaveTypeId,
      leaveTypeName: leaveType.name,
      totalDays,
      startDate: data.startDate,
      endDate: data.endDate,
      managerId: request.employee.manager?.id,
    })

    return request
  },

  async approveLeave(requestId: string, user: AccessUser, dto: ApproveLeaveDto) {
    const { tenantId } = user
    const request = await leaveRepository.findRequestById(requestId)
    if (!request || request.employee.tenantId !== tenantId) throw new AppError('Leave request not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can approve requests', 403)
    const approverId = user.employeeId
    await assertCanApprove(user, request.employeeId, tenantId, { entityType: 'leave_request', entityId: requestId })
    if (request.status !== 'pending') throw new AppError(`Leave request is already ${request.status}`, 400)

    await leaveRepository.updateRequestStatus(requestId, 'approved')
    await leaveRepository.createApproval(requestId, approverId, 1, 'approved', dto.comments)
    await prisma.auditLog.create({ data: { tenantId, userId: user.userId, action: 'LEAVE_APPROVED', entityType: 'leave_request', entityId: requestId, newValue: { employeeId: request.employeeId, leaveType: request.leaveType.name, days: request.totalDays, comments: dto.comments ?? null } } })

    await leaveRepository.updateBalance(request.employeeId, request.leaveTypeId, {
      pendingDays: -request.totalDays,
      usedDays: request.totalDays,
    })

    await eventBus.publish(tenantId, 'leave.request.approved', {
      leaveRequestId: requestId,
      employeeId: request.employeeId,
      approvedBy: approverId,
      leaveTypeName: request.leaveType.name,
      totalDays: request.totalDays,
      startDate: request.startDate,
      endDate: request.endDate,
    })

    return leaveRepository.findRequestById(requestId)
  },

  async rejectLeave(requestId: string, user: AccessUser, dto: RejectLeaveDto) {
    const { tenantId } = user
    const request = await leaveRepository.findRequestById(requestId)
    if (!request || request.employee.tenantId !== tenantId) throw new AppError('Leave request not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can reject requests', 403)
    const approverId = user.employeeId
    await assertCanApprove(user, request.employeeId, tenantId, { entityType: 'leave_request', entityId: requestId })
    if (request.status !== 'pending') throw new AppError(`Leave request is already ${request.status}`, 400)

    if (!dto.comments) throw new AppError('Rejection reason is required', 400)

    await leaveRepository.updateRequestStatus(requestId, 'rejected')
    await leaveRepository.createApproval(requestId, approverId, 1, 'rejected', dto.comments)
    await prisma.auditLog.create({ data: { tenantId, userId: user.userId, action: 'LEAVE_REJECTED', entityType: 'leave_request', entityId: requestId, newValue: { employeeId: request.employeeId, leaveType: request.leaveType.name, days: request.totalDays, reason: dto.comments } } })

    await leaveRepository.updateBalance(request.employeeId, request.leaveTypeId, {
      pendingDays: -request.totalDays,
    })

    await eventBus.publish(tenantId, 'leave.request.rejected', {
      leaveRequestId: requestId,
      employeeId: request.employeeId,
      rejectedBy: approverId,
      reason: dto.comments,
    })

    return leaveRepository.findRequestById(requestId)
  },

  async cancelLeave(requestId: string, employeeId: string, tenantId: string) {
    const request = await leaveRepository.findRequestById(requestId)
    if (!request) throw new AppError('Leave request not found', 404)
    if (request.employeeId !== employeeId) throw new AppError('Access denied', 403)
    if (!['pending', 'approved'].includes(request.status)) {
      throw new AppError(`Cannot cancel a ${request.status} leave request`, 400)
    }

    const prevStatus = request.status
    await leaveRepository.updateRequestStatus(requestId, 'cancelled')

    if (prevStatus === 'pending') {
      await leaveRepository.updateBalance(request.employeeId, request.leaveTypeId, {
        pendingDays: -request.totalDays,
      })
    } else if (prevStatus === 'approved') {
      await leaveRepository.updateBalance(request.employeeId, request.leaveTypeId, {
        usedDays: -request.totalDays,
      })
    }

    return leaveRepository.findRequestById(requestId)
  },

  async listMyRequests(employeeId: string, query: any) {
    return leaveRepository.listRequests(employeeId, {
      status: query.status,
      page: parseInt(query.page) || 1,
      limit: parseInt(query.limit) || 25,
    })
  },

  async listPendingApprovals(approverId: string, tenantId: string, isHR: boolean) {
    if (isHR) {
      return leaveRepository.listPendingForHR(tenantId)
    }
    return leaveRepository.listPendingForManager(approverId)
  },

  async getTeamCalendar(managerId: string, startDate: string, endDate: string) {
    return leaveRepository.getTeamLeaveCalendar(
      managerId,
      normaliseDateInput(startDate),
      normaliseDateInput(endDate)
    )
  },

  async requestAllocation(employeeId: string, tenantId: string, data: LeaveAllocationRequestDto) {
    const leaveType = await prisma.leaveType.findFirst({ where: { id: data.leaveTypeId, tenantId, active: true }, select: { id: true } })
    if (!leaveType) throw new AppError('Leave type not found', 404)
    return leaveRepository.createAllocationRequest(employeeId, data)
  },

  async approveAllocationRequest(id: string, user: AccessUser, approvedDays: number, note?: string) {
    const { tenantId } = user
    const request = await leaveRepository.findAllocationRequestById(id)
    if (!request || request.employee.tenantId !== tenantId) throw new AppError('Allocation request not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can approve requests', 403)
    const approverId = user.employeeId
    await assertCanApprove(user, request.employeeId, tenantId, { entityType: 'leave_allocation_request', entityId: id })
    if (request.status !== 'pending') throw new AppError('Request already processed', 400)
    if (typeof approvedDays !== 'number' || !Number.isFinite(approvedDays) || approvedDays <= 0) {
      throw new AppError('Approved days must be a positive number', 400)
    }

    await leaveRepository.approveAllocationRequest(id, approverId, approvedDays, note)

    await leaveRepository.createAllocation({
      employeeId: request.employeeId,
      leaveTypeId: request.leaveTypeId,
      daysAllocated: approvedDays,
      validFrom: new Date().toISOString(),
      reason: `Allocation request approved: ${request.reason}`,
    }, approverId)

    await leaveRepository.updateBalance(request.employeeId, request.leaveTypeId, {
      balanceDays: approvedDays,
    })

    return leaveRepository.findAllocationRequestById(id)
  },

  async rejectAllocationRequest(id: string, user: AccessUser, note: string) {
    const { tenantId } = user
    const request = await leaveRepository.findAllocationRequestById(id)
    if (!request || request.employee.tenantId !== tenantId) throw new AppError('Allocation request not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can reject requests', 403)
    const approverId = user.employeeId
    await assertCanApprove(user, request.employeeId, tenantId, { entityType: 'leave_allocation_request', entityId: id })
    if (request.status !== 'pending') throw new AppError('Request already processed', 400)

    return leaveRepository.rejectAllocationRequest(id, approverId, note)
  },

  async manualAllocation(tenantId: string, data: ManualAllocationDto, approvedBy: string) {
    const employee = await prisma.employee.findFirst({ where: { id: data.employeeId, tenantId }, select: { id: true } })
    if (!employee) throw new AppError('Employee not found', 404)
    const leaveType = await prisma.leaveType.findFirst({ where: { id: data.leaveTypeId, tenantId }, select: { id: true } })
    if (!leaveType) throw new AppError('Leave type not found', 404)

    const allocation = await leaveRepository.createAllocation(data, approvedBy)
    await leaveRepository.updateBalance(data.employeeId, data.leaveTypeId, {
      balanceDays: data.daysAllocated,
    })
    return allocation
  },

  async listAllocations(employeeId: string, user: AccessUser) {
    await assertProfileAccess(user, employeeId)
    return leaveRepository.listAllocations(employeeId)
  },

  // Monthly accrual, safe to re-run: one 'accrual' allocation per employee, leave type and tenant-local month
  async runMonthlyAccrual(tenantId: string) {
    const today = await businessToday(tenantId)
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
    const nextMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))
    const monthLabel = monthStart.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    let credited = 0

    const leaveTypes = await prisma.leaveType.findMany({
      where: { tenantId, active: true, accrualType: 'monthly_prorate' },
    })

    const employees = await prisma.employee.findMany({
      where: { tenantId, active: true, employmentStatus: { not: 'terminated' }, hireDate: { lte: today } },
    })

    for (const employee of employees) {
      for (const leaveType of leaveTypes) {
        if (!leaveType.accrualAmount) continue

        const already = await prisma.leaveAllocation.findFirst({
          where: { employeeId: employee.id, leaveTypeId: leaveType.id, allocationType: 'accrual', validFrom: { gte: monthStart, lt: nextMonthStart } },
          select: { id: true },
        })
        if (already) continue

        await prisma.leaveAllocation.create({
          data: {
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            allocationType: 'accrual',
            daysAllocated: leaveType.accrualAmount,
            validFrom: monthStart,
            reason: `Monthly accrual — ${monthLabel}`,
            approvedBy: 'system',
            status: 'approved',
          },
        })

        await leaveRepository.updateBalance(employee.id, leaveType.id, {
          balanceDays: leaveType.accrualAmount,
        })

        credited++
      }
    }

    console.log(`Leave accrual: ${credited} balance entries credited for tenant ${tenantId} (${monthLabel})`)
    return credited
  },

  // Hourly job: a pending level-1 approval past its deadline is escalated once to HR and the skip-level manager
  async runSlaEscalation(tenantId: string) {
    const overdue = await prisma.leaveApproval.findMany({
      where: {
        action: 'pending', escalatedAt: null, deadlineAt: { lt: new Date() },
        leaveRequest: { status: 'pending', employee: { tenantId } },
      },
      include: {
        leaveRequest: {
          include: { employee: { select: { id: true, firstName: true, lastName: true, manager: { select: { managerId: true } } } } },
        },
      },
    })
    for (const a of overdue) {
      const claimed = await prisma.leaveApproval.updateMany({ where: { id: a.id, escalatedAt: null }, data: { escalatedAt: new Date() } })
      if (!claimed.count) continue
      const emp = a.leaveRequest.employee
      await eventBus.publish(tenantId, 'leave.approval.escalated', {
        leaveRequestId: a.leaveRequestId,
        employeeId: emp.id,
        employeeName: `${emp.firstName} ${emp.lastName}`,
        approverId: a.approverId,
        skipLevelManagerId: emp.manager?.managerId ?? null,
        slaHours: LEAVE_APPROVAL_SLA_HOURS,
      })
    }
    return overdue.length
  },
}

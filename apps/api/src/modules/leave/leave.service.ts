import { leaveRepository } from './leave.repository'
import { ApplyLeaveDto, ApproveLeaveDto, RejectLeaveDto, LeaveAllocationRequestDto, ManualAllocationDto } from './leave.types'
import { AppError } from '../../shared/utils/AppError'
import { eventBus } from '../../infrastructure/events/eventBus'
import { prisma } from '../../infrastructure/database/prisma'
import { normaliseDateInput } from '../../shared/utils/businessDate'
import { AccessUser, assertCanApprove, assertProfileAccess } from '../../shared/utils/access'

function computeWorkingDays(startDate: Date, endDate: Date, startHalf?: string, endHalf?: string): number {
  let days = 0
  const current = new Date(startDate)

  while (current <= endDate) {
    const dow = current.getUTCDay()
    if (dow !== 0 && dow !== 6) {
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

    const totalDays = computeWorkingDays(startDate, endDate, data.startHalf, data.endHalf)
    if (totalDays <= 0) throw new AppError('Invalid date range — no working days', 400)

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

    const slaDeadline = new Date()
    slaDeadline.setHours(slaDeadline.getHours() + 24)

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

  async runMonthlyAccrual(tenantId: string) {
    const now = new Date()
    let credited = 0

    const leaveTypes = await prisma.leaveType.findMany({
      where: { tenantId, active: true, accrualType: 'monthly_prorate' },
    })

    const employees = await prisma.employee.findMany({
      where: { tenantId, active: true, employmentStatus: { not: 'terminated' } },
    })

    for (const employee of employees) {
      for (const leaveType of leaveTypes) {
        if (!leaveType.accrualAmount) continue

        const monthsWorked = Math.floor(
          (now.getTime() - new Date(employee.hireDate).getTime()) / (1000 * 60 * 60 * 24 * 30)
        )

        if (monthsWorked < 0) continue

        const daysToCredit = leaveType.accrualAmount

        await prisma.leaveAllocation.create({
          data: {
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            allocationType: 'accrual',
            daysAllocated: daysToCredit,
            validFrom: now,
            reason: `Monthly accrual — ${now.toLocaleString('default', { month: 'long', year: 'numeric' })}`,
            approvedBy: 'system',
            status: 'approved',
          },
        })

        await leaveRepository.updateBalance(employee.id, leaveType.id, {
          balanceDays: daysToCredit,
        })

        credited++
      }
    }

    console.log(`Leave accrual cron: ${credited} balance entries credited for tenant ${tenantId}`)
    return credited
  },
}

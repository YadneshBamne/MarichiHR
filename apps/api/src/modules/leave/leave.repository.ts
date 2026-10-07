import { prisma } from '../../infrastructure/database/prisma'
import { ApplyLeaveDto, ManualAllocationDto } from './leave.types'
import { normaliseDateInput } from '../../shared/utils/businessDate'

export const leaveRepository = {
  async listTypes(tenantId: string) {
    return prisma.leaveType.findMany({
      where: { tenantId, active: true },
      orderBy: { name: 'asc' },
    })
  },

  async getBalances(employeeId: string) {
    return prisma.leaveBalance.findMany({
      where: { employeeId },
      include: { leaveType: true },
    })
  },

  async getBalance(employeeId: string, leaveTypeId: string) {
    return prisma.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId: { employeeId, leaveTypeId } },
    })
  },

  async updateBalance(employeeId: string, leaveTypeId: string, delta: {
    balanceDays?: number
    usedDays?: number
    pendingDays?: number
  }) {
    const balance = await prisma.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId: { employeeId, leaveTypeId } },
    })

    if (!balance) {
      return prisma.leaveBalance.create({
        data: {
          employeeId,
          leaveTypeId,
          balanceDays: delta.balanceDays ?? 0,
          usedDays: delta.usedDays ?? 0,
          pendingDays: delta.pendingDays ?? 0,
          asOfDate: new Date(),
        },
      })
    }

    return prisma.leaveBalance.update({
      where: { employeeId_leaveTypeId: { employeeId, leaveTypeId } },
      data: {
        ...(delta.balanceDays !== undefined && { balanceDays: { increment: delta.balanceDays } }),
        ...(delta.usedDays !== undefined && { usedDays: { increment: delta.usedDays } }),
        ...(delta.pendingDays !== undefined && { pendingDays: { increment: delta.pendingDays } }),
        asOfDate: new Date(),
      },
    })
  },

  async createRequest(employeeId: string, data: ApplyLeaveDto, totalDays: number, lwpDays: number) {
    return prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.leaveTypeId,
        startDate: normaliseDateInput(data.startDate),
        endDate: normaliseDateInput(data.endDate),
        startHalf: data.startHalf,
        endHalf: data.endHalf,
        totalDays,
        lwpDays,
        reason: data.reason,
        attachmentUrl: data.attachmentUrl,
        status: 'pending',
        appliedAt: new Date(),
      },
      include: {
        leaveType: true,
        employee: { include: { manager: { include: { user: { select: { fullName: true } } } } } },
      },
    })
  },

  async findRequestById(id: string) {
    return prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        leaveType: true,
        employee: {
          include: {
            manager: { select: { id: true, workEmail: true, user: { select: { fullName: true } } } },
            user: { select: { fullName: true } },
          },
        },
        approvals: { orderBy: { createdAt: 'asc' } },
      },
    })
  },

  async listRequests(employeeId: string, options?: { status?: string; page?: number; limit?: number }) {
    const page = options?.page ?? 1
    const limit = options?.limit ?? 25
    const skip = (page - 1) * limit

    const where: any = { employeeId, ...(options?.status && { status: options.status }) }

    const [requests, total] = await Promise.all([
      prisma.leaveRequest.findMany({
        where,
        include: { leaveType: true, approvals: { orderBy: { createdAt: 'desc' }, take: 1 } },
        orderBy: { appliedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.leaveRequest.count({ where }),
    ])

    return { requests, total, page, limit }
  },

  async listPendingForManager(managerId: string) {
    return prisma.leaveRequest.findMany({
      where: {
        status: 'pending',
        employee: { managerId },
      },
      include: {
        leaveType: true,
        employee: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
        approvals: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { appliedAt: 'asc' },
    })
  },

  async listPendingForHR(tenantId: string) {
    return prisma.leaveRequest.findMany({
      where: {
        status: 'pending',
        employee: { tenantId },
      },
      include: {
        leaveType: true,
        employee: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
        approvals: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { appliedAt: 'asc' },
    })
  },

  async updateRequestStatus(id: string, status: string, lwpDays?: number) {
    return prisma.leaveRequest.update({
      where: { id },
      data: {
        status,
        ...(lwpDays !== undefined && { lwpDays }),
        ...(status === 'cancelled' && { cancelledAt: new Date() }),
      },
    })
  },

  async createApproval(leaveRequestId: string, approverId: string, level: number, action: string, comments?: string, deadlineAt?: Date) {
    return prisma.leaveApproval.create({
      data: {
        leaveRequestId,
        approverId,
        approvalLevel: level,
        action,
        comments,
        actionedAt: action !== 'pending' ? new Date() : undefined,
        deadlineAt,
      },
    })
  },

  async createAllocationRequest(employeeId: string, data: any) {
    return prisma.leaveAllocationRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.leaveTypeId,
        requestedDays: data.requestedDays,
        reason: data.reason,
        supportingRefType: data.supportingRefType,
        supportingRefId: data.supportingRefId,
        status: 'pending',
      },
      include: { leaveType: true },
    })
  },

  async findAllocationRequestById(id: string) {
    return prisma.leaveAllocationRequest.findUnique({
      where: { id },
      include: {
        leaveType: true,
        employee: { include: { manager: { select: { id: true } } } },
      },
    })
  },

  async approveAllocationRequest(id: string, approverId: string, approvedDays: number, note?: string) {
    return prisma.leaveAllocationRequest.update({
      where: { id },
      data: {
        status: 'approved',
        approverId,
        approvedDays,
        approvalNote: note,
        actionedAt: new Date(),
      },
    })
  },

  async rejectAllocationRequest(id: string, approverId: string, note: string) {
    return prisma.leaveAllocationRequest.update({
      where: { id },
      data: { status: 'rejected', approverId, approvalNote: note, actionedAt: new Date() },
    })
  },

  async createAllocation(data: ManualAllocationDto, approvedBy: string) {
    return prisma.leaveAllocation.create({
      data: {
        employeeId: data.employeeId,
        leaveTypeId: data.leaveTypeId,
        allocationType: 'manual',
        daysAllocated: data.daysAllocated,
        validFrom: normaliseDateInput(data.validFrom),
        validUntil: data.validUntil ? normaliseDateInput(data.validUntil) : undefined,
        reason: data.reason,
        approvedBy,
        status: 'approved',
      },
    })
  },

  async listAllocations(employeeId: string) {
    return prisma.leaveAllocation.findMany({
      where: { employeeId },
      include: { leaveType: true },
      orderBy: { createdAt: 'desc' },
    })
  },

  async getTeamLeaveCalendar(managerId: string, startDate: Date, endDate: Date) {
    return prisma.leaveRequest.findMany({
      where: {
        status: 'approved',
        employee: { managerId },
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
      include: {
        leaveType: { select: { name: true, code: true } },
        employee: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
      },
      orderBy: { startDate: 'asc' },
    })
  },
}

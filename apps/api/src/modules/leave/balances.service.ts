import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'

// HR's view of one person's leave: every active type with balance, used, pending and available, the credit history,
// and manual adjustments (add or remove days with a reason; audited; the person is told).
const round = (n: number) => Math.round(n * 100) / 100

export const balancesService = {
  async forEmployee(user: AccessUser, employeeId: string) {
    const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: user.tenantId }, select: { id: true } })
    if (!emp) throw new AppError('Employee not found', 404)
    const [types, balances, history] = await Promise.all([
      prisma.leaveType.findMany({ where: { tenantId: user.tenantId, active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, code: true, accrualType: true, accrualAmount: true } }),
      prisma.leaveBalance.findMany({ where: { employeeId } }),
      prisma.leaveAllocation.findMany({ where: { employeeId, leaveType: { tenantId: user.tenantId } }, orderBy: { createdAt: 'desc' }, take: 30, include: { leaveType: { select: { name: true } } } }),
    ])
    const by = new Map(balances.map((b) => [b.leaveTypeId, b]))
    return {
      balances: types.map((t) => {
        const b = by.get(t.id)
        const [bal, used, pending] = [b?.balanceDays ?? 0, b?.usedDays ?? 0, b?.pendingDays ?? 0]
        return { leaveTypeId: t.id, leaveType: t.name, code: t.code, creditMethod: t.accrualType ?? 'manual', creditAmount: t.accrualAmount, balance: round(bal), used: round(used), pending: round(pending), available: round(bal - used - pending) }
      }),
      history: history.map((h) => ({ id: h.id, leaveType: h.leaveType.name, type: h.allocationType, days: h.daysAllocated, reason: h.reason, at: h.createdAt, by: h.approvedBy === 'system' ? 'System' : h.approvedBy })),
    }
  },

  async adjust(user: AccessUser, employeeId: string, body: { leaveTypeId: string; days: number; reason: string; allowNegative?: boolean }) {
    const [emp, type] = await Promise.all([
      prisma.employee.findFirst({ where: { id: employeeId, tenantId: user.tenantId }, select: { id: true, firstName: true, lastName: true } }),
      prisma.leaveType.findFirst({ where: { id: body.leaveTypeId, tenantId: user.tenantId, active: true }, select: { id: true, name: true } }),
    ])
    if (!emp) throw new AppError('Employee not found', 404)
    if (!type) throw new AppError('Leave type not found', 404)
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'leave-credit:' + user.tenantId}))`
      const b = await tx.leaveBalance.findUnique({ where: { employeeId_leaveTypeId: { employeeId, leaveTypeId: type.id } } })
      const after = round((b?.balanceDays ?? 0) + body.days - (b?.usedDays ?? 0) - (b?.pendingDays ?? 0))
      if (after < 0 && !body.allowNegative) throw new AppError(`This would leave ${after} days of ${type.name} available. Confirm to allow a negative balance.`, 409)
      const allocation = await tx.leaveAllocation.create({ data: { employeeId, leaveTypeId: type.id, allocationType: 'adjustment', daysAllocated: body.days, validFrom: new Date(), reason: body.reason, approvedBy: user.userId, status: 'approved' } })
      await tx.leaveBalance.upsert({
        where: { employeeId_leaveTypeId: { employeeId, leaveTypeId: type.id } },
        create: { employeeId, leaveTypeId: type.id, balanceDays: body.days, asOfDate: new Date() },
        update: { balanceDays: { increment: body.days }, asOfDate: new Date() },
      })
      return { allocationId: allocation.id, available: after }
    })
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action: 'LEAVE_BALANCE_ADJUSTED', entityType: 'employee', entityId: employeeId, newValue: { leaveType: type.name, days: body.days, reason: body.reason, availableAfter: result.available } } })
    const userId = await userIdOfEmployee(user.tenantId, employeeId)
    if (userId) await notify({ tenantId: user.tenantId, userIds: [userId], type: 'leave.balance.adjusted', title: `${type.name}: ${body.days > 0 ? '+' : ''}${body.days} day${Math.abs(body.days) === 1 ? '' : 's'}`, body: `HR adjusted your balance: ${body.reason}. Available now: ${result.available}.`, link: '/leave', eventId: `adjust:${result.allocationId}` })
    return result
  },

  // Allocation requests waiting for this person: HR sees everyone's, a manager their direct reports'
  async pendingRequests(user: AccessUser) {
    const hr = user.roleIds.includes('hr_admin')
    if (!hr && !user.employeeId) return []
    const rows = await prisma.leaveAllocationRequest.findMany({
      where: { status: 'pending', employee: { tenantId: user.tenantId, active: true, ...(hr ? {} : { managerId: user.employeeId }) }, ...(user.employeeId && { NOT: { employeeId: user.employeeId } }) },
      include: { leaveType: { select: { name: true } }, employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map((r) => ({ id: r.id, employeeId: r.employee.id, employee: `${r.employee.firstName} ${r.employee.lastName}`, employeeCode: r.employee.employeeCode, leaveType: r.leaveType.name, requestedDays: r.requestedDays, reason: r.reason, createdAt: r.createdAt }))
  },
}

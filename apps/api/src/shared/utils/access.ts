import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from './AppError'
import { logSystemChatter } from '../../modules/activities/activities.repository'

// roleIds are role NAMES (e.g. 'hr_admin'), as carried in the JWT
export interface AccessUser {
  userId: string
  tenantId: string
  employeeId?: string
  roleIds: string[]
}

const MAX_CHAIN_DEPTH = 10

const hasRole = (user: AccessUser, ...roles: string[]) => roles.some((r) => user.roleIds.includes(r))
const isSelf = (user: AccessUser, targetEmployeeId: string) => !!user.employeeId && user.employeeId === targetEmployeeId

async function findEmployee(id: string) {
  return prisma.employee.findUnique({ where: { id }, select: { id: true, tenantId: true, managerId: true } })
}

// Is `managerEmployeeId` anywhere above `targetEmployeeId` in the reporting chain (direct or indirect)?
export async function isReportingChainOf(managerEmployeeId: string, targetEmployeeId: string): Promise<boolean> {
  const seen = new Set<string>()
  let current = targetEmployeeId
  for (let level = 0; level < MAX_CHAIN_DEPTH; level++) {
    if (seen.has(current)) return false
    seen.add(current)
    const employee = await findEmployee(current)
    if (!employee?.managerId) return false
    if (employee.managerId === managerEmployeeId) return true
    current = employee.managerId
  }
  return false
}

// Every employee below `managerEmployeeId` (direct and indirect), walking downward level by level
export async function getReportingSubtreeIds(managerEmployeeId: string, tenantId: string): Promise<string[]> {
  const found = new Set<string>()
  let frontier = [managerEmployeeId]
  for (let level = 0; level < MAX_CHAIN_DEPTH && frontier.length > 0; level++) {
    const reports = await prisma.employee.findMany({
      where: { tenantId, managerId: { in: frontier }, active: true },
      select: { id: true },
    })
    frontier = reports.map((r) => r.id).filter((id) => !found.has(id) && id !== managerEmployeeId)
    frontier.forEach((id) => found.add(id))
  }
  return Array.from(found)
}

async function targetInTenant(user: AccessUser, targetEmployeeId: string) {
  const target = await findEmployee(targetEmployeeId)
  return target && target.tenantId === user.tenantId ? target : null
}

// Self, hr_admin, or anyone above the target in the reporting chain
export async function canAccessProfile(user: AccessUser, targetEmployeeId: string): Promise<boolean> {
  if (!(await targetInTenant(user, targetEmployeeId))) return false
  if (isSelf(user, targetEmployeeId) || hasRole(user, 'hr_admin')) return true
  return user.employeeId ? isReportingChainOf(user.employeeId, targetEmployeeId) : false
}

// Self, hr_admin, payroll_admin, compliance_officer. Managers do NOT get compensation access.
export async function canAccessCompensation(user: AccessUser, targetEmployeeId: string): Promise<boolean> {
  if (!(await targetInTenant(user, targetEmployeeId))) return false
  return isSelf(user, targetEmployeeId) || hasRole(user, 'hr_admin', 'payroll_admin', 'compliance_officer')
}

// Self, hr_admin, payroll_admin
export async function canSeeBankLast4(user: AccessUser, targetEmployeeId: string): Promise<boolean> {
  if (!(await targetInTenant(user, targetEmployeeId))) return false
  return isSelf(user, targetEmployeeId) || hasRole(user, 'hr_admin', 'payroll_admin')
}

export async function assertProfileAccess(user: AccessUser, targetEmployeeId: string) {
  if (!(await canAccessProfile(user, targetEmployeeId))) throw new AppError('Not found', 404)
}

export async function assertCompensationAccess(user: AccessUser, targetEmployeeId: string) {
  if (!(await canAccessCompensation(user, targetEmployeeId))) throw new AppError('Not found', 404)
}

// Approval authority: the owner's direct manager, or hr_admin. Never the owner — except an hr_admin whose own
// record has no manager (top of the chain), which is logged. `entity` identifies the request for that log.
export async function assertCanApprove(
  user: AccessUser,
  requestEmployeeId: string,
  tenantId: string,
  entity?: { entityType: string; entityId: string }
) {
  const owner = await findEmployee(requestEmployeeId)
  if (!owner || owner.tenantId !== tenantId || user.tenantId !== tenantId) {
    throw new AppError('You are not allowed to approve this request', 403)
  }

  const isHR = hasRole(user, 'hr_admin')

  if (isSelf(user, requestEmployeeId)) {
    if (!owner.managerId && isHR) {
      const target = entity ?? { entityType: 'employee', entityId: requestEmployeeId }
      await logSystemChatter(tenantId, target.entityType, target.entityId, 'Self-approved: no manager on record')
      await prisma.auditLog.create({
        data: { tenantId, userId: user.userId, action: 'SELF_APPROVAL', entityType: target.entityType, entityId: target.entityId },
      })
      return
    }
    throw new AppError('You cannot approve your own request', 403)
  }

  const isDirectManager = !!user.employeeId && owner.managerId === user.employeeId
  if (!isDirectManager && !isHR) {
    throw new AppError('Only the requester\'s manager or HR can approve this request', 403)
  }
}

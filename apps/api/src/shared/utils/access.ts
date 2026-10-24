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

// ─── HR Business Partner scope ──────────────────────────────────────────────────────────────────────────────
// An HR admin can be limited to some departments (users.hrScopeUnitIds) and every unit below them. null = the whole
// company (also for System admins). Cached a minute per person; cleared when their access changes.
// ponytail: per-process cache; with several API instances a scope change can take up to a minute to apply everywhere
const scopeCache = new Map<string, { at: number; units: Set<string> | null }>()
export const clearHrScope = (userId: string) => scopeCache.delete(userId)
export async function hrScope(user: AccessUser): Promise<Set<string> | null> {
  if (!hasRole(user, 'hr_admin') || hasRole(user, 'system_admin')) return null
  const hit = scopeCache.get(user.userId)
  if (hit && Date.now() - hit.at < 60_000) return hit.units
  const u = await prisma.user.findUnique({ where: { id: user.userId }, select: { hrScopeUnitIds: true } })
  let units: Set<string> | null = null
  if (u?.hrScopeUnitIds?.length) {
    const all = await prisma.orgUnit.findMany({ where: { tenantId: user.tenantId }, select: { id: true, parentId: true } })
    units = new Set(u.hrScopeUnitIds)
    for (let grew = true; grew;) { grew = false; for (const x of all) if (x.parentId && units.has(x.parentId) && !units.has(x.id)) { units.add(x.id); grew = true } }
  }
  scopeCache.set(user.userId, { at: Date.now(), units })
  return units
}
export async function inHrScope(user: AccessUser, employeeId: string) {
  const units = await hrScope(user)
  if (!units) return true
  const e = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: user.tenantId }, select: { orgUnitId: true } })
  return !!e && units.has(e.orgUnitId)
}

// HR admins who look after this person: everyone without a scope, plus Business Partners whose departments include
// them. Falls back to every HR admin so a request is never stuck.
export async function hrAdminsFor(tenantId: string, employeeId: string): Promise<string[]> {
  const [hrs, emp] = await Promise.all([
    prisma.user.findMany({ where: { tenantId, active: true, userRoles: { some: { role: { name: 'hr_admin' } } } }, select: { id: true, hrScopeUnitIds: true, userRoles: { select: { role: { select: { name: true } } } } } }),
    prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { orgUnitId: true } }),
  ])
  const out: string[] = []
  for (const h of hrs) {
    const roles = h.userRoles.map((r) => r.role.name)
    if (!h.hrScopeUnitIds?.length || roles.includes('system_admin')) { out.push(h.id); continue }
    const units = await hrScope({ userId: h.id, tenantId, roleIds: roles })
    if (emp && units?.has(emp.orgUnitId)) out.push(h.id)
  }
  return out.length ? out : hrs.map((h) => h.id)
}

async function targetInTenant(user: AccessUser, targetEmployeeId: string) {
  const target = await findEmployee(targetEmployeeId)
  return target && target.tenantId === user.tenantId ? target : null
}

// Self, hr_admin, system_admin (manages logins and roles; pay and bank stay hidden), payroll_admin (keeps contracts and
// pay), or anyone above the target in the reporting chain
export async function canAccessProfile(user: AccessUser, targetEmployeeId: string): Promise<boolean> {
  if (!(await targetInTenant(user, targetEmployeeId))) return false
  if (isSelf(user, targetEmployeeId) || hasRole(user, 'system_admin', 'payroll_admin')) return true
  if (hasRole(user, 'hr_admin') && (await inHrScope(user, targetEmployeeId))) return true
  return user.employeeId ? isReportingChainOf(user.employeeId, targetEmployeeId) : false
}

// Self, payroll_admin, compliance_officer. Neither managers nor HR admins see pay.
export async function canAccessCompensation(user: AccessUser, targetEmployeeId: string): Promise<boolean> {
  if (!(await targetInTenant(user, targetEmployeeId))) return false
  return isSelf(user, targetEmployeeId) || hasRole(user, 'payroll_admin', 'compliance_officer')
}

// Self, hr_admin, payroll_admin
export async function canSeeBankLast4(user: AccessUser, targetEmployeeId: string): Promise<boolean> {
  if (!(await targetInTenant(user, targetEmployeeId))) return false
  return isSelf(user, targetEmployeeId) || hasRole(user, 'payroll_admin') || (hasRole(user, 'hr_admin') && (await inHrScope(user, targetEmployeeId)))
}

export async function assertProfileAccess(user: AccessUser, targetEmployeeId: string) {
  if (!(await canAccessProfile(user, targetEmployeeId))) throw new AppError('Not found', 404)
}

export async function assertCompensationAccess(user: AccessUser, targetEmployeeId: string) {
  if (!(await canAccessCompensation(user, targetEmployeeId))) throw new AppError('Not found', 404)
}

// Approval authority: the owner's manager (direct, or a manager higher up the same reporting line: skip-level), or
// hr_admin. Never the owner — except an hr_admin whose own
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

  // An HR Business Partner approves only inside their departments
  const isHR = hasRole(user, 'hr_admin') && (await inHrScope(user, requestEmployeeId))

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
  if (isDirectManager || isHR) return
  const isSkipLevel = !!user.employeeId && hasRole(user, 'manager') && (await isReportingChainOf(user.employeeId, requestEmployeeId))
  if (!isSkipLevel) throw new AppError('Only the requester\'s managers or HR can approve this request', 403)
}

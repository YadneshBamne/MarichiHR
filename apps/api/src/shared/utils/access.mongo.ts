import { AppError } from './AppError'
import { AccessUser } from './access'
import { User, Employee, OrgUnit, AuditLog } from '../../infrastructure/mongo/mongo'

// MongoDB version of access.ts: same rules, same exports (the roles table is replaced by role names embedded in users).
// ponytail: assertCanApprove skips the chatter line the Postgres version writes on a self-approval (activities module not ported yet); the audit row is still written.

const MAX_CHAIN_DEPTH = 10
const hasRole = (user: AccessUser, ...roles: string[]) => roles.some((r) => user.roleIds.includes(r))
const isSelf = (user: AccessUser, targetEmployeeId: string) => !!user.employeeId && user.employeeId === targetEmployeeId

const findEmployee = async (id: string) => (await Employee.findById(id).select('tenantId managerId').lean()) as any as { _id: string; tenantId: string; managerId?: string } | null

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

export async function getReportingSubtreeIds(managerEmployeeId: string, tenantId: string): Promise<string[]> {
  const found = new Set<string>()
  let frontier = [managerEmployeeId]
  for (let level = 0; level < MAX_CHAIN_DEPTH && frontier.length > 0; level++) {
    const reports: any[] = await Employee.find({ tenantId, managerId: { $in: frontier }, active: true }).select('_id').lean()
    frontier = reports.map((r) => r._id as string).filter((id) => !found.has(id) && id !== managerEmployeeId)
    frontier.forEach((id) => found.add(id))
  }
  return Array.from(found)
}

// HR Business Partner scope: null = the whole company. Cached a minute per person; cleared when their access changes.
// ponytail: per-process cache; with several API instances a scope change can take up to a minute to apply everywhere
const scopeCache = new Map<string, { at: number; units: Set<string> | null }>()
export const clearHrScope = (userId: string) => scopeCache.delete(userId)
export async function hrScope(user: AccessUser): Promise<Set<string> | null> {
  if (!hasRole(user, 'hr_admin') || hasRole(user, 'system_admin')) return null
  const hit = scopeCache.get(user.userId)
  if (hit && Date.now() - hit.at < 60_000) return hit.units
  const u: any = await User.findById(user.userId).select('hrScopeUnitIds').lean()
  let units: Set<string> | null = null
  if (u?.hrScopeUnitIds?.length) {
    const all: any[] = await OrgUnit.find({ tenantId: user.tenantId }).select('parentId').lean()
    units = new Set<string>(u.hrScopeUnitIds)
    for (let grew = true; grew;) { grew = false; for (const x of all) if (x.parentId && units.has(x.parentId) && !units.has(x._id)) { units.add(x._id); grew = true } }
  }
  scopeCache.set(user.userId, { at: Date.now(), units })
  return units
}
export async function inHrScope(user: AccessUser, employeeId: string) {
  const units = await hrScope(user)
  if (!units) return true
  const e: any = await Employee.findOne({ _id: employeeId, tenantId: user.tenantId }).select('orgUnitId').lean()
  return !!e && units.has(e.orgUnitId)
}

export async function hrAdminsFor(tenantId: string, employeeId: string): Promise<string[]> {
  const [hrs, emp]: any[] = await Promise.all([
    User.find({ tenantId, active: true, 'userRoles.roleName': 'hr_admin' }).select('hrScopeUnitIds userRoles').lean(),
    Employee.findOne({ _id: employeeId, tenantId }).select('orgUnitId').lean(),
  ])
  const out: string[] = []
  for (const h of hrs) {
    const roles = h.userRoles.map((r: any) => r.roleName)
    if (!h.hrScopeUnitIds?.length || roles.includes('system_admin')) { out.push(h._id); continue }
    const units = await hrScope({ userId: h._id, tenantId, roleIds: roles })
    if (emp && units?.has(emp.orgUnitId)) out.push(h._id)
  }
  return out.length ? out : hrs.map((h: any) => h._id)
}

async function targetInTenant(user: AccessUser, targetEmployeeId: string) {
  const target = await findEmployee(targetEmployeeId)
  return target && target.tenantId === user.tenantId ? target : null
}

export async function canAccessProfile(user: AccessUser, targetEmployeeId: string): Promise<boolean> {
  if (!(await targetInTenant(user, targetEmployeeId))) return false
  if (isSelf(user, targetEmployeeId) || hasRole(user, 'system_admin', 'payroll_admin')) return true
  if (hasRole(user, 'hr_admin') && (await inHrScope(user, targetEmployeeId))) return true
  return user.employeeId ? isReportingChainOf(user.employeeId, targetEmployeeId) : false
}

export async function canAccessCompensation(user: AccessUser, targetEmployeeId: string): Promise<boolean> {
  if (!(await targetInTenant(user, targetEmployeeId))) return false
  return isSelf(user, targetEmployeeId) || hasRole(user, 'payroll_admin', 'compliance_officer')
}

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

export async function assertCanApprove(user: AccessUser, requestEmployeeId: string, tenantId: string, entity?: { entityType: string; entityId: string }) {
  const owner = await findEmployee(requestEmployeeId)
  if (!owner || owner.tenantId !== tenantId || user.tenantId !== tenantId) throw new AppError('You are not allowed to approve this request', 403)

  const isHR = hasRole(user, 'hr_admin') && (await inHrScope(user, requestEmployeeId))

  if (isSelf(user, requestEmployeeId)) {
    if (!owner.managerId && isHR) {
      const target = entity ?? { entityType: 'employee', entityId: requestEmployeeId }
      await AuditLog.create({ tenantId, userId: user.userId, action: 'SELF_APPROVAL', entityType: target.entityType, entityId: target.entityId })
      return
    }
    throw new AppError('You cannot approve your own request', 403)
  }

  const isDirectManager = !!user.employeeId && owner.managerId === user.employeeId
  if (isDirectManager || isHR) return
  const isSkipLevel = !!user.employeeId && hasRole(user, 'manager') && (await isReportingChainOf(user.employeeId, requestEmployeeId))
  if (!isSkipLevel) throw new AppError("Only the requester's managers or HR can approve this request", 403)
}

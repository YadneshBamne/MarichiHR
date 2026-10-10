import { prisma } from '../../infrastructure/database/prisma'

// Targeting by department and office (announcements, policies). Empty lists mean "everyone". A department target
// includes its sub-units. People without an employee record (e.g. finance-only logins) only see company-wide items.

export interface Targeted { departmentIds: string[]; workLocationIds: string[] }
export interface Scope { units: Set<string>; workLocationId: string | null }

async function unitParents(tenantId: string) {
  const units = await prisma.orgUnit.findMany({ where: { tenantId }, select: { id: true, parentId: true } })
  return new Map(units.map((u) => [u.id, u.parentId]))
}

// The unit and every unit above it
function chain(parents: Map<string, string | null>, unitId: string | null) {
  const out = new Set<string>()
  for (let u = unitId; u && !out.has(u); u = parents.get(u) ?? null) out.add(u)
  return out
}

export async function scopeOf(tenantId: string, employeeId?: string | null): Promise<Scope> {
  if (!employeeId) return { units: new Set(), workLocationId: null }
  const [emp, parents] = await Promise.all([
    prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { orgUnitId: true, workLocationId: true } }),
    unitParents(tenantId),
  ])
  return { units: chain(parents, emp?.orgUnitId ?? null), workLocationId: emp?.workLocationId ?? null }
}

export const inAudience = (t: Targeted, s: Scope) =>
  (!t.departmentIds.length || t.departmentIds.some((d) => s.units.has(d))) &&
  (!t.workLocationIds.length || (!!s.workLocationId && t.workLocationIds.includes(s.workLocationId)))

// Every active login in the audience (for notifications and read tracking)
export async function audienceUsers(tenantId: string, t: Targeted) {
  const [users, parents] = await Promise.all([
    prisma.user.findMany({
      where: { tenantId, active: true },
      select: { id: true, fullName: true, employee: { select: { id: true, orgUnitId: true, workLocationId: true, active: true } } },
    }),
    unitParents(tenantId),
  ])
  return users.filter((u) => {
    if (u.employee && !u.employee.active) return false
    const s: Scope = u.employee ? { units: chain(parents, u.employee.orgUnitId), workLocationId: u.employee.workLocationId } : { units: new Set(), workLocationId: null }
    return inAudience(t, s)
  })
}

// Department / office ids must belong to the company
export async function assertTargets(tenantId: string, t: Partial<Targeted>) {
  const [d, l] = await Promise.all([
    t.departmentIds?.length ? prisma.orgUnit.count({ where: { tenantId, id: { in: t.departmentIds } } }) : 0,
    t.workLocationIds?.length ? prisma.workLocation.count({ where: { tenantId, id: { in: t.workLocationIds } } }) : 0,
  ])
  return d === new Set(t.departmentIds ?? []).size && l === new Set(t.workLocationIds ?? []).size
}

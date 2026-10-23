import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { assertMasters } from '../masters/masters.service'
import { holidaysBetween, holidayMap, holidayTargetOf } from '../../shared/utils/holidays'

// Attendance policies (greytHR "attendance schemes"): office hours and the day's rules, per employee group.
// Which one applies: the first active policy, lowest priority number first, whose filters all match the person
// (an empty filter matches everyone); then the company's default; then the built-in rules below.

export interface PolicyRules {
  id: string | null; name: string; flexible: boolean; startTime: string; endTime: string; graceInMinutes: number; graceOutMinutes: number
  halfDayHours: number; fullDayHours: number; lateEarlyAllowedPerMonth: number; latePenalty: 'none' | 'half_day_lop' | 'full_day_lop'
  regularisationDaysBack: number; regularisationPerMonth: number; overtimeEnabled: boolean; overtimeAfterHours: number; overtimeRate: number
  overtimeMaxHoursPerMonth: number | null; compOffEnabled: boolean; compOffHalfDayHours: number; compOffFullDayHours: number; allowWeb: boolean; requireGeofence: boolean
}
export const BUILT_IN: PolicyRules = {
  id: null, name: 'Standard rules', flexible: false, startTime: '09:00', endTime: '17:00', graceInMinutes: 10, graceOutMinutes: 10, halfDayHours: 4, fullDayHours: 8,
  lateEarlyAllowedPerMonth: 3, latePenalty: 'none', regularisationDaysBack: 30, regularisationPerMonth: 10, overtimeEnabled: true, overtimeAfterHours: 8, overtimeRate: 1.5,
  overtimeMaxHoursPerMonth: null, compOffEnabled: false, compOffHalfDayHours: 4, compOffFullDayHours: 8, allowWeb: true, requireGeofence: false,
}
const RULE_KEYS = Object.keys(BUILT_IN).filter((k) => k !== 'id' && k !== 'name') as (keyof PolicyRules)[]
const toRules = (p: any): PolicyRules => ({ id: p.id, name: p.name, ...Object.fromEntries(RULE_KEYS.map((k) => [k, p[k]])) } as PolicyRules)

type Who = { orgUnitId: string | null; workLocationId: string | null; employeeCategory: string | null; employmentType: string | null }
const matches = (p: any, e: Who) =>
  (!p.orgUnitIds.length || (!!e.orgUnitId && p.orgUnitIds.includes(e.orgUnitId))) &&
  (!p.workLocationIds.length || (!!e.workLocationId && p.workLocationIds.includes(e.workLocationId))) &&
  (!p.employeeCategories.length || (!!e.employeeCategory && p.employeeCategories.includes(e.employeeCategory))) &&
  (!p.employmentTypes.length || (!!e.employmentType && p.employmentTypes.includes(e.employmentType)))

export async function policyFor(employeeId: string): Promise<PolicyRules> {
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { tenantId: true, orgUnitId: true, workLocationId: true, employeeCategory: true, employmentType: true } })
  if (!e) return BUILT_IN
  const policies = await prisma.attendancePolicy.findMany({ where: { tenantId: e.tenantId, active: true }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] })
  const p = policies.find((x) => !x.isDefault && matches(x, e)) ?? policies.find((x) => x.isDefault)
  return p ? toRules(p) : BUILT_IN
}

// Minutes since midnight for "HH:MM"
export const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }

// Is this date a working day for the person (their working week, not a mandatory holiday)?
export async function isWorkingDay(employeeId: string, tenantId: string, date: Date) {
  const rostered = await prisma.rosterDay.findUnique({ where: { employeeId_date: { employeeId, date: new Date(`${date.toISOString().slice(0, 10)}T00:00:00Z`) } } })
  if (rostered) return !!rostered.shiftTemplateId
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { resourceCalendar: { select: { days: { select: { dayOfWeek: true } } } } } })
  const days = new Set((emp?.resourceCalendar?.days ?? []).map((d) => d.dayOfWeek))
  const weekday = (date.getUTCDay() + 6) % 7 // calendars use 0 = Monday
  if (days.size ? !days.has(weekday) : weekday > 4) return false
  const hol = holidayMap(await holidaysBetween(tenantId, date, date), await holidayTargetOf(employeeId))
  return !hol.has(date.toISOString().slice(0, 10))
}

// ─── Admin ────────────────────────────────────────────────────────────────────

type PolicyIn = Partial<Omit<PolicyRules, 'id'>> & { name?: string; priority?: number; isDefault?: boolean; active?: boolean; orgUnitIds?: string[]; workLocationIds?: string[]; employeeCategories?: string[]; employmentTypes?: string[] }

async function checkPolicy(tenantId: string, b: PolicyIn) {
  if (b.startTime && b.endTime && !b.flexible && minutesOf(b.endTime) <= minutesOf(b.startTime)) throw new AppError('Office hours must end after they start (night shifts are set on the shift itself)', 400)
  if (b.halfDayHours != null && b.fullDayHours != null && b.halfDayHours > b.fullDayHours) throw new AppError('Half-day hours cannot be more than full-day hours', 400)
  if (b.compOffHalfDayHours != null && b.compOffFullDayHours != null && b.compOffHalfDayHours > b.compOffFullDayHours) throw new AppError('Comp-off half-day hours cannot be more than full-day hours', 400)
  const [units, locs] = await Promise.all([
    b.orgUnitIds?.length ? prisma.orgUnit.count({ where: { tenantId, id: { in: b.orgUnitIds } } }) : 0,
    b.workLocationIds?.length ? prisma.workLocation.count({ where: { tenantId, id: { in: b.workLocationIds } } }) : 0,
  ])
  if ((b.orgUnitIds?.length ?? 0) !== units || (b.workLocationIds?.length ?? 0) !== locs) throw new AppError('Department or location not found', 404)
  for (const c of b.employeeCategories ?? []) await assertMasters(tenantId, { employee_category: c })
  for (const c of b.employmentTypes ?? []) await assertMasters(tenantId, { employment_type: c })
}
const audit = (u: AccessUser, action: string, entityId: string, newValue: any) => prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action, entityType: 'attendance_policy', entityId, newValue } })

export const policyService = {
  async list(tenantId: string) {
    const [rows, people] = await Promise.all([
      prisma.attendancePolicy.findMany({ where: { tenantId }, orderBy: [{ active: 'desc' }, { isDefault: 'desc' }, { priority: 'asc' }, { createdAt: 'asc' }] }),
      prisma.employee.findMany({ where: { tenantId, active: true }, select: { orgUnitId: true, workLocationId: true, employeeCategory: true, employmentType: true } }),
    ])
    // How many people each policy actually governs right now
    const active = rows.filter((r) => r.active)
    const counts = new Map<string, number>()
    for (const e of people) {
      const p = active.find((x) => !x.isDefault && matches(x, e)) ?? active.find((x) => x.isDefault)
      if (p) counts.set(p.id, (counts.get(p.id) ?? 0) + 1)
    }
    return { policies: rows.map((r) => ({ ...r, people: counts.get(r.id) ?? 0 })), uncovered: people.length - [...counts.values()].reduce((a, b) => a + b, 0), builtIn: BUILT_IN }
  },

  async save(u: AccessUser, id: string | null, b: PolicyIn) {
    await checkPolicy(u.tenantId, b)
    const existing = id ? await prisma.attendancePolicy.findFirst({ where: { id, tenantId: u.tenantId } }) : null
    if (id && !existing) throw new AppError('Policy not found', 404)
    if (existing?.isDefault && b.active === false) throw new AppError('Make another policy the default before retiring this one', 400)
    if (existing?.isDefault && b.isDefault === false) throw new AppError('Make another policy the default instead', 400)
    const row = await prisma.$transaction(async (tx) => {
      if (b.isDefault) await tx.attendancePolicy.updateMany({ where: { tenantId: u.tenantId, isDefault: true, ...(id ? { id: { not: id } } : {}) }, data: { isDefault: false } })
      const data = { ...b } as any
      return id ? tx.attendancePolicy.update({ where: { id }, data }) : tx.attendancePolicy.create({ data: { ...data, tenantId: u.tenantId, name: b.name!, isDefault: b.isDefault ?? !(await tx.attendancePolicy.count({ where: { tenantId: u.tenantId, isDefault: true } })) } })
    })
    await audit(u, id ? 'ATTENDANCE_POLICY_UPDATED' : 'ATTENDANCE_POLICY_CREATED', row.id, b)
    return row
  },

  async mine(employeeId: string | undefined) {
    if (!employeeId) return BUILT_IN
    return policyFor(employeeId)
  },
}

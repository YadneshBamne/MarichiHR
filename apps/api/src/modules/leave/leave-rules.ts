import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdOfEmployee, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { businessToday } from '../../shared/utils/businessDate'
import { actOnApproval, closeApproval } from '../approvals/approvals.service'

// ─── Statutory minimum entitlements (days) by country and leave category ────────────────────────────────────────
// A statutory leave type cannot be configured below the floor for its country. Figures from each country's labour
// law; confirm them with a local adviser (Zambia Employment Code Act 2019, India Maternity Benefit Act as amended
// 2017, Kenya Employment Act 2007 s.29, Nigeria Labour Act s.54).
export const STATUTORY_MINIMUMS: Record<string, Partial<Record<string, { days: number; source: string }>>> = {
  ZM: { maternity: { days: 98, source: 'Employment Code Act 2019: 14 weeks' }, paternity: { days: 5, source: 'Employment Code Act 2019: 5 days' } },
  IN: { maternity: { days: 182, source: 'Maternity Benefit Act (2017): 26 weeks' } },
  KE: { maternity: { days: 90, source: 'Employment Act 2007 s.29: 3 months' }, paternity: { days: 14, source: 'Employment Act 2007 s.29: 2 weeks' } },
  NG: { maternity: { days: 84, source: 'Labour Act s.54: 12 weeks' } },
}

export async function statutoryFloor(tenantId: string, t: { category: string; isStatutory: boolean; statutoryCountry: string | null }) {
  if (!t.isStatutory) return null
  const country = t.statutoryCountry ?? (await prisma.tenant.findUnique({ where: { id: tenantId }, select: { primaryCountry: true } }))?.primaryCountry
  return country ? STATUTORY_MINIMUMS[country]?.[t.category] ?? null : null
}

// Saving a statutory type below its floor is refused (the floor cannot be reduced by policy)
export async function assertStatutoryFloor(tenantId: string, t: { category: string; isStatutory: boolean; statutoryCountry: string | null; accrualAmount: number | null }) {
  const floor = await statutoryFloor(tenantId, t)
  if (floor && (t.accrualAmount ?? 0) < floor.days) throw new AppError(`This statutory leave cannot be below ${floor.days} days (${floor.source})`, 400)
}

// When the company's country is set, statutory types below that country's floor are raised to it
export async function raiseToStatutoryFloors(tenantId: string) {
  const types = await prisma.leaveType.findMany({ where: { tenantId, isStatutory: true } })
  for (const t of types) {
    const floor = await statutoryFloor(tenantId, t)
    if (floor && (t.accrualAmount ?? 0) < floor.days) await prisma.leaveType.update({ where: { id: t.id }, data: { accrualAmount: floor.days } })
  }
}

// ─── Tenure slabs: more leave with longer service ──────────────────────────────────────────────────────────────
export const TenureSlabs = z.array(z.object({ fromYears: z.number().min(0).max(60), amount: z.number().min(0).max(366) }).strict()).max(10).nullable()
export function accrualFor(t: { accrualAmount: number | null; tenureSlabs: unknown }, hireDate: Date, at: Date) {
  const slabs = (Array.isArray(t.tenureSlabs) ? t.tenureSlabs : []) as { fromYears: number; amount: number }[]
  const years = (at.getTime() - hireDate.getTime()) / (365.25 * 86_400_000)
  const slab = [...slabs].sort((a, b) => b.fromYears - a.fromYears).find((s) => years >= s.fromYears)
  return slab ? slab.amount : t.accrualAmount ?? 0
}

// ─── Send back for changes ──────────────────────────────────────────────────────────────────────────────────────
// The approver returns a request with a note; the days are released; the person edits and sends it again
export async function returnLeave(u: AccessUser, requestId: string, note: string) {
  const r = await prisma.leaveRequest.findFirst({ where: { id: requestId, employee: { tenantId: u.tenantId } }, include: { leaveType: true } })
  if (!r) throw new AppError('Leave request not found', 404)
  if (r.status !== 'pending') throw new AppError(`This request is already ${r.status}`, 400)
  await actOnApproval(u, 'leave', requestId, r.employeeId, false, note) // checks the caller may decide it; closes the chain
  const done = await prisma.leaveRequest.updateMany({ where: { id: requestId, status: 'pending' }, data: { status: 'returned', returnNote: note } })
  if (!done.count) throw new AppError('Someone else just decided this request', 409)
  await prisma.leaveBalance.updateMany({ where: { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId }, data: { pendingDays: { decrement: r.totalDays } } })
  await closeApproval(u.tenantId, 'leave', requestId)
  await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'LEAVE_RETURNED', entityType: 'leave_request', entityId: requestId, newValue: { note } } })
  const uid = await userIdOfEmployee(u.tenantId, r.employeeId)
  if (uid) await notify({ tenantId: u.tenantId, userIds: [uid], type: 'leave.returned', title: `Your ${r.leaveType.name} request needs changes`, body: note, link: '/leave', entityType: 'leave_request', entityId: requestId })
  return { status: 'returned' }
}

// ─── Leave and attendance disagree ──────────────────────────────────────────────────────────────────────────────
// Approved leave on a day the person clocked in: a task for their manager (or HR) to correct one or the other.
// Looks back 7 days; one task per request and day.
export async function leaveAttendanceCheck(tenantId: string) {
  const today = await businessToday(tenantId)
  const from = new Date(today.getTime() - 7 * 86_400_000)
  const leaves = await prisma.leaveRequest.findMany({
    where: { status: 'approved', employee: { tenantId }, startDate: { lt: today }, endDate: { gte: from } },
    select: { id: true, employeeId: true, startDate: true, endDate: true, hours: true, startHalf: true, endHalf: true, leaveType: { select: { name: true } }, employee: { select: { firstName: true, lastName: true, managerId: true } } },
  })
  if (!leaves.length) return { tasks: 0 }
  const type = await prisma.activityType.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' } })
  const hrEmp = await prisma.employee.findFirst({ where: { tenantId, active: true, user: { userRoles: { some: { role: { name: 'hr_admin' } } } } }, select: { id: true } })
  if (!type) return { tasks: 0 }
  let tasks = 0
  for (const l of leaves) {
    if (l.hours || l.startHalf || l.endHalf) continue // part-day leave can sit next to a punch
    const punches = await prisma.attendanceRecord.findMany({ where: { employeeId: l.employeeId, date: { gte: l.startDate > from ? l.startDate : from, lte: l.endDate < today ? l.endDate : today }, checkInTime: { not: null } }, select: { date: true } })
    for (const p of punches) {
      const day = p.date.toISOString().slice(0, 10)
      const title = `Leave and attendance disagree on ${day}`
      if (await prisma.activity.findFirst({ where: { tenantId, entityType: 'leave_request', entityId: l.id, title } })) continue
      const assignee = l.employee.managerId ?? hrEmp?.id
      if (!assignee) continue
      await prisma.activity.create({ data: { tenantId, activityTypeId: type.id, entityType: 'leave_request', entityId: l.id, title, note: `${l.employee.firstName} ${l.employee.lastName} was on approved ${l.leaveType.name} but clocked in. Cancel the leave for that day or correct the attendance.`, assignedToId: assignee, createdBy: 'system', dueDate: new Date(today.getTime() + 2 * 86_400_000), status: 'planned' } })
      tasks++
    }
  }
  if (tasks) {
    const hrs = await userIdsWithRole(tenantId, 'hr_admin')
    await notify({ tenantId, userIds: hrs, type: 'leave.mismatch', title: `${tasks} leave and attendance mismatch${tasks === 1 ? '' : 'es'} to check`, body: 'See Tasks', link: '/activities' })
  }
  return { tasks }
}

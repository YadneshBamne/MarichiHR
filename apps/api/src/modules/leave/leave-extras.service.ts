import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { storage } from '../../infrastructure/storage/storage'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, isReportingChainOf } from '../../shared/utils/access'
import { businessToday } from '../../shared/utils/businessDate'

// Leave extras: blackout periods (no leave on these dates), teammates already off (a warning, never a block),
// medical certificates (a document on the person, opened by them, their managers and HR), carry-forward expiry
// (unused carried days lapse after the type's window; carried days count as used first), and the leave liability
// (what unused encashable leave would cost to pay out).
const ymdArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const day = (s: string) => new Date(`${s}T00:00:00.000Z`)
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export const ApplyLeaveSchema = z.object({
  body: z.object({
    leaveTypeId: z.string().uuid(),
    startDate: ymdArg,
    endDate: ymdArg,
    startHalf: z.enum(['first_half', 'second_half']).optional(),
    endHalf: z.enum(['first_half', 'second_half']).optional(),
    reason: z.string().trim().max(1000).optional(),
    attachmentDocumentId: z.string().uuid().optional(), // e.g. a medical certificate uploaded to the person's documents
    hours: z.number().min(0.5).max(12).multipleOf(0.5).optional(), // hourly leave on one day
  }).strict(),
})
export const BlackoutBody = z.object({
  name: z.string().trim().min(2).max(80), startDate: ymdArg, endDate: ymdArg,
  leaveTypeIds: z.array(z.string().uuid()).max(50).default([]), departmentIds: z.array(z.string().uuid()).max(100).default([]),
}).strict()

export const leaveExtras = {
  // ─── Blackouts ────────────────────────────────────────────
  async blackouts(tenantId: string) {
    const rows = await prisma.leaveBlackout.findMany({ where: { tenantId, active: true }, orderBy: { startDate: 'asc' } })
    return rows.map((b) => ({ ...b, startDate: ymd(b.startDate), endDate: ymd(b.endDate) }))
  },
  async createBlackout(u: AccessUser, b: z.infer<typeof BlackoutBody>) {
    if (b.endDate < b.startDate) throw new AppError('The end date is before the start date', 400)
    if (b.leaveTypeIds.length && (await prisma.leaveType.count({ where: { tenantId: u.tenantId, id: { in: b.leaveTypeIds } } })) !== b.leaveTypeIds.length) throw new AppError('Leave type not found', 404)
    if (b.departmentIds.length && (await prisma.orgUnit.count({ where: { tenantId: u.tenantId, id: { in: b.departmentIds } } })) !== b.departmentIds.length) throw new AppError('Department not found', 404)
    const row = await prisma.leaveBlackout.create({ data: { tenantId: u.tenantId, name: b.name, startDate: day(b.startDate), endDate: day(b.endDate), leaveTypeIds: b.leaveTypeIds, departmentIds: b.departmentIds, createdBy: u.userId } })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'LEAVE_BLACKOUT_CREATED', entityType: 'leave_blackout', entityId: row.id, newValue: b } })
    return row
  },
  async removeBlackout(u: AccessUser, id: string) {
    const r = await prisma.leaveBlackout.updateMany({ where: { id, tenantId: u.tenantId }, data: { active: false } })
    if (!r.count) throw new AppError('Blackout not found', 404)
    return { removed: true }
  },
  // Called when leave is applied for: refuses dates inside a blackout that covers this type and person
  async assertNoBlackout(tenantId: string, employeeId: string, leaveTypeId: string, start: Date, end: Date) {
    const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { orgUnitId: true } })
    const hit = await prisma.leaveBlackout.findFirst({
      where: {
        tenantId, active: true, startDate: { lte: end }, endDate: { gte: start },
        AND: [{ OR: [{ leaveTypeIds: { isEmpty: true } }, { leaveTypeIds: { has: leaveTypeId } }] }, { OR: [{ departmentIds: { isEmpty: true } }, ...(emp?.orgUnitId ? [{ departmentIds: { has: emp.orgUnitId } }] : [])] }],
      },
    })
    if (hit) throw new AppError(`${ymd(hit.startDate)} to ${ymd(hit.endDate)} is a blackout period (${hit.name}): leave cannot be taken then`, 400)
  },

  // ─── Teammates already off ────────────────────────────────
  // Same manager (and, for a manager, their direct reports): pending or approved leave overlapping the dates
  async overlaps(tenantId: string, employeeId: string, start: Date, end: Date) {
    const me = await prisma.employee.findUnique({ where: { id: employeeId }, select: { managerId: true } })
    const team = await prisma.employee.findMany({ where: { tenantId, active: true, id: { not: employeeId }, OR: [...(me?.managerId ? [{ managerId: me.managerId }] : []), { managerId: employeeId }] }, select: { id: true } })
    if (!team.length) return []
    const rows = await prisma.leaveRequest.findMany({
      where: { employeeId: { in: team.map((t) => t.id) }, status: { in: ['pending', 'approved'] }, startDate: { lte: end }, endDate: { gte: start } },
      select: { startDate: true, endDate: true, status: true, employee: { select: { firstName: true, lastName: true } } }, orderBy: { startDate: 'asc' },
    })
    return rows.map((r) => ({ name: `${r.employee.firstName} ${r.employee.lastName}`, startDate: ymd(r.startDate), endDate: ymd(r.endDate), status: r.status }))
  },

  // ─── Medical certificates ─────────────────────────────────
  async assertOwnDocument(tenantId: string, employeeId: string, documentId: string) {
    const doc = await prisma.employeeDocument.findFirst({ where: { id: documentId, tenantId, employeeId, active: true } })
    if (!doc) throw new AppError('Attachment not found', 404)
  },
  // The person, anyone above them in the reporting line, and HR open it (a 60-second link, audit-logged)
  async attachment(u: AccessUser, requestId: string) {
    const r = await prisma.leaveRequest.findFirst({ where: { id: requestId, employee: { tenantId: u.tenantId } }, select: { employeeId: true, attachmentUrl: true } })
    if (!r) throw new AppError('Leave request not found', 404)
    const allowed = r.employeeId === u.employeeId || u.roleIds.includes('hr_admin') || (!!u.employeeId && (await isReportingChainOf(u.employeeId, r.employeeId)))
    const docId = r.attachmentUrl?.startsWith('doc:') ? r.attachmentUrl.slice(4) : null
    if (!allowed || !docId) throw new AppError('Attachment not found', 404)
    const doc = await prisma.employeeDocument.findFirst({ where: { id: docId, tenantId: u.tenantId, employeeId: r.employeeId, active: true } })
    if (!doc) throw new AppError('Attachment not found', 404)
    const url = await storage().signedUrl(doc.fileKey, 60, doc.fileName)
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'DOCUMENT_DOWNLOADED', entityType: 'employee', entityId: r.employeeId, newValue: { documentId: doc.id, via: 'leave_request' } } })
    return { url, expiresInSeconds: 60 }
  },

  // ─── Carry-forward expiry ─────────────────────────────────
  // For each finished year-end run: once `carryForwardExpiryMonths` have passed since the new leave year began, the
  // carried days not yet used (or booked) lapse. One 'carry_forward_expiry' ledger row per person and type makes it idempotent.
  async expireCarryForward(tenantId: string) {
    const today = await businessToday(tenantId)
    const runs = await prisma.leaveYearEndRun.findMany({ where: { tenantId, status: 'done' }, orderBy: { yearEnd: 'desc' }, take: 2 })
    const types = await prisma.leaveType.findMany({ where: { tenantId, carryForward: true, carryForwardExpiryMonths: { not: null } } })
    let lapsed = 0
    for (const run of runs) {
      const yearStart = new Date(run.yearEnd.getTime() + 86_400_000)
      for (const t of types) {
        const expiry = new Date(Date.UTC(yearStart.getUTCFullYear(), yearStart.getUTCMonth() + t.carryForwardExpiryMonths!, yearStart.getUTCDate()))
        if (expiry > today) continue
        for (const row of (run.rows as any[]).filter((x) => x.leaveTypeId === t.id && x.carried > 0)) {
          if (await prisma.leaveAllocation.findFirst({ where: { employeeId: row.employeeId, leaveTypeId: t.id, allocationType: 'carry_forward_expiry', validFrom: expiry } })) continue
          const bal = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId: { employeeId: row.employeeId, leaveTypeId: t.id } } })
          if (!bal) continue
          const unused = round2(Math.max(0, row.carried - bal.usedDays - bal.pendingDays))
          await prisma.$transaction([
            prisma.leaveAllocation.create({ data: { employeeId: row.employeeId, leaveTypeId: t.id, allocationType: 'carry_forward_expiry', daysAllocated: -unused, validFrom: expiry, reason: `Carried-forward days expired after ${t.carryForwardExpiryMonths} months`, approvedBy: 'system' } }),
            ...(unused > 0 ? [prisma.leaveBalance.update({ where: { employeeId_leaveTypeId: { employeeId: row.employeeId, leaveTypeId: t.id } }, data: { balanceDays: { decrement: unused }, lapsedDays: { increment: unused } } })] : []),
          ])
          lapsed += unused
        }
      }
    }
    return { lapsed: round2(lapsed) }
  },

  // ─── Leave liability ──────────────────────────────────────
  // Days available on encashable types × the daily rate (monthly wage / 30), per person, for Payroll
  async liability(tenantId: string) {
    const balances = await prisma.leaveBalance.findMany({
      where: { leaveType: { tenantId, encashable: true, active: true }, employee: { tenantId, active: true } },
      select: { employeeId: true, balanceDays: true, usedDays: true, pendingDays: true, leaveType: { select: { name: true } }, employee: { select: { firstName: true, lastName: true, employeeCode: true, orgUnit: { select: { name: true } } } } },
    })
    const contracts = await prisma.employeeContract.findMany({ where: { employeeId: { in: [...new Set(balances.map((b) => b.employeeId))] }, active: true, status: 'running' }, select: { employeeId: true, wageMonthly: true, currency: true } })
    const pay = new Map(contracts.map((c) => [c.employeeId, { daily: Number(c.wageMonthly) / 30, currency: c.currency }]))
    return balances.map((b) => {
      const days = round2(Math.max(0, b.balanceDays - b.usedDays - b.pendingDays))
      const p = pay.get(b.employeeId)
      return { employee: `${b.employee.firstName} ${b.employee.lastName}`, employeeCode: b.employee.employeeCode, department: b.employee.orgUnit?.name ?? null, leaveType: b.leaveType.name, days, dailyRate: p ? round2(p.daily) : null, liability: p ? round2(days * p.daily) : null, currency: p?.currency ?? null }
    }).filter((r) => r.days > 0)
  },
}

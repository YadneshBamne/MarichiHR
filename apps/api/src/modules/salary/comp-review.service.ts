import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, getReportingSubtreeIds } from '../../shared/utils/access'
import { revisionService } from './revisions.service'

// Compensation review cycles. Payroll opens a cycle with a budget (% of each manager's team annual CTC). Managers
// recommend an increase % for each direct report and see only team totals, never a person's pay; totals are hidden
// for teams smaller than MIN_GROUP so an aggregate cannot reveal one salary. Payroll approves or rejects each
// recommendation and applies approved ones as salary revisions (which a second Payroll admin then approves).
export const MIN_GROUP = 3
const isPayroll = (u: AccessUser) => u.roleIds.includes('payroll_admin')
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const ymd = (d: Date) => d.toISOString().slice(0, 10)

export const CycleBody = z.object({ name: z.string().trim().min(2).max(80), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-01$/, 'A review takes effect on the 1st of a month'), budgetPercent: z.number().min(0).max(50) }).strict()
export const RecommendBody = z.object({ items: z.array(z.object({ employeeId: z.string().uuid(), increasePercent: z.number().min(0).max(100), note: z.string().trim().max(300).optional() }).strict()).min(1).max(200) }).strict()

async function contracts(tenantId: string, employeeIds: string[]) {
  const rows = await prisma.employeeContract.findMany({ where: { employeeId: { in: employeeIds }, active: true, status: 'running', employee: { tenantId } }, select: { employeeId: true, ctcAnnual: true, wageMonthly: true, currency: true } })
  return new Map(rows.map((c) => [c.employeeId, { ctc: Number(c.ctcAnnual), wage: Number(c.wageMonthly), currency: c.currency }]))
}

async function directReports(u: AccessUser) {
  if (!u.employeeId) return []
  return prisma.employee.findMany({ where: { tenantId: u.tenantId, managerId: u.employeeId, active: true }, select: { id: true, firstName: true, lastName: true, employeeCode: true }, orderBy: { firstName: 'asc' } })
}

async function loadCycle(u: AccessUser, id: string) {
  const c = await prisma.compReviewCycle.findFirst({ where: { id, tenantId: u.tenantId } })
  if (!c) throw new AppError('Review cycle not found', 404)
  return c
}

export const compReviewService = {
  async cycles(u: AccessUser) {
    if (!isPayroll(u) && !u.roleIds.includes('manager')) throw new AppError('Only Payroll and managers take part in reviews', 403)
    const rows = await prisma.compReviewCycle.findMany({ where: { tenantId: u.tenantId }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { recommendations: true } } } })
    return rows.map((c) => ({ id: c.id, name: c.name, effectiveFrom: ymd(c.effectiveFrom), budgetPercent: c.budgetPercent, status: c.status, recommendations: c._count.recommendations }))
  },
  async create(u: AccessUser, b: z.infer<typeof CycleBody>) {
    if (!isPayroll(u)) throw new AppError('Only Payroll admins open a review', 403)
    if (await prisma.compReviewCycle.findFirst({ where: { tenantId: u.tenantId, name: b.name } })) throw new AppError('A review with that name exists', 409)
    const c = await prisma.compReviewCycle.create({ data: { tenantId: u.tenantId, name: b.name, effectiveFrom: new Date(`${b.effectiveFrom}T00:00:00Z`), budgetPercent: b.budgetPercent, createdBy: u.userId } })
    await notify({ tenantId: u.tenantId, userIds: await userIdsWithRole(u.tenantId, 'manager'), type: 'salary.review', title: `Pay review open: ${b.name}`, body: 'Recommend increases for your team', link: '/compensation-review', entityType: 'comp_review', entityId: c.id })
    return c
  },

  // A manager's view: their direct reports with their own recommendations, and team totals only
  async myTeam(u: AccessUser, cycleId: string) {
    const c = await loadCycle(u, cycleId)
    const team = await directReports(u)
    if (!team.length) throw new AppError('You have no direct reports to review', 403)
    const [pay, recs] = await Promise.all([contracts(u.tenantId, team.map((t) => t.id)), prisma.compRecommendation.findMany({ where: { cycleId, employeeId: { in: team.map((t) => t.id) } } })])
    const eligible = team.filter((t) => pay.has(t.id))
    const totalCtc = eligible.reduce((a, t) => a + pay.get(t.id)!.ctc, 0)
    const budget = (totalCtc * c.budgetPercent) / 100
    const used = recs.reduce((a, r) => a + ((pay.get(r.employeeId)?.ctc ?? 0) * r.increasePercent) / 100, 0)
    const show = eligible.length >= MIN_GROUP
    return {
      cycle: { id: c.id, name: c.name, effectiveFrom: ymd(c.effectiveFrom), budgetPercent: c.budgetPercent, status: c.status },
      people: team.map((t) => { const r = recs.find((x) => x.employeeId === t.id); return { employeeId: t.id, name: `${t.firstName} ${t.lastName}`, employeeCode: t.employeeCode, eligible: pay.has(t.id), increasePercent: r?.increasePercent ?? null, note: r?.note ?? null, status: r?.status ?? null } }),
      totals: {
        headcount: eligible.length,
        // Budget used as a share of the budget is safe to show at any size; amounts only for groups of MIN_GROUP or more
        usedOfBudgetPercent: budget > 0 ? round2((used / budget) * 100) : 0,
        overBudget: used > budget + 0.005,
        currency: pay.get(eligible[0]?.id)?.currency ?? null,
        totalAnnualCtc: show ? round2(totalCtc) : null,
        budget: show ? round2(budget) : null,
        used: show ? round2(used) : null,
        hiddenBecauseSmallTeam: !show,
      },
    }
  },
  async recommend(u: AccessUser, cycleId: string, b: z.infer<typeof RecommendBody>) {
    const c = await loadCycle(u, cycleId)
    if (c.status !== 'open') throw new AppError('This review is closed', 400)
    const team = new Set((await directReports(u)).map((t) => t.id))
    for (const i of b.items) if (!team.has(i.employeeId)) throw new AppError('You can recommend only for your direct reports', 403)
    for (const i of b.items) {
      const existing = await prisma.compRecommendation.findUnique({ where: { cycleId_employeeId: { cycleId, employeeId: i.employeeId } } })
      if (existing && existing.status !== 'recommended') throw new AppError('Payroll has already decided one of these', 400)
      await prisma.compRecommendation.upsert({
        where: { cycleId_employeeId: { cycleId, employeeId: i.employeeId } },
        create: { tenantId: u.tenantId, cycleId, employeeId: i.employeeId, managerEmployeeId: u.employeeId!, increasePercent: i.increasePercent, note: i.note ?? null },
        update: { increasePercent: i.increasePercent, note: i.note ?? null, managerEmployeeId: u.employeeId! },
      })
    }
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'COMP_RECOMMENDED', entityType: 'comp_review', entityId: cycleId, newValue: { count: b.items.length } } })
    return this.myTeam(u, cycleId)
  },

  // Payroll's view: every recommendation with current and proposed pay, and each manager's budget
  async review(u: AccessUser, cycleId: string) {
    if (!isPayroll(u)) throw new AppError('Only Payroll admins see recommendations', 403)
    const c = await loadCycle(u, cycleId)
    const recs = await prisma.compRecommendation.findMany({ where: { cycleId }, orderBy: { createdAt: 'asc' } })
    const ids = [...new Set(recs.flatMap((r) => [r.employeeId, r.managerEmployeeId]))]
    const emps = await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
    const nm = new Map(emps.map((e) => [e.id, `${e.firstName} ${e.lastName}`]))
    const pay = await contracts(u.tenantId, recs.map((r) => r.employeeId))
    const managers = [...new Set(recs.map((r) => r.managerEmployeeId))]
    const budgets = await Promise.all(managers.map(async (m) => {
      const team = await prisma.employee.findMany({ where: { tenantId: u.tenantId, managerId: m, active: true }, select: { id: true } })
      const tp = await contracts(u.tenantId, team.map((t) => t.id))
      const total = [...tp.values()].reduce((a, p) => a + p.ctc, 0)
      const used = recs.filter((r) => r.managerEmployeeId === m && r.status !== 'rejected').reduce((a, r) => a + ((pay.get(r.employeeId)?.ctc ?? 0) * r.increasePercent) / 100, 0)
      return { manager: nm.get(m) ?? null, managerEmployeeId: m, budget: round2((total * c.budgetPercent) / 100), used: round2(used) }
    }))
    return {
      cycle: { id: c.id, name: c.name, effectiveFrom: ymd(c.effectiveFrom), budgetPercent: c.budgetPercent, status: c.status },
      budgets,
      recommendations: recs.map((r) => {
        const p = pay.get(r.employeeId)
        return { id: r.id, employeeId: r.employeeId, employee: nm.get(r.employeeId) ?? null, manager: nm.get(r.managerEmployeeId) ?? null, increasePercent: r.increasePercent, note: r.note, status: r.status, currency: p?.currency ?? null, currentCtc: p?.ctc ?? null, proposedCtc: p ? round2(p.ctc * (1 + r.increasePercent / 100)) : null, revisionId: r.revisionId }
      }),
    }
  },
  async decide(u: AccessUser, id: string, approve: boolean) {
    if (!isPayroll(u)) throw new AppError('Only Payroll admins decide recommendations', 403)
    const r = await prisma.compRecommendation.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!r) throw new AppError('Recommendation not found', 404)
    if (r.employeeId === u.employeeId) throw new AppError('You cannot decide your own pay', 403)
    const done = await prisma.compRecommendation.updateMany({ where: { id, status: { in: ['recommended', 'approved', 'rejected'] } }, data: { status: approve ? 'approved' : 'rejected', decidedBy: u.userId } })
    if (!done.count) throw new AppError('This recommendation was already applied', 400)
    return { status: approve ? 'approved' : 'rejected' }
  },
  // Approved recommendations become salary revisions (pending: a second Payroll admin approves each)
  async apply(u: AccessUser, cycleId: string) {
    if (!isPayroll(u)) throw new AppError('Only Payroll admins apply a review', 403)
    const c = await loadCycle(u, cycleId)
    const recs = await prisma.compRecommendation.findMany({ where: { cycleId, status: 'approved' } })
    if (!recs.length) throw new AppError('Approve at least one recommendation first', 400)
    const pay = await contracts(u.tenantId, recs.map((r) => r.employeeId))
    const out = { revisions: 0, skipped: [] as string[] }
    for (const r of recs) {
      const p = pay.get(r.employeeId)
      if (!p || r.employeeId === u.employeeId) { out.skipped.push(r.employeeId); continue }
      try {
        const rev = await revisionService.create(u, { employeeId: r.employeeId, newCtcAnnual: round2(p.ctc * (1 + r.increasePercent / 100)), newWageMonthly: round2(p.wage * (1 + r.increasePercent / 100)), effectiveFrom: ymd(c.effectiveFrom), reason: `${c.name}: ${r.increasePercent}% increase` })
        await prisma.compRecommendation.update({ where: { id: r.id }, data: { status: 'applied', revisionId: rev.id } })
        out.revisions++
      } catch { out.skipped.push(r.employeeId) }
    }
    await prisma.compReviewCycle.update({ where: { id: c.id }, data: { status: 'applied' } })
    return out
  },
  async close(u: AccessUser, cycleId: string) {
    if (!isPayroll(u)) throw new AppError('Only Payroll admins close a review', 403)
    await loadCycle(u, cycleId)
    await prisma.compReviewCycle.update({ where: { id: cycleId }, data: { status: 'closed' } })
    return { status: 'closed' }
  },

  // A manager's team cost: everyone below them, as totals only (hidden under MIN_GROUP people)
  async teamCost(u: AccessUser) {
    if (!u.employeeId || !u.roleIds.includes('manager')) throw new AppError('Only managers see team cost', 403)
    const ids = await getReportingSubtreeIds(u.employeeId, u.tenantId)
    const pay = await contracts(u.tenantId, ids)
    const people = [...pay.values()]
    const latest = await prisma.payrollCycle.findFirst({ where: { tenantId: u.tenantId, status: { in: ['approved', 'disbursed'] } }, orderBy: { payPeriodStart: 'desc' }, select: { id: true, payPeriodStart: true } })
    const show = people.length >= MIN_GROUP
    const gross = latest && show ? await prisma.payslip.aggregate({ where: { payrollCycleId: latest.id, employeeId: { in: ids } }, _sum: { grossEarnings: true, netPay: true }, _count: true }) : null
    return {
      headcount: ids.length, withContract: people.length, currency: people[0]?.currency ?? null, hiddenBecauseSmallTeam: !show, minGroup: MIN_GROUP,
      annualCtc: show ? round2(people.reduce((a, p) => a + p.ctc, 0)) : null,
      monthlyWages: show ? round2(people.reduce((a, p) => a + p.wage, 0)) : null,
      lastPayroll: gross && latest ? { month: ymd(latest.payPeriodStart).slice(0, 7), gross: round2(Number(gross._sum.grossEarnings ?? 0)), people: gross._count } : null,
    }
  },
}

import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { notify, userIdsWithRole, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { evaluateRuleExpression } from '../payroll/payroll.expression'
import { ratingOf } from '../performance/performance.service'

// Incentives beyond single nominations:
// - schemes: a formula over values entered per person (commission, KPI bonus, milestone); a run creates nominations
//   that carry their working ("why this amount")
// - manager budgets: a manager's nominations in a period must fit the budget; alerts at 80% and 100%
// - performance ratings -> suggested variable pay (Payroll, since it reads contracts)
// - kudos points: each kudos earns points, which expire; redeemed as an incentive that HR approves

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const has = (u: AccessUser, r: string) => u.roleIds.includes(r)
const day = (d: Date) => d.toISOString().slice(0, 10)
const audit = (u: AccessUser, action: string, entityType: string, entityId: string, newValue?: any) =>
  prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action, entityType, entityId, newValue } })
const DEFAULT_PAYOUT: Record<string, number> = { 'Exceeds expectations': 120, 'Meets expectations': 100, 'Partly meets expectations': 50, 'Below expectations': 0 }

export async function settingsOf(tenantId: string) {
  const s = await prisma.incentiveSettings.findUnique({ where: { tenantId } })
  return {
    ratingPayout: { ...DEFAULT_PAYOUT, ...((s?.ratingPayout as Record<string, number>) ?? {}) },
    kudosPoints: s?.kudosPoints ?? 10, pointValue: Number(s?.pointValue ?? 1), pointsExpireMonths: s?.pointsExpireMonths ?? 12, minRedeem: s?.minRedeem ?? 100,
  }
}

async function typeByCode(tenantId: string, code: string, name: string, description: string) {
  const t = await prisma.incentiveType.findFirst({ where: { tenantId, code } })
  if (t) return t
  const input = await prisma.payrollInputType.findFirst({ where: { tenantId, category: 'earnings', active: true }, orderBy: { createdAt: 'asc' } })
  return prisma.incentiveType.upsert({ where: { tenantId_code: { tenantId, code } }, update: {}, create: { tenantId, code, name, description, payrollInputTypeId: input?.id ?? null } })
}

async function tellHR(u: AccessUser, title: string, body: string, entityId: string) {
  const hrs = (await userIdsWithRole(u.tenantId, 'hr_admin')).filter((x) => x !== u.userId)
  await notify({ tenantId: u.tenantId, userIds: hrs, type: 'incentive.nominated', title, body, link: '/incentives', entityType: 'incentive', entityId })
}

// ─── Schemes ────────────────────────────────────────────────────────────────────────────────────────────────
export const SchemeBody = z.object({
  name: z.string().trim().min(2).max(80),
  kind: z.enum(['commission', 'kpi', 'milestone', 'other']),
  formula: z.string().trim().min(1).max(500),
  variables: z.array(z.object({ key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,29}$/, 'Names start with a small letter: sales, target, score'), label: z.string().trim().min(1).max(60) }).strict()).min(1).max(8),
  typeId: z.string().uuid(),
  active: z.boolean().optional(),
}).strict()
export const RunBody = z.object({
  period: z.string().trim().min(2).max(40),
  rows: z.array(z.object({ employeeId: z.string().uuid(), values: z.record(z.string(), z.number().min(-1e10).max(1e10)) }).strict()).min(1).max(500),
  dryRun: z.boolean().optional(),
}).strict()

function evaluate(formula: string, variables: { key: string }[], values: Record<string, number>) {
  const scope: Record<string, number> = {}
  for (const v of variables) {
    if (typeof values[v.key] !== 'number') throw new AppError(`Missing ${v.key}`, 400)
    scope[v.key] = values[v.key]
  }
  try { return round2(evaluateRuleExpression(formula, scope)) } catch (e: any) { throw new AppError(`The formula did not work: ${e.message}`, 400) }
}

export const incentiveExtras = {
  async settings(u: AccessUser) { return settingsOf(u.tenantId) },
  async saveSettings(u: AccessUser, b: { ratingPayout?: Record<string, number>; kudosPoints?: number; pointValue?: number; pointsExpireMonths?: number; minRedeem?: number }) {
    if (b.ratingPayout && Object.keys(b.ratingPayout).some((k) => !(k in DEFAULT_PAYOUT))) throw new AppError(`Ratings are: ${Object.keys(DEFAULT_PAYOUT).join(', ')}`, 400)
    const data = { ...b, ...(b.ratingPayout && { ratingPayout: b.ratingPayout }) }
    await prisma.incentiveSettings.upsert({ where: { tenantId: u.tenantId }, update: data, create: { tenantId: u.tenantId, ...data } })
    await audit(u, 'INCENTIVE_SETTINGS_UPDATED', 'incentive_settings', u.tenantId, b)
    return settingsOf(u.tenantId)
  },

  async schemes(u: AccessUser) {
    return prisma.incentiveScheme.findMany({ where: { tenantId: u.tenantId }, orderBy: { name: 'asc' } })
  },
  async saveScheme(u: AccessUser, id: string | null, b: z.infer<typeof SchemeBody>) {
    if (!(await prisma.incentiveType.findFirst({ where: { id: b.typeId, tenantId: u.tenantId } }))) throw new AppError('Incentive type not found', 404)
    if (new Set(b.variables.map((v) => v.key)).size !== b.variables.length) throw new AppError('Each value needs its own name', 400)
    // Check the formula on sample values (1 for each value) before saving
    evaluate(b.formula, b.variables, Object.fromEntries(b.variables.map((v) => [v.key, 1])))
    if (id) {
      const s = await prisma.incentiveScheme.findFirst({ where: { id, tenantId: u.tenantId } })
      if (!s) throw new AppError('Scheme not found', 404)
      const row = await prisma.incentiveScheme.update({ where: { id }, data: { ...b, variables: b.variables } })
      await audit(u, 'INCENTIVE_SCHEME_UPDATED', 'incentive_scheme', id, b)
      return row
    }
    try {
      const row = await prisma.incentiveScheme.create({ data: { ...b, variables: b.variables, tenantId: u.tenantId, createdBy: u.userId } })
      await audit(u, 'INCENTIVE_SCHEME_CREATED', 'incentive_scheme', row.id, b)
      return row
    } catch (e: any) {
      if (e?.code === 'P2002') throw new AppError('A scheme with that name exists', 409)
      throw e
    }
  },

  // Works out each person's amount; with dryRun only shows it, otherwise creates nominations for HR to approve
  async runScheme(u: AccessUser, id: string, b: z.infer<typeof RunBody>) {
    const s = await prisma.incentiveScheme.findFirst({ where: { id, tenantId: u.tenantId, active: true } })
    if (!s) throw new AppError('Scheme not found', 404)
    const vars = s.variables as { key: string; label: string }[]
    const [type, tenant, emps] = await Promise.all([
      prisma.incentiveType.findFirst({ where: { id: s.typeId, tenantId: u.tenantId } }),
      prisma.tenant.findUnique({ where: { id: u.tenantId }, select: { baseCurrency: true } }),
      prisma.employee.findMany({ where: { tenantId: u.tenantId, active: true, id: { in: b.rows.map((r) => r.employeeId) } }, select: { id: true, firstName: true, lastName: true } }),
    ])
    const out: { employeeId: string; name: string; amount: number; skipped?: string }[] = []
    for (const r of b.rows) {
      const e = emps.find((x) => x.id === r.employeeId)
      if (!e) { out.push({ employeeId: r.employeeId, name: '', amount: 0, skipped: 'not found' }); continue }
      const name = `${e.firstName} ${e.lastName}`
      if (e.id === u.employeeId) { out.push({ employeeId: e.id, name, amount: 0, skipped: 'you cannot nominate yourself' }); continue }
      let amount = evaluate(s.formula, vars, r.values)
      if (amount <= 0) { out.push({ employeeId: e.id, name, amount: 0, skipped: 'nothing earned' }); continue }
      if (type?.maxAmount != null && amount > Number(type.maxAmount)) amount = Number(type.maxAmount)
      out.push({ employeeId: e.id, name, amount })
    }
    if (b.dryRun) return { created: 0, rows: out }
    const working = (values: Record<string, number>) => `${s.formula.replace(/^\s*result\s*=\s*/, '')} with ${vars.map((v) => `${v.label} ${values[v.key]}`).join(', ')}${type?.maxAmount != null ? ` (capped at ${Number(type.maxAmount)})` : ''}`
    let created = 0
    for (const o of out.filter((x) => !x.skipped)) {
      const values = b.rows.find((r) => r.employeeId === o.employeeId)!.values
      const i = await prisma.incentive.create({ data: { tenantId: u.tenantId, employeeId: o.employeeId, typeId: s.typeId, amount: o.amount, currency: tenant?.baseCurrency ?? 'USD', reason: `${s.name} (${b.period})`, nominatedByUserId: u.userId, schemeId: s.id, formula: working(values), formulaInputs: values } })
      await audit(u, 'INCENTIVE_NOMINATED', 'incentive', i.id, { scheme: s.name, period: b.period, amount: o.amount, values })
      created++
    }
    if (created) await tellHR(u, `${s.name}: ${created} nomination${created === 1 ? '' : 's'}`, `${b.period}. Open Incentives to approve.`, s.id)
    return { created, rows: out }
  },

  // ─── Manager budgets ────────────────────────────────────────────────────────────────────────────────────
  async budgets(u: AccessUser) {
    const isHR = has(u, 'hr_admin')
    if (!isHR && !has(u, 'manager')) throw new AppError('Forbidden', 403)
    const rows = await prisma.incentiveBudget.findMany({ where: { tenantId: u.tenantId, ...(!isHR && { managerEmployeeId: u.employeeId ?? '' }) }, orderBy: [{ periodStart: 'desc' }] })
    const emps = await prisma.employee.findMany({ where: { tenantId: u.tenantId, id: { in: rows.map((r) => r.managerEmployeeId) } }, select: { id: true, firstName: true, lastName: true, userId: true } })
    return Promise.all(rows.map(async (b) => {
      const m = emps.find((e) => e.id === b.managerEmployeeId)
      const used = m?.userId ? await usedBy(u.tenantId, m.userId, b.periodStart, b.periodEnd) : { used: 0, paid: 0, count: 0 }
      return { id: b.id, managerEmployeeId: b.managerEmployeeId, manager: m ? `${m.firstName} ${m.lastName}` : '', periodStart: day(b.periodStart), periodEnd: day(b.periodEnd), amount: Number(b.amount), ...used, left: round2(Number(b.amount) - used.used), pct: Number(b.amount) > 0 ? Math.round((used.used / Number(b.amount)) * 100) : 0 }
    }))
  },
  async saveBudget(u: AccessUser, b: { managerEmployeeId: string; periodStart: string; periodEnd: string; amount: number }) {
    if (b.periodEnd < b.periodStart) throw new AppError('The period ends before it starts', 400)
    const m = await prisma.employee.findFirst({ where: { id: b.managerEmployeeId, tenantId: u.tenantId, active: true } })
    if (!m) throw new AppError('Manager not found', 404)
    const periodStart = new Date(`${b.periodStart}T00:00:00Z`), periodEnd = new Date(`${b.periodEnd}T00:00:00Z`)
    const overlap = await prisma.incentiveBudget.findFirst({ where: { tenantId: u.tenantId, managerEmployeeId: m.id, periodStart: { lte: periodEnd }, periodEnd: { gte: periodStart }, NOT: { periodStart } } })
    if (overlap) throw new AppError(`${m.firstName} already has a budget overlapping these dates (${day(overlap.periodStart)} to ${day(overlap.periodEnd)})`, 400)
    const row = await prisma.incentiveBudget.upsert({
      where: { tenantId_managerEmployeeId_periodStart: { tenantId: u.tenantId, managerEmployeeId: m.id, periodStart } },
      update: { periodEnd, amount: b.amount, alerted80At: null, alerted100At: null },
      create: { tenantId: u.tenantId, managerEmployeeId: m.id, periodStart, periodEnd, amount: b.amount, createdBy: u.userId },
    })
    await audit(u, 'INCENTIVE_BUDGET_SET', 'incentive_budget', row.id, b)
    const mu = await userIdOfEmployee(u.tenantId, m.id)
    if (mu) await notify({ tenantId: u.tenantId, userIds: [mu], type: 'incentive.budget', title: 'Your incentive budget', body: `${b.amount.toLocaleString()} for ${b.periodStart} to ${b.periodEnd}. Nominate your team from Incentives.`, link: '/incentives', entityType: 'incentive_budget', entityId: row.id })
    return row
  },

  // ─── Ratings -> variable pay (Payroll: it reads contracts) ─────────────────────────────────────────────
  async ratingSuggestions(u: AccessUser, cycleId: string) {
    if (!has(u, 'payroll_admin')) throw new AppError('Payroll suggests variable pay', 403)
    const cycle = await prisma.performanceCycle.findFirst({ where: { id: cycleId, tenantId: u.tenantId } })
    if (!cycle) throw new AppError('Review cycle not found', 404)
    const goals = await prisma.performanceGoal.findMany({ where: { cycleId: cycle.id, tenantId: u.tenantId, score: { not: null }, status: { in: ['reviewed', 'acknowledged'] } }, select: { employeeId: true, score: true } })
    const byEmp = new Map<string, number[]>()
    for (const g of goals) byEmp.set(g.employeeId, [...(byEmp.get(g.employeeId) ?? []), g.score!])
    const settings = await settingsOf(u.tenantId)
    const months = Math.max(1, Math.round((cycle.endDate.getTime() - cycle.startDate.getTime()) / (30.44 * 86_400_000)))
    const already = new Set((await prisma.incentive.findMany({ where: { tenantId: u.tenantId, reason: { startsWith: `Variable pay: ${cycle.name}` }, status: { notIn: ['rejected', 'cancelled'] } }, select: { employeeId: true } })).map((i) => i.employeeId))
    const emps = await prisma.employee.findMany({ where: { tenantId: u.tenantId, id: { in: [...byEmp.keys()] } }, select: { id: true, firstName: true, lastName: true, contracts: { where: { active: true, status: 'running' }, select: { ctcAnnual: true, variablePayPercent: true, currency: true }, take: 1 } } })
    return emps.map((e) => {
      const scores = byEmp.get(e.id)!
      const score = Math.round(scores.reduce((a, s) => a + s, 0) / scores.length)
      const rating = ratingOf(score)
      const payout = settings.ratingPayout[rating] ?? 0
      const k = e.contracts[0]
      const variable = k ? round2((Number(k.ctcAnnual) * (k.variablePayPercent / 100) * months) / 12) : 0
      return { employeeId: e.id, name: `${e.firstName} ${e.lastName}`, score, rating, payoutPercent: payout, variablePay: variable, suggested: round2((variable * payout) / 100), currency: k?.currency ?? null, months, alreadyNominated: already.has(e.id), note: !k ? 'no running contract' : !k.variablePayPercent ? 'contract has no variable pay %' : null }
    }).sort((a, b) => a.name.localeCompare(b.name))
  },
  async nominateFromRatings(u: AccessUser, cycleId: string, employeeIds: string[]) {
    const rows = (await incentiveExtras.ratingSuggestions(u, cycleId)).filter((r) => employeeIds.includes(r.employeeId) && r.suggested > 0 && !r.alreadyNominated && r.employeeId !== u.employeeId)
    const cycle = await prisma.performanceCycle.findFirst({ where: { id: cycleId, tenantId: u.tenantId } })
    const type = await typeByCode(u.tenantId, 'PERFORMANCE', 'Performance bonus', 'For results against goals')
    for (const r of rows) {
      // The working names the rating and %, not the salary: HR approves these and never sees pay
      const i = await prisma.incentive.create({ data: { tenantId: u.tenantId, employeeId: r.employeeId, typeId: type.id, amount: r.suggested, currency: r.currency ?? 'USD', reason: `Variable pay: ${cycle!.name}`, nominatedByUserId: u.userId, formula: `Your variable pay for ${cycle!.name} × ${r.payoutPercent}% for "${r.rating}" (score ${r.score}%)`, formulaInputs: { score: r.score, rating: r.rating, payoutPercent: r.payoutPercent } } })
      await audit(u, 'INCENTIVE_NOMINATED', 'incentive', i.id, { from: 'ratings', cycle: cycle!.name, amount: r.suggested })
    }
    if (rows.length) await tellHR(u, `Variable pay for ${cycle!.name}: ${rows.length} to approve`, 'Worked out from the review ratings.', cycleId)
    return { created: rows.length }
  },

  // ─── Kudos points ───────────────────────────────────────────────────────────────────────────────────────
  async points(u: AccessUser) {
    if (!u.employeeId) return { balance: 0, expiringSoon: 0, history: [], settings: await settingsOf(u.tenantId) }
    const [b, history, settings] = await Promise.all([pointsBalance(u.tenantId, u.employeeId), prisma.kudosPoint.findMany({ where: { tenantId: u.tenantId, employeeId: u.employeeId }, orderBy: { createdAt: 'desc' }, take: 50 }), settingsOf(u.tenantId)])
    return { ...b, history, settings }
  },
  async leaderboard(u: AccessUser) {
    const since = new Date(Date.now() - 90 * 86_400_000)
    const rows = await prisma.kudosPoint.groupBy({ by: ['employeeId'], where: { tenantId: u.tenantId, points: { gt: 0 }, createdAt: { gte: since } }, _sum: { points: true }, orderBy: { _sum: { points: 'desc' } }, take: 10 })
    const emps = await prisma.employee.findMany({ where: { tenantId: u.tenantId, id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, firstName: true, lastName: true } })
    return rows.map((r, i) => { const e = emps.find((x) => x.id === r.employeeId); return { rank: i + 1, employeeId: r.employeeId, name: e ? `${e.firstName} ${e.lastName}` : '', points: r._sum.points ?? 0 } })
  },
  async redeem(u: AccessUser, points: number) {
    if (!u.employeeId) throw new AppError('Only employees have points', 400)
    const s = await settingsOf(u.tenantId)
    if (points < s.minRedeem) throw new AppError(`Redeem at least ${s.minRedeem} points`, 400)
    const { balance } = await pointsBalance(u.tenantId, u.employeeId)
    if (points > balance) throw new AppError(`You have ${balance} points`, 400)
    const [type, tenant] = await Promise.all([typeByCode(u.tenantId, 'KUDOS', 'Kudos points', 'Kudos points redeemed for pay'), prisma.tenant.findUnique({ where: { id: u.tenantId }, select: { baseCurrency: true } })])
    const amount = round2(points * s.pointValue)
    const i = await prisma.incentive.create({ data: { tenantId: u.tenantId, employeeId: u.employeeId, typeId: type.id, amount, currency: tenant?.baseCurrency ?? 'USD', reason: `Redeemed ${points} kudos points`, nominatedByUserId: u.userId, formula: `${points} points × ${s.pointValue} per point`, formulaInputs: { points, pointValue: s.pointValue } } })
    await prisma.kudosPoint.create({ data: { tenantId: u.tenantId, employeeId: u.employeeId, points: -points, reason: 'Redeemed', incentiveId: i.id } })
    await audit(u, 'KUDOS_POINTS_REDEEMED', 'incentive', i.id, { points, amount })
    await tellHR(u, 'Kudos points to approve', `${points} points = ${amount.toLocaleString()} ${i.currency}`, i.id)
    return { incentiveId: i.id, amount }
  },
}

// Nominated, approved or paid amounts a manager has nominated in a period
async function usedBy(tenantId: string, userId: string, from: Date, to: Date) {
  const end = new Date(to.getTime() + 86_400_000)
  const rows = await prisma.incentive.findMany({ where: { tenantId, nominatedByUserId: userId, status: { in: ['nominated', 'approved', 'posted'] }, createdAt: { gte: from, lt: end } }, select: { amount: true, status: true } })
  return { used: round2(rows.reduce((a, r) => a + Number(r.amount), 0)), paid: round2(rows.filter((r) => r.status === 'posted').reduce((a, r) => a + Number(r.amount), 0)), count: rows.length }
}

// Called before a manager's nomination: refuses it over budget; after it, alerts at 80% and 100% once each
export async function checkBudget(u: AccessUser, amount: number) {
  if (has(u, 'hr_admin') || !u.employeeId) return null
  const today = new Date(`${day(new Date())}T00:00:00Z`)
  const b = await prisma.incentiveBudget.findFirst({ where: { tenantId: u.tenantId, managerEmployeeId: u.employeeId, periodStart: { lte: today }, periodEnd: { gte: today } } })
  if (!b) return null
  const { used } = await usedBy(u.tenantId, u.userId, b.periodStart, b.periodEnd)
  if (used + amount > Number(b.amount) + 0.001) throw new AppError(`That is over your incentive budget: ${round2(Number(b.amount) - used).toLocaleString()} left until ${day(b.periodEnd)}`, 400)
  return b
}
export async function budgetAlerts(u: AccessUser, budgetId: string) {
  const b = await prisma.incentiveBudget.findFirst({ where: { id: budgetId, tenantId: u.tenantId } })
  if (!b) return
  const { used } = await usedBy(u.tenantId, u.userId, b.periodStart, b.periodEnd)
  const pct = Number(b.amount) > 0 ? used / Number(b.amount) : 0
  for (const [level, col] of [[1, 'alerted100At'], [0.8, 'alerted80At']] as const) {
    if (pct < level || (b as any)[col]) continue
    const claimed = await prisma.incentiveBudget.updateMany({ where: { id: b.id, [col]: null }, data: { [col]: new Date() } })
    if (!claimed.count) break
    const hrs = await userIdsWithRole(u.tenantId, 'hr_admin')
    await notify({ tenantId: u.tenantId, userIds: [u.userId, ...hrs], type: 'incentive.budget_alert', title: level === 1 ? 'Incentive budget fully used' : 'Incentive budget 80% used', body: `${used.toLocaleString()} of ${Number(b.amount).toLocaleString()} used (${day(b.periodStart)} to ${day(b.periodEnd)})`, link: '/incentives', entityType: 'incentive_budget', entityId: b.id })
    break
  }
}

// Points earned that have not expired, minus redemptions taken from the oldest points first
export async function pointsBalance(tenantId: string, employeeId: string, now = new Date()) {
  const rows = await prisma.kudosPoint.findMany({ where: { tenantId, employeeId }, orderBy: { createdAt: 'asc' } })
  return balanceOf(rows, now)
}
export function balanceOf(rows: { points: number; expiresAt: Date | null; createdAt: Date }[], now: Date) {
  const lots = rows.filter((r) => r.points > 0).map((r) => ({ left: r.points, expiresAt: r.expiresAt }))
  for (const r of rows.filter((x) => x.points < 0)) {
    let need = -r.points
    // A redemption uses the oldest lots that were still valid when it happened
    for (const l of lots) { if (!need) break; if (l.expiresAt && l.expiresAt <= r.createdAt) continue; const take = Math.min(l.left, need); l.left -= take; need -= take }
  }
  const live = lots.filter((l) => !l.expiresAt || l.expiresAt > now)
  const soon = new Date(now.getTime() + 30 * 86_400_000)
  return { balance: live.reduce((a, l) => a + l.left, 0), expiringSoon: live.filter((l) => l.expiresAt && l.expiresAt <= soon).reduce((a, l) => a + l.left, 0) }
}

// Points convert to pay, so a giver earns someone points at most once per 30 days (no farming by thanking each other)
export async function awardKudosPoints(tenantId: string, kudosId: string, toEmployeeId: string) {
  const s = await settingsOf(tenantId)
  if (s.kudosPoints <= 0) return
  const k = await prisma.kudos.findFirst({ where: { id: kudosId, tenantId } })
  if (!k) return
  const recent = await prisma.kudos.findMany({ where: { tenantId, fromUserId: k.fromUserId, toEmployeeId, id: { not: k.id }, createdAt: { gte: new Date(k.createdAt.getTime() - 30 * 86_400_000) } }, select: { id: true } })
  if (recent.length && (await prisma.kudosPoint.count({ where: { tenantId, kudosId: { in: recent.map((r) => r.id) } } }))) return
  const expiresAt = s.pointsExpireMonths > 0 ? new Date(Date.now() + s.pointsExpireMonths * 30.44 * 86_400_000) : null
  await prisma.kudosPoint.create({ data: { tenantId, employeeId: toEmployeeId, points: s.kudosPoints, reason: 'Kudos received', kudosId, expiresAt } }).catch(() => null)
}

if (require.main === module) {
  const d = (s: string) => new Date(`${s}T00:00:00Z`)
  const rows = [
    { points: 10, expiresAt: d('2026-03-01'), createdAt: d('2025-03-01') },
    { points: 10, expiresAt: d('2027-01-01'), createdAt: d('2026-01-01') },
    { points: -5, expiresAt: null, createdAt: d('2026-02-01') }, // takes 5 from the first lot (still valid then)
  ]
  const b = balanceOf(rows, d('2026-06-01'))
  console.assert(b.balance === 10, 'first lot expired with 5 left; second lot whole', b)
  console.assert(balanceOf(rows, d('2026-02-15')).balance === 15, 'before expiry: 20 - 5')
  console.log('points ok')
}

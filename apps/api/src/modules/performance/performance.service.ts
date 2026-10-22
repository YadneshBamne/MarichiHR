import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, isReportingChainOf } from '../../shared/utils/access'
import { businessToday } from '../../shared/utils/businessDate'

// Goals and appraisal. A manager (anyone above the person in the reporting line, with the Manager role) or HR sets a
// goal with up to 5 weighted KPIs in a quarterly or yearly cycle; the person accepts it or sends it back; at review the
// manager records what was achieved per KPI and the weighted result is the % of the expectation met, with a rating.

const round1 = (n: number) => Math.round(n * 10) / 10
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const isHR = (u: AccessUser) => u.roleIds.includes('hr_admin')

// Each KPI counts up to 150% of its target so one runaway number can't hide the rest
export function scoreOf(kpis: { target: number; weight: number; achieved: number | null }[]) {
  const total = kpis.reduce((s, k) => s + k.weight, 0) || 1
  return round1(kpis.reduce((s, k) => s + (k.weight / total) * Math.min(1.5, Math.max(0, (k.achieved ?? 0) / (k.target || 1))) * 100, 0))
}
export const ratingOf = (score: number) => (score >= 110 ? 'Exceeds expectations' : score >= 90 ? 'Meets expectations' : score >= 70 ? 'Partly meets expectations' : 'Below expectations')

export const Kpi = z.object({ name: z.string().trim().min(2).max(120), target: z.number().positive().max(1e12), unit: z.string().trim().max(30).optional(), weight: z.number().positive().max(100) }).strict()
export const GoalBody = z.object({
  cycleId: z.string().uuid(),
  employeeId: z.string().uuid(),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(2000).optional(),
  kpis: z.array(Kpi).min(1).max(5).refine((k) => Math.abs(k.reduce((s, x) => s + x.weight, 0) - 100) < 0.01, 'KPI weights must add up to 100'),
  send: z.boolean().default(false),
}).strict()
export type GoalInput = z.infer<typeof GoalBody>

const include = { kpis: { orderBy: { sequence: 'asc' as const } }, cycle: { select: { id: true, name: true, period: true, startDate: true, endDate: true, status: true } } }

async function canManage(user: AccessUser, employeeId: string) {
  if (isHR(user)) return true
  if (!user.employeeId || user.employeeId === employeeId || !user.roleIds.includes('manager')) return false
  return isReportingChainOf(user.employeeId, employeeId)
}

async function load(user: AccessUser, id: string) {
  const g = await prisma.performanceGoal.findFirst({ where: { id, tenantId: user.tenantId }, include })
  if (!g) throw new AppError('Goal not found', 404)
  const own = g.employeeId === user.employeeId
  const manages = !own && (await canManage(user, g.employeeId))
  if (!own && !manages) throw new AppError('Goal not found', 404)
  return { g, own, manages }
}

async function tell(tenantId: string, employeeId: string | null | undefined, userId: string | null | undefined, type: string, title: string, body: string, goalId: string) {
  const uid = userId ?? (await userIdOfEmployee(tenantId, employeeId))
  if (uid) await notify({ tenantId, userIds: [uid], type, title, body, link: '/performance', entityType: 'performance_goal', entityId: goalId, eventId: `${type}:${goalId}:${Date.now()}` })
}

const audit = (user: AccessUser, action: string, id: string, newValue?: object) =>
  prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action, entityType: 'performance_goal', entityId: id, newValue: newValue as any } })

const shape = (g: any, names: Map<string, string>) => ({
  ...g, employee: names.get(g.employeeId) ?? null, setBy: g.setByEmployeeId ? names.get(g.setByEmployeeId) ?? null : null,
  cycle: g.cycle ? { ...g.cycle, startDate: ymd(g.cycle.startDate), endDate: ymd(g.cycle.endDate) } : null,
})
async function names(tenantId: string, ids: (string | null)[]) {
  const rows = await prisma.employee.findMany({ where: { tenantId, id: { in: ids.filter(Boolean) as string[] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
  return new Map(rows.map((r) => [r.id, `${r.firstName} ${r.lastName} (${r.employeeCode})`]))
}

export const performanceService = {
  // ─── Cycles ────────────────────────────────────────────────
  async cycles(user: AccessUser) {
    const rows = await prisma.performanceCycle.findMany({ where: { tenantId: user.tenantId }, orderBy: [{ startDate: 'desc' }, { period: 'asc' }], include: { _count: { select: { goals: true } } } })
    return rows.map((c) => ({ ...c, startDate: ymd(c.startDate), endDate: ymd(c.endDate), goals: c._count.goals }))
  },
  async createCycle(user: AccessUser, body: { name: string; period: 'quarterly' | 'yearly'; startDate: string; endDate: string }) {
    if (!isHR(user)) throw new AppError('Only HR sets up review cycles', 403)
    if (body.endDate <= body.startDate) throw new AppError('The cycle must end after it starts', 400)
    if (await prisma.performanceCycle.findFirst({ where: { tenantId: user.tenantId, name: body.name } })) throw new AppError('A cycle with that name exists', 409)
    return prisma.performanceCycle.create({ data: { tenantId: user.tenantId, name: body.name, period: body.period, startDate: new Date(`${body.startDate}T00:00:00Z`), endDate: new Date(`${body.endDate}T00:00:00Z`), createdBy: user.userId } })
  },
  // This year's four quarters and the full year, in one click (skips any that exist)
  async createYear(user: AccessUser) {
    if (!isHR(user)) throw new AppError('Only HR sets up review cycles', 403)
    const y = (await businessToday(user.tenantId)).getUTCFullYear()
    const want = [
      ...[1, 2, 3, 4].map((q) => ({ name: `Q${q} ${y}`, period: 'quarterly', startDate: new Date(Date.UTC(y, (q - 1) * 3, 1)), endDate: new Date(Date.UTC(y, q * 3, 0)) })),
      { name: `Year ${y}`, period: 'yearly', startDate: new Date(Date.UTC(y, 0, 1)), endDate: new Date(Date.UTC(y, 11, 31)) },
    ]
    const have = new Set((await prisma.performanceCycle.findMany({ where: { tenantId: user.tenantId, name: { in: want.map((w) => w.name) } }, select: { name: true } })).map((c) => c.name))
    const fresh = want.filter((w) => !have.has(w.name))
    if (fresh.length) await prisma.performanceCycle.createMany({ data: fresh.map((w) => ({ ...w, tenantId: user.tenantId, createdBy: user.userId })) })
    return { created: fresh.length }
  },
  async setCycleStatus(user: AccessUser, id: string, status: 'open' | 'closed') {
    if (!isHR(user)) throw new AppError('Only HR closes review cycles', 403)
    const r = await prisma.performanceCycle.updateMany({ where: { id, tenantId: user.tenantId }, data: { status } })
    if (!r.count) throw new AppError('Cycle not found', 404)
    return { status }
  },

  // ─── Goals ─────────────────────────────────────────────────
  // mine: my own goals · team: people below me · all: everyone (HR)
  async list(user: AccessUser, scope: 'mine' | 'team' | 'all', cycleId?: string) {
    let where: any = { tenantId: user.tenantId, ...(cycleId && { cycleId }) }
    if (scope === 'mine') where.employeeId = user.employeeId ?? '-'
    else if (scope === 'all') { if (!isHR(user)) throw new AppError('Only HR sees every goal', 403) }
    else {
      if (!user.employeeId) return []
      const below = await prisma.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE t AS (SELECT id FROM employees WHERE "managerId" = ${user.employeeId} AND "tenantId" = ${user.tenantId}
          UNION SELECT e.id FROM employees e JOIN t ON e."managerId" = t.id WHERE e."tenantId" = ${user.tenantId}) SELECT id FROM t`
      where.employeeId = { in: below.map((b) => b.id) }
    }
    const rows = await prisma.performanceGoal.findMany({ where, include, orderBy: [{ updatedAt: 'desc' }] })
    const n = await names(user.tenantId, rows.flatMap((g) => [g.employeeId, g.setByEmployeeId]))
    return rows.map((g) => shape(g, n))
  },

  async create(user: AccessUser, body: GoalInput) {
    const [cycle, emp] = await Promise.all([
      prisma.performanceCycle.findFirst({ where: { id: body.cycleId, tenantId: user.tenantId } }),
      prisma.employee.findFirst({ where: { id: body.employeeId, tenantId: user.tenantId, active: true }, select: { id: true, firstName: true } }),
    ])
    if (!cycle) throw new AppError('Review cycle not found', 404)
    if (cycle.status !== 'open') throw new AppError('That review cycle is closed', 400)
    if (!emp) throw new AppError('Employee not found', 404)
    if (!(await canManage(user, emp.id))) throw new AppError('You can set goals only for people in your team', 403)
    const g = await prisma.performanceGoal.create({
      data: {
        tenantId: user.tenantId, cycleId: cycle.id, employeeId: emp.id, setByUserId: user.userId, setByEmployeeId: user.employeeId ?? null,
        title: body.title, description: body.description ?? null, status: body.send ? 'sent' : 'draft', sentAt: body.send ? new Date() : null,
        kpis: { create: body.kpis.map((k, i) => ({ name: k.name, target: k.target, unit: k.unit ?? null, weight: k.weight, sequence: i })) },
      },
      include,
    })
    await audit(user, 'GOAL_CREATED', g.id, { title: g.title, employeeId: emp.id, cycle: cycle.name, sent: body.send })
    if (body.send) await tell(user.tenantId, emp.id, null, 'performance.goal.sent', `New goal: ${g.title}`, `${cycle.name}: please review and accept it, or send it back with a note.`, g.id)
    return g
  },

  async update(user: AccessUser, id: string, body: Omit<GoalInput, 'employeeId' | 'cycleId'>) {
    const { g, manages } = await load(user, id)
    if (!manages) throw new AppError('Only the manager who sets the goal can change it', 403)
    if (!['draft', 'returned'].includes(g.status)) throw new AppError(`A goal that is ${g.status} cannot be changed`, 400)
    await prisma.$transaction([
      prisma.performanceKpi.deleteMany({ where: { goalId: id } }),
      prisma.performanceGoal.update({ where: { id }, data: { title: body.title, description: body.description ?? null, kpis: { create: body.kpis.map((k, i) => ({ name: k.name, target: k.target, unit: k.unit ?? null, weight: k.weight, sequence: i })) }, ...(body.send && { status: 'sent', sentAt: new Date(), returnNote: null }) } }),
    ])
    await audit(user, 'GOAL_UPDATED', id, { title: body.title, sent: body.send })
    if (body.send) await tell(user.tenantId, g.employeeId, null, 'performance.goal.sent', `Goal updated: ${body.title}`, 'Please review and accept it, or send it back with a note.', id)
    return (await load(user, id)).g
  },

  async send(user: AccessUser, id: string) {
    const { g, manages } = await load(user, id)
    if (!manages) throw new AppError('Only the manager can send this goal', 403)
    const r = await prisma.performanceGoal.updateMany({ where: { id, status: { in: ['draft', 'returned'] } }, data: { status: 'sent', sentAt: new Date(), returnNote: null } })
    if (!r.count) throw new AppError(`A goal that is ${g.status} cannot be sent`, 400)
    await tell(user.tenantId, g.employeeId, null, 'performance.goal.sent', `New goal: ${g.title}`, `${g.cycle.name}: please review and accept it, or send it back with a note.`, id)
    return { status: 'sent' }
  },

  // The person agrees to the goal, or sends it back with what should change
  async respond(user: AccessUser, id: string, accept: boolean, note?: string) {
    const { g, own } = await load(user, id)
    if (!own) throw new AppError('Only the person the goal is for can accept it', 403)
    if (!accept && !note?.trim()) throw new AppError('Say what should change', 400)
    const r = await prisma.performanceGoal.updateMany({ where: { id, status: 'sent' }, data: accept ? { status: 'accepted', acceptedAt: new Date() } : { status: 'returned', returnNote: note!.trim() } })
    if (!r.count) throw new AppError(`This goal is ${g.status}, not waiting for you`, 400)
    await audit(user, accept ? 'GOAL_ACCEPTED' : 'GOAL_RETURNED', id, accept ? undefined : { note })
    await tell(user.tenantId, null, g.setByUserId, accept ? 'performance.goal.accepted' : 'performance.goal.returned', `${accept ? 'Goal accepted' : 'Goal sent back'}: ${g.title}`, accept ? 'The goal is agreed.' : `Note: ${note}`, id)
    return { status: accept ? 'accepted' : 'returned' }
  },

  // The manager records what was achieved per KPI; the weighted result is the % of the expectation met
  async review(user: AccessUser, id: string, body: { achieved: Record<string, number>; comment?: string }) {
    const { g, manages } = await load(user, id)
    if (!manages) throw new AppError('Only the manager can review this goal', 403)
    if (!['accepted', 'reviewed'].includes(g.status)) throw new AppError('A goal can be reviewed once the person has accepted it', 400)
    for (const k of g.kpis) if (!(k.id in body.achieved)) throw new AppError(`Enter what was achieved for "${k.name}"`, 400)
    const kpis = g.kpis.map((k) => ({ ...k, achieved: body.achieved[k.id] }))
    const score = scoreOf(kpis)
    const rating = ratingOf(score)
    await prisma.$transaction([
      ...kpis.map((k) => prisma.performanceKpi.update({ where: { id: k.id }, data: { achieved: k.achieved } })),
      prisma.performanceGoal.update({ where: { id }, data: { status: 'reviewed', score, rating, managerComment: body.comment?.trim() || null, reviewedAt: new Date(), reviewedBy: user.userId, acknowledgedAt: null } }),
    ])
    await audit(user, 'GOAL_REVIEWED', id, { score, rating })
    await tell(user.tenantId, g.employeeId, null, 'performance.goal.reviewed', `Review: ${g.title}`, `${score}% of the expectation met · ${rating}. Open it to acknowledge.`, id)
    return { score, rating }
  },

  async acknowledge(user: AccessUser, id: string, comment?: string) {
    const { g, own } = await load(user, id)
    if (!own) throw new AppError('Only the person reviewed can acknowledge', 403)
    const r = await prisma.performanceGoal.updateMany({ where: { id, status: 'reviewed' }, data: { status: 'acknowledged', acknowledgedAt: new Date(), employeeComment: comment?.trim() || null } })
    if (!r.count) throw new AppError('Nothing to acknowledge yet', 400)
    await audit(user, 'GOAL_ACKNOWLEDGED', id)
    await tell(user.tenantId, null, g.setByUserId, 'performance.goal.acknowledged', `Review acknowledged: ${g.title}`, comment ? `Comment: ${comment}` : 'The person has seen their review.', id)
    return { status: 'acknowledged' }
  },
}

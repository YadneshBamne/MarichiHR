import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { requireFeature } from '../../middleware/module.middleware.mongo'
import { tenantHasFeature } from '../../middleware/module.middleware.mongo'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { isReportingChainOf, getReportingSubtreeIds } from '../../shared/utils/access'
import { Employee, User, AuditLog, AppraisalCompetency, AppraisalCycle, Appraisal, PeerFeedback, ImprovementPlan } from '../../infrastructure/mongo/mongo'
import { notify, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { ratingOf } from './performance.service'

// Advanced performance management (MongoDB mode only), on top of goals and KPI appraisal:
//  - competency frameworks and review cycles with a rating scale and a goals/competencies weighting;
//  - self appraisal, then the manager's appraisal with a potential rating;
//  - 360-degree feedback from peers (anonymous: the person reviewed never sees who said what);
//  - HR calibration with a reason, the rating distribution and a 9-box grid;
//  - publishing results, acknowledgement, and improvement plans.
// Employees see their own self appraisal always, and the manager's rating and final result only after HR publishes the cycle.
export const appraisalRouter = Router()
appraisalRouter.use(authenticate, requireFeature('pmsAdvanced'))

const isHR = (roleIds: string[]) => roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }
const hrOnly = (req: any) => { if (!isHR(req.user.roleIds)) throw new AppError('Only HR can do this', 403) }
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data })
const id = z.object({ id: z.string().uuid() })
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const r1 = (n: number) => Math.round(n * 10) / 10
const uuid = () => crypto.randomUUID()
const MIN_PEERS = 3 // peer comments and averages are shown only once this many have answered, so nobody can be identified
const MAX_PEERS = 5
const col = (n: string) => mongoose.connection.collection(n)
const todayYmd = () => new Date().toISOString().slice(0, 10)

const DEFAULT_COMPETENCIES = [
  ['Communication', 'Shares information clearly and listens'], ['Ownership', 'Takes responsibility and follows through'], ['Collaboration', 'Works well with others across the team'],
  ['Problem solving', 'Finds practical solutions and learns from mistakes'], ['Customer focus', 'Understands and serves internal and external customers'], ['Leadership', 'Guides, develops and inspires others'],
]
async function competencies(tenantId: string) {
  let rows: any[] = await AppraisalCompetency.find({ tenantId }).sort({ name: 1 }).lean()
  if (!rows.length) {
    await AppraisalCompetency.insertMany(DEFAULT_COMPETENCIES.map(([name, description]) => ({ _id: uuid(), tenantId, name, description, active: true })), { ordered: false }).catch(() => undefined)
    rows = await AppraisalCompetency.find({ tenantId }).sort({ name: 1 }).lean()
  }
  return rows
}
// In-app and, by the person's settings, email (notify keeps both)
async function tell(tenantId: string, employeeId: string | null | undefined, type: string, title: string, body: string) {
  const userId = await userIdOfEmployee(tenantId, employeeId)
  if (userId) await notify({ tenantId, userIds: [userId], type, title, body, link: '/appraisals', eventId: `${type}:${employeeId}:${uuid()}` }).catch(() => undefined)
}
const audit = (req: any, action: string, entityType: string, entityId: string, newValue?: object) => AuditLog.create({ tenantId: req.user.tenantId, userId: req.user.userId, action, entityType, entityId, newValue })
async function names(ids: (string | null | undefined)[]) {
  const rows: any[] = await Employee.find({ _id: { $in: ids.filter(Boolean) as string[] } }).select('firstName lastName employeeCode').lean()
  return new Map(rows.map((e) => [e._id as string, `${e.firstName} ${e.lastName}`]))
}

// Nobody reviews or calibrates their own appraisal. Another HR admin or a system admin does it; only when there is nobody else
// can a system admin handle their own.
async function ownRuleMessage(req: any, subjectEmployeeId: string): Promise<string | null> {
  if (!req.user.employeeId || req.user.employeeId !== subjectEmployeeId) return null
  const others = await User.countDocuments({ tenantId: req.user.tenantId, active: true, _id: { $ne: req.user.userId }, userRoles: { $elemMatch: { roleName: { $in: ['hr_admin', 'system_admin'] } } } })
  if (others > 0) return 'You cannot review or calibrate your own appraisal. Another HR admin or a system admin does it.'
  return req.user.roleIds.includes('system_admin') ? null : 'You cannot review or calibrate your own appraisal. Ask a system admin.'
}

// Score scale (version 2). Competency ratings are put on the same scale as the rating bands (Exceeds from 110, Meets from 90, Partly meets from 70):
// the lowest rating counts as 40% and the top rating as 120%, in a straight line. On a 1 to 5 scale: 5 = 120%, 4 = 100%, 3 = 80%, 2 = 60%, 1 = 40%.
// So a perfect appraisal can be "Exceeds expectations", and 4 out of 5 is "Meets". The goals half keeps its own scale (0 to 150% of target).
// Appraisals already published keep the scores they were published with: scores are only worked out again until publishing.
export const SCALE_VERSION = 2
export const competencyPct = (avgRating: number, scaleMax: number) => r1(40 + ((avgRating - 1) / (scaleMax - 1)) * 80)

// Final score: goals (the person's reviewed goals: those of the goal cycle the cycle is linked to, else those reviewed during the cycle) and
// competencies (the manager's ratings), weighted per cycle
export async function computeScores(a: any, cycle: any) {
  const ratings = (a.manager?.ratings ?? {}) as Record<string, number>
  const comp = Object.keys(ratings).length ? competencyPct(Object.values(ratings).reduce((s, n) => s + n, 0) / Object.keys(ratings).length, cycle.scaleMax) : null
  const find: any = cycle.goalCycleId
    ? { tenantId: a.tenantId, employeeId: a.employeeId, cycleId: cycle.goalCycleId, status: { $in: ['reviewed', 'acknowledged'] } }
    : { tenantId: a.tenantId, employeeId: a.employeeId, status: { $in: ['reviewed', 'acknowledged'] }, reviewedAt: { $gte: cycle.startDate, $lte: new Date(cycle.endDate.getTime() + 86400000) } }
  const goals: any[] = await col('performance_goals').find(find).toArray()
  const goalScore = goals.length ? r1(goals.reduce((s, g) => s + (g.score ?? 0), 0) / goals.length) : null
  let computed: number | null = null
  if (comp != null) computed = goalScore == null ? comp : r1((goalScore * cycle.goalsWeight + comp * (100 - cycle.goalsWeight)) / 100)
  return { competencyScore: comp, goalScore, computed, scaleVersion: SCALE_VERSION }
}
const finalOf = (a: any) => (a.calibration?.finalScore ?? a.scores?.computed ?? null) as number | null

// Scores are worked out again until the result is published: when goals change, when calibration opens, at each calibration and at publishing
async function recompute(a: any, cycle: any) {
  if (a.status !== 'manager_submitted' || !a.manager?.ratings) return
  await Appraisal.updateOne({ _id: a._id, status: 'manager_submitted' }, { $set: { scores: await computeScores(a, cycle) } })
}
export async function recomputeForEmployee(tenantId: string, employeeId: string) {
  const rows: any[] = await Appraisal.find({ tenantId, employeeId, status: 'manager_submitted' }).lean()
  for (const a of rows) {
    const cycle: any = await AppraisalCycle.findOne({ _id: a.cycleId, tenantId, status: { $in: ['active', 'calibration'] } }).lean()
    if (cycle) await recompute(a, cycle)
  }
}

// Names only, so people can pick peers and managers can pick who a plan is for (the full directory stays with HR and managers)
appraisalRouter.get('/people', validate(z.object({ query: z.object({ q: z.string().trim().min(2).max(40) }) })), asyncHandler(async (req, res) => {
  const q = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rows: any[] = await Employee.find({ tenantId: req.user!.tenantId, active: true, employmentStatus: { $ne: 'terminated' }, $or: [{ firstName: new RegExp(q, 'i') }, { lastName: new RegExp(q, 'i') }] }).select('firstName lastName employeeCode').limit(15).lean()
  ok(res, rows.map((e) => ({ id: e._id, name: `${e.firstName} ${e.lastName}`, code: e.employeeCode })))
}))

// ─── Competencies and cycles (HR) ───
appraisalRouter.get('/competencies', asyncHandler(async (req, res) => ok(res, (await competencies(req.user!.tenantId)).map(ser))))
appraisalRouter.post('/competencies', validate(z.object({ body: z.object({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(200).optional() }).strict() })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const c: any = await AppraisalCompetency.create({ _id: uuid(), tenantId: req.user!.tenantId, ...req.body, active: true }).catch((e) => { throw e?.code === 11000 ? new AppError('That competency exists', 409) : e })
  ok(res, ser(c.toObject()), 201)
}))
appraisalRouter.patch('/competencies/:id', validate(z.object({ params: id, body: z.object({ active: z.boolean() }).strict() })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const r = await AppraisalCompetency.updateOne({ _id: req.params.id, tenantId: req.user!.tenantId }, { $set: { active: req.body.active } })
  if (!r.matchedCount) throw new AppError('Competency not found', 404)
  ok(res, { active: req.body.active })
}))

// The goal cycles (quarters, years) a review cycle can count the goals of
appraisalRouter.get('/goal-cycles', asyncHandler(async (req, res) => {
  const rows: any[] = await col('performance_cycles').find({ tenantId: req.user!.tenantId } as any).sort({ startDate: -1 }).limit(100).toArray()
  ok(res, rows.map((c) => ({ id: c._id, name: c.name, status: c.status, startDate: c.startDate, endDate: c.endDate })))
}))

appraisalRouter.get('/cycles', asyncHandler(async (req, res) => {
  const { tenantId, roleIds } = req.user!
  const rows: any[] = await AppraisalCycle.find({ tenantId }).sort({ startDate: -1 }).lean()
  const counts: any[] = await Appraisal.aggregate([{ $match: { tenantId, status: { $ne: 'excluded' } } }, { $group: { _id: '$cycleId', n: { $sum: 1 } } }])
  const n = new Map(counts.map((c) => [c._id, c.n]))
  const gc = new Map(((await col('performance_cycles').find({ _id: { $in: rows.map((c) => c.goalCycleId).filter(Boolean) } } as any).toArray()) as any[]).map((c) => [String(c._id), c.name]))
  ok(res, rows.filter((c) => isHR(roleIds) || c.status !== 'draft').map((c) => ({ ...ser(c), participants: n.get(c._id) ?? 0, goalCycleName: c.goalCycleId ? gc.get(c.goalCycleId) ?? null : null })))
}))
const CycleBody = z.object({
  name: z.string().trim().min(2).max(60), startDate: date, endDate: date, scaleMax: z.number().int().min(3).max(10).default(5), goalsWeight: z.number().min(0).max(100).default(50),
  competencyIds: z.array(z.string().uuid()).min(1).max(15), peerReview: z.boolean().default(true), goalCycleId: z.string().uuid().optional(),
}).strict()
appraisalRouter.post('/cycles', validate(z.object({ body: CycleBody })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { tenantId } = req.user!
  const b = req.body as z.infer<typeof CycleBody>
  if (b.endDate <= b.startDate) throw new AppError('The cycle must end after it starts', 400)
  if (await AppraisalCycle.exists({ tenantId, name: b.name })) throw new AppError('A cycle with that name exists', 409)
  if ((await AppraisalCompetency.countDocuments({ tenantId, active: true, _id: { $in: b.competencyIds } })) !== b.competencyIds.length) throw new AppError('Competency not found', 404)
  // the goal cycle whose goals this review counts: the one chosen, else the only open one
  let goalCycleId = b.goalCycleId ?? null
  if (goalCycleId) { if (!(await col('performance_cycles').findOne({ _id: goalCycleId, tenantId } as any))) throw new AppError('Goal cycle not found', 404) }
  else { const open: any[] = await col('performance_cycles').find({ tenantId, status: 'open' } as any).limit(2).toArray(); if (open.length === 1) goalCycleId = open[0]._id }
  const c: any = await AppraisalCycle.create({ _id: uuid(), tenantId, ...b, goalCycleId, startDate: new Date(`${b.startDate}T00:00:00Z`), endDate: new Date(`${b.endDate}T00:00:00Z`), status: 'draft', createdBy: req.user!.userId })
  await audit(req, 'APPRAISAL_CYCLE_CREATED', 'appraisal_cycle', c._id, { name: b.name, goalCycleId })
  ok(res, ser(c.toObject()), 201)
}))

// Launch: every chosen (or every active) employee gets an appraisal with their manager at that moment.
// The cycle is claimed first (draft -> launching), so two quick clicks give one launch and a clean message for the second.
appraisalRouter.post('/cycles/:id/launch', validate(z.object({ params: id, body: z.object({ employeeIds: z.array(z.string().uuid()).max(5000).optional() }).strict() })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { tenantId } = req.user!
  const cycle: any = await AppraisalCycle.findOne({ _id: req.params.id, tenantId }).lean()
  if (!cycle) throw new AppError('Cycle not found', 404)
  const claimed = await AppraisalCycle.findOneAndUpdate({ _id: cycle._id, tenantId, status: 'draft' }, { $set: { status: 'launching' } }).lean()
  if (!claimed) throw new AppError('This cycle was already launched (or is being launched right now).', 409)
  const revert = () => AppraisalCycle.updateOne({ _id: cycle._id, status: 'launching' }, { $set: { status: 'draft' } })
  let emps: any[] = []
  try {
    emps = await Employee.find({ tenantId, active: true, employmentStatus: { $ne: 'terminated' }, ...(req.body.employeeIds && { _id: { $in: req.body.employeeIds } }) }).select('managerId').lean()
    if (!emps.length) { await revert(); throw new AppError('There is nobody to review', 400) }
    await Appraisal.insertMany(emps.map((e) => ({ _id: uuid(), tenantId, cycleId: cycle._id, employeeId: e._id, managerEmployeeId: e.managerId ?? null, status: 'pending_self', peers: [] })), { ordered: false })
    await AppraisalCycle.updateOne({ _id: cycle._id, status: 'launching' }, { $set: { status: 'active', launchedAt: new Date() } })
  } catch (e: any) {
    if (!(e instanceof AppError)) { await Appraisal.deleteMany({ tenantId, cycleId: cycle._id }); await revert() } // nothing half-launched
    throw e
  }
  await audit(req, 'APPRAISAL_CYCLE_LAUNCHED', 'appraisal_cycle', cycle._id, { participants: emps.length })
  for (const e of emps) await tell(tenantId, e._id, 'appraisal.started', `${cycle.name}: your self appraisal is open`, 'Rate yourself on each competency and choose your 3 to 5 peer reviewers.')
  ok(res, { participants: emps.length })
}))

// HR adds a late joiner to a running cycle
appraisalRouter.post('/cycles/:id/participants', validate(z.object({ params: id, body: z.object({ employeeIds: z.array(z.string().uuid()).min(1).max(200) }).strict() })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { tenantId } = req.user!
  const cycle: any = await AppraisalCycle.findOne({ _id: req.params.id, tenantId }).lean()
  if (!cycle) throw new AppError('Cycle not found', 404)
  if (cycle.status !== 'active') throw new AppError('People can be added while the cycle is open', 400)
  const have = new Set(((await Appraisal.find({ tenantId, cycleId: cycle._id }).select('employeeId').lean()) as any[]).map((x) => x.employeeId))
  const emps: any[] = await Employee.find({ tenantId, active: true, employmentStatus: { $ne: 'terminated' }, _id: { $in: (req.body.employeeIds as string[]).filter((e) => !have.has(e)) } }).select('managerId').lean()
  if (!emps.length) throw new AppError('Everyone you chose is already in this cycle (or cannot be added)', 400)
  await Appraisal.insertMany(emps.map((e) => ({ _id: uuid(), tenantId, cycleId: cycle._id, employeeId: e._id, managerEmployeeId: e.managerId ?? null, status: 'pending_self', peers: [], addedLate: true })), { ordered: false })
  await audit(req, 'APPRAISAL_PARTICIPANTS_ADDED', 'appraisal_cycle', cycle._id, { added: emps.length })
  for (const e of emps) await tell(tenantId, e._id, 'appraisal.started', `${cycle.name}: your self appraisal is open`, 'Rate yourself on each competency and choose your 3 to 5 peer reviewers.')
  ok(res, { added: emps.length }, 201)
}))

const NEXT: Record<string, string[]> = { active: ['calibration'], calibration: ['active', 'published'], published: ['closed'] }
appraisalRouter.post('/cycles/:id/status', validate(z.object({ params: id, body: z.object({ status: z.enum(['active', 'calibration', 'published', 'closed']) }).strict() })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { tenantId } = req.user!
  const cycle: any = await AppraisalCycle.findOne({ _id: req.params.id, tenantId }).lean()
  if (!cycle) throw new AppError('Cycle not found', 404)
  if (!(NEXT[cycle.status] ?? []).includes(req.body.status)) throw new AppError(`A ${cycle.status} cycle cannot move to ${req.body.status}`, 400)
  if (req.body.status === 'published') {
    // Anyone whose manager has not reviewed yet would have nothing to publish (HR can remove a leaver, or write the review without the self appraisal)
    const open = await Appraisal.countDocuments({ tenantId, cycleId: cycle._id, status: { $in: ['pending_self', 'self_submitted'] } })
    if (open) throw new AppError(`${open} appraisal${open === 1 ? ' is' : 's are'} still waiting for the manager's review. HR can remove someone from the cycle or write the review without the self appraisal.`, 409)
  }
  // the scores are worked out once more when calibration opens and just before publishing, so they match the goals as they stand
  if (['calibration', 'published'].includes(req.body.status)) for (const a of (await Appraisal.find({ tenantId, cycleId: cycle._id, status: 'manager_submitted' }).lean()) as any[]) await recompute(a, cycle)
  if (req.body.status === 'published') {
    await Appraisal.updateMany({ tenantId, cycleId: cycle._id, status: 'manager_submitted' }, { $set: { status: 'published', publishedAt: new Date() } })
    const rows: any[] = await Appraisal.find({ tenantId, cycleId: cycle._id, status: 'published' }).select('employeeId').lean()
    for (const a of rows) await tell(tenantId, a.employeeId, 'appraisal.published', `${cycle.name}: your result is ready`, 'Open it to read your manager\'s review and acknowledge it.')
  }
  await AppraisalCycle.updateOne({ _id: cycle._id }, { $set: { status: req.body.status } })
  await audit(req, 'APPRAISAL_CYCLE_STATUS', 'appraisal_cycle', cycle._id, { from: cycle.status, to: req.body.status })
  ok(res, { status: req.body.status })
}))

// ─── Appraisals ───
// What this person may see of an appraisal: their own self section always; the manager's section, scores and 360 only once published
async function access(req: any, a: any) {
  const { employeeId, roleIds } = req.user
  const own = a.employeeId === employeeId
  const hr = isHR(roleIds)
  const manager = !own && !hr && !!employeeId && (a.managerEmployeeId === employeeId || (roleIds.includes('manager') && (await isReportingChainOf(employeeId, a.employeeId))))
  if (!own && !hr && !manager) throw new AppError('Appraisal not found', 404)
  return { own, hr, manager }
}
async function loadA(req: any, aid: string) {
  const a: any = await Appraisal.findOne({ _id: aid, tenantId: req.user.tenantId }).lean()
  if (!a) throw new AppError('Appraisal not found', 404)
  const cycle: any = await AppraisalCycle.findOne({ _id: a.cycleId, tenantId: req.user.tenantId }).lean()
  return { a, cycle, who: await access(req, a) }
}
const isPublished = (a: any) => ['published', 'acknowledged'].includes(a.status)

// 360 results. The person reviewed sees only counts until the result is published, then the averages and the comments as HR left them.
// Comments come in an order that is stable for each viewer (not by who answered first). HR can hide or edit a comment that names its writer.
const peersView = async (a: any, who: { own: boolean; hr: boolean }, req: any) => {
  const reqs: any[] = (await PeerFeedback.find({ appraisalId: a._id }).lean()).filter((r: any) => r.status !== 'cancelled')
  const done = reqs.filter((r) => r.status === 'submitted')
  const total = reqs.length
  if (who.own && !isPublished(a)) return { requested: total, answered: done.length, minimum: MIN_PEERS }
  const cycle: any = await AppraisalCycle.findById(a.cycleId).lean()
  const comps: any[] = await AppraisalCompetency.find({ _id: { $in: cycle.competencyIds } }).lean()
  const enough = done.length >= MIN_PEERS
  const averages = enough ? Object.fromEntries(comps.map((c) => [c._id, r1(done.reduce((s, r) => s + (r.ratings?.[c._id] ?? 0), 0) / done.length)])) : null
  const order = (rid: string) => crypto.createHash('sha1').update(`${a._id}:${req.user.userId}:${rid}`).digest('hex')
  const shown = (r: any): string | null => (r.moderation?.hidden ? null : (r.moderation?.text ?? r.comment ?? null))
  const sorted = [...done].sort((x, y) => (order(x._id) < order(y._id) ? -1 : 1))
  const out: any = { requested: total, answered: done.length, minimum: MIN_PEERS, averages, comments: enough ? sorted.map(shown).filter(Boolean) : [] }
  if (who.hr) {
    out.commentItems = enough ? sorted.filter((r) => r.comment).map((r) => ({ id: r._id, original: r.comment, shown: shown(r), hidden: !!r.moderation?.hidden, edited: !!r.moderation?.text, reason: r.moderation?.reason ?? null })) : []
    const pending = reqs.filter((r) => r.status === 'requested')
    const nm = await names(pending.map((r) => r.reviewerEmployeeId))
    out.pending = pending.map((r) => ({ id: r._id, reviewer: nm.get(r.reviewerEmployeeId) ?? null, remindedAt: r.remindedAt ?? null }))
  }
  return out
}
function shape(a: any, cycle: any, who: { own: boolean; hr: boolean; manager: boolean }, nm: Map<string, string>) {
  const hide = who.own && !isPublished(a)
  return {
    id: a._id, cycleId: a.cycleId, cycleName: cycle?.name, cycleStatus: cycle?.status, scaleMax: cycle?.scaleMax, employeeId: a.employeeId, employee: nm.get(a.employeeId) ?? null, manager: a.managerEmployeeId ? nm.get(a.managerEmployeeId) ?? null : null,
    status: a.status, self: a.self ?? null,
    managerReview: hide ? null : a.manager ?? null,
    scores: hide ? null : a.scores ?? null,
    finalScore: hide ? null : finalOf(a), rating: hide || finalOf(a) == null ? null : ratingOf(finalOf(a)!),
    calibration: who.own ? null : a.calibration ?? null,
    acknowledged: a.acknowledged ?? null,
    selfSkipped: who.own ? null : a.selfSkipped ?? null,
    exclusion: who.own ? null : a.exclusion ?? null,
  }
}

appraisalRouter.get('/appraisals', validate(z.object({ query: z.object({ scope: z.enum(['mine', 'team', 'all']).default('mine'), cycleId: z.string().uuid().optional() }) })), asyncHandler(async (req, res) => {
  const { tenantId, employeeId, roleIds } = req.user!
  const scope = String(req.query.scope ?? 'mine') as 'mine' | 'team' | 'all'
  const where: any = { tenantId, ...(req.query.cycleId && { cycleId: req.query.cycleId }) }
  if (scope === 'mine') { where.employeeId = employeeId ?? '-'; where.status = { $ne: 'excluded' } }
  else if (scope === 'all') hrOnly(req)
  else { if (!employeeId) return ok(res, []); where.employeeId = { $in: await getReportingSubtreeIds(employeeId, tenantId) } }
  const rows: any[] = await Appraisal.find(where).sort({ updatedAt: -1 }).limit(1000).lean()
  const cycles = new Map(((await AppraisalCycle.find({ _id: { $in: [...new Set(rows.map((r) => r.cycleId))] } }).lean()) as any[]).map((c) => [c._id, c]))
  const nm = await names(rows.flatMap((r) => [r.employeeId, r.managerEmployeeId]))
  ok(res, rows.map((a) => shape(a, cycles.get(a.cycleId), { own: a.employeeId === employeeId, hr: isHR(roleIds), manager: scope !== 'mine' }, nm)))
}))

appraisalRouter.get('/appraisals/:id', validate(z.object({ params: id })), asyncHandler(async (req, res) => {
  const { a, cycle, who } = await loadA(req, String(req.params.id))
  const comps: any[] = await AppraisalCompetency.find({ _id: { $in: cycle.competencyIds } }).lean()
  const nm = await names([a.employeeId, a.managerEmployeeId])
  const peers = cycle.peerReview ? await peersView(a, who, req) : null
  const ownBlock = who.own ? await ownRuleMessage(req, a.employeeId) : null
  const live = cycle.status === 'active'
  ok(res, {
    ...shape(a, cycle, who, nm), competencies: comps.map(ser), peerReview: cycle.peerReview, peers, goalsWeight: cycle.goalsWeight, scaleVersion: SCALE_VERSION, ownRule: who.own && who.hr ? ownBlock : null,
    can: {
      self: who.own && live && a.status === 'pending_self', manager: (who.manager || who.hr) && !ownBlock && live && ['self_submitted', 'manager_submitted'].includes(a.status),
      skipSelf: who.hr && !ownBlock && live && a.status === 'pending_self', calibrate: who.hr && !ownBlock && cycle.status === 'calibration' && a.status === 'manager_submitted',
      acknowledge: who.own && a.status === 'published', hrTools: who.hr && !isPublished(a) && ['active', 'calibration'].includes(cycle.status) && a.status !== 'excluded', restore: who.hr && a.status === 'excluded',
    },
  })
}))

function checkRatings(ratings: Record<string, number>, cycle: any) {
  for (const cid of cycle.competencyIds) if (!(cid in ratings)) throw new AppError('Rate every competency', 400)
  for (const k of Object.keys(ratings)) if (!cycle.competencyIds.includes(k)) throw new AppError('Unknown competency', 400)
  for (const v of Object.values(ratings)) if (v > cycle.scaleMax) throw new AppError(`Ratings go from 1 to ${cycle.scaleMax}`, 400)
}

appraisalRouter.post('/appraisals/:id/self', validate(z.object({ params: id, body: z.object({ ratings: z.record(z.string().uuid(), z.number().int().min(1).max(10)), comment: z.string().trim().max(3000).optional() }).strict() })), asyncHandler(async (req, res) => {
  const { a, cycle, who } = await loadA(req, String(req.params.id))
  if (!who.own) throw new AppError('Only the person can write their self appraisal', 403)
  if (cycle.status !== 'active') throw new AppError('This review cycle is not open', 400)
  checkRatings(req.body.ratings, cycle)
  const r = await Appraisal.updateOne({ _id: a._id, status: 'pending_self' }, { $set: { self: { ratings: req.body.ratings, comment: req.body.comment ?? null, submittedAt: new Date() }, status: 'self_submitted' } })
  if (!r.modifiedCount) throw new AppError('Your self appraisal was already sent', 409)
  await tell(req.user!.tenantId, a.managerEmployeeId, 'appraisal.self_submitted', 'A self appraisal is ready for your review', cycle.name)
  ok(res, { status: 'self_submitted' })
}))

appraisalRouter.post('/appraisals/:id/manager', validate(z.object({ params: id, body: z.object({ ratings: z.record(z.string().uuid(), z.number().int().min(1).max(10)), potential: z.number().int().min(1).max(3), comment: z.string().trim().min(3).max(3000), skipSelf: z.boolean().optional(), skipReason: z.string().trim().min(5).max(500).optional() }).strict() })), asyncHandler(async (req, res) => {
  const { a, cycle, who } = await loadA(req, String(req.params.id))
  if (!who.manager && !who.hr) throw new AppError('Only the manager or HR can review this', 403)
  const own = await ownRuleMessage(req, a.employeeId)
  if (own) throw new AppError(own, 403)
  if (cycle.status !== 'active') throw new AppError('This review cycle is not open', 400)
  const skip = req.body.skipSelf === true
  if (skip) {
    if (!who.hr) throw new AppError('Only HR can write the review without the self appraisal', 403)
    if (a.status !== 'pending_self') throw new AppError('The self appraisal is already in; no need to skip it', 400)
    if (!req.body.skipReason) throw new AppError('Give a reason for skipping the self appraisal', 400)
  } else if (!['self_submitted', 'manager_submitted'].includes(a.status)) throw new AppError('Wait for the self appraisal first', 400)
  checkRatings(req.body.ratings, cycle)
  const manager = { ratings: req.body.ratings, potential: req.body.potential, comment: req.body.comment, by: req.user!.userId, submittedAt: new Date() }
  const scores = await computeScores({ ...a, manager }, cycle)
  await Appraisal.updateOne({ _id: a._id }, { $set: { manager, scores, status: 'manager_submitted', ...(skip && { selfSkipped: { reason: req.body.skipReason, by: req.user!.userId, at: new Date() } }) } })
  await audit(req, 'APPRAISAL_MANAGER_REVIEW', 'appraisal', a._id, { computed: scores.computed, ...(skip && { selfSkipped: req.body.skipReason }) })
  ok(res, { status: 'manager_submitted', scores })
}))

// HR takes someone out of a running cycle (a leaver, long leave) with a reason, or puts them back
appraisalRouter.post('/appraisals/:id/exclude', validate(z.object({ params: id, body: z.object({ reason: z.string().trim().min(5).max(500) }).strict() })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { a, cycle } = await loadA(req, String(req.params.id))
  if (!['active', 'calibration'].includes(cycle.status)) throw new AppError('People can be removed while the cycle is open or in calibration', 400)
  if (['published', 'acknowledged', 'excluded'].includes(a.status)) throw new AppError(`An appraisal that is ${a.status} cannot be removed`, 400)
  await Appraisal.updateOne({ _id: a._id }, { $set: { status: 'excluded', exclusion: { reason: req.body.reason, by: req.user!.userId, at: new Date(), previousStatus: a.status } } })
  await PeerFeedback.updateMany({ appraisalId: a._id, status: 'requested' }, { $set: { status: 'cancelled' } })
  await audit(req, 'APPRAISAL_PARTICIPANT_REMOVED', 'appraisal', a._id, { employeeId: a.employeeId, reason: req.body.reason })
  ok(res, { status: 'excluded' })
}))
appraisalRouter.post('/appraisals/:id/restore', validate(z.object({ params: id })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { a, cycle } = await loadA(req, String(req.params.id))
  if (a.status !== 'excluded') throw new AppError('This appraisal was not removed', 400)
  if (!['active', 'calibration'].includes(cycle.status)) throw new AppError('The cycle is no longer open', 400)
  const back = a.exclusion?.previousStatus && a.exclusion.previousStatus !== 'excluded' ? a.exclusion.previousStatus : 'pending_self'
  await Appraisal.updateOne({ _id: a._id, status: 'excluded' }, { $set: { status: back }, $unset: { exclusion: '' } })
  await audit(req, 'APPRAISAL_PARTICIPANT_RESTORED', 'appraisal', a._id, { employeeId: a.employeeId })
  ok(res, { status: back })
}))

// 360: the person (while their self appraisal is open), their manager or HR names 3 to 5 peers; asking again adds more up to 5
appraisalRouter.post('/appraisals/:id/peers', validate(z.object({ params: id, body: z.object({ employeeIds: z.array(z.string().uuid()).min(1).max(5) }).strict() })), asyncHandler(async (req, res) => {
  const { a, cycle, who } = await loadA(req, String(req.params.id))
  if (!cycle.peerReview) throw new AppError('This cycle has no peer feedback', 400)
  if (cycle.status !== 'active') throw new AppError('This review cycle is not open', 400)
  const existing: any[] = (await PeerFeedback.find({ appraisalId: a._id }).select('reviewerEmployeeId status').lean()).filter((e: any) => e.status !== 'cancelled')
  const have = new Set(existing.map((e) => e.reviewerEmployeeId))
  const fresh = [...new Set(req.body.employeeIds as string[])].filter((e) => !have.has(e) && e !== a.employeeId && e !== a.managerEmployeeId)
  if (!fresh.length) throw new AppError('Choose people who are not already reviewers (and not the person or their manager)', 400)
  if (existing.length + fresh.length > MAX_PEERS) throw new AppError(`At most ${MAX_PEERS} peer reviewers`, 400)
  if (existing.length + fresh.length < MIN_PEERS) throw new AppError(`Choose ${MIN_PEERS} to ${MAX_PEERS} peers. With fewer than ${MIN_PEERS} answers the feedback can never be shown, because the writers could be identified.`, 400)
  if ((await Employee.countDocuments({ tenantId: req.user!.tenantId, active: true, _id: { $in: fresh } })) !== fresh.length) throw new AppError('Employee not found', 404)
  await PeerFeedback.deleteMany({ appraisalId: a._id, reviewerEmployeeId: { $in: fresh }, status: 'cancelled' }) // a cancelled request makes way for a new one
  await PeerFeedback.insertMany(fresh.map((e) => ({ _id: uuid(), tenantId: a.tenantId, appraisalId: a._id, cycleId: a.cycleId, subjectEmployeeId: a.employeeId, reviewerEmployeeId: e, status: 'requested', nominatedBy: who.own ? 'self' : 'manager', createdAt: new Date() })))
  for (const e of fresh) await tell(a.tenantId, e, 'appraisal.feedback_requested', 'You were asked for feedback', `${cycle.name}: your answers are anonymous.`)
  ok(res, { requested: existing.length + fresh.length }, 201)
}))

// HR swaps a reviewer who has not answered for someone else
appraisalRouter.post('/appraisals/:id/peers/:fid/replace', validate(z.object({ params: z.object({ id: z.string().uuid(), fid: z.string().uuid() }), body: z.object({ employeeId: z.string().uuid() }).strict() })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { a, cycle } = await loadA(req, String(req.params.id))
  if (cycle.status !== 'active') throw new AppError('This review cycle is not open', 400)
  const f: any = await PeerFeedback.findOne({ _id: req.params.fid, appraisalId: a._id }).lean()
  if (!f) throw new AppError('Reviewer not found', 404)
  if (f.status !== 'requested') throw new AppError('This reviewer has already answered, so they cannot be replaced', 400)
  const to = String(req.body.employeeId)
  if (to === a.employeeId || to === a.managerEmployeeId) throw new AppError('Choose someone other than the person or their manager', 400)
  if (await PeerFeedback.exists({ appraisalId: a._id, reviewerEmployeeId: to, status: { $ne: 'cancelled' } })) throw new AppError('That person is already a reviewer', 409)
  if (!(await Employee.exists({ _id: to, tenantId: req.user!.tenantId, active: true }))) throw new AppError('Employee not found', 404)
  await PeerFeedback.deleteMany({ appraisalId: a._id, reviewerEmployeeId: to, status: 'cancelled' })
  await PeerFeedback.updateOne({ _id: f._id, status: 'requested' }, { $set: { reviewerEmployeeId: to, replacedAt: new Date(), createdAt: new Date() }, $unset: { remindedAt: '' } })
  await audit(req, 'APPRAISAL_PEER_REPLACED', 'appraisal', a._id, {})
  await tell(a.tenantId, to, 'appraisal.feedback_requested', 'You were asked for feedback', `${cycle.name}: your answers are anonymous.`)
  ok(res, { replaced: true })
}))

// HR nudges the reviewers who have not answered (each at most once a day; the daily job also nudges on day 3)
async function nudge(tenantId: string, filter: any) {
  let n = 0
  for (const f of (await PeerFeedback.find({ tenantId, status: 'requested', ...filter }).lean()) as any[]) {
    const claim = await PeerFeedback.updateOne({ _id: f._id, status: 'requested' }, { $set: { remindedAt: new Date() } })
    if (!claim.modifiedCount) continue
    const cycle: any = await AppraisalCycle.findById(f.cycleId).select('name status').lean()
    if (cycle?.status !== 'active') continue
    await tell(tenantId, f.reviewerEmployeeId, 'appraisal.feedback_reminder', 'Reminder: feedback waiting for you', `${cycle.name}: someone is waiting for your anonymous feedback.`)
    n++
  }
  return n
}
appraisalRouter.post('/appraisals/:id/peers/remind', validate(z.object({ params: id })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { a } = await loadA(req, String(req.params.id))
  const reminded = await nudge(a.tenantId, { appraisalId: a._id, $or: [{ remindedAt: { $exists: false } }, { remindedAt: { $lt: new Date(Date.now() - 86400000) } }] })
  ok(res, { reminded })
}))
// HR hides or edits a peer comment that names its writer; the reason is audited; the person reviewed sees the edited version after publishing
appraisalRouter.post('/appraisals/:id/peers/:fid/moderate', validate(z.object({ params: z.object({ id: z.string().uuid(), fid: z.string().uuid() }), body: z.object({ action: z.enum(['hide', 'edit', 'restore']), text: z.string().trim().min(1).max(2000).optional(), reason: z.string().trim().min(5).max(500) }).strict() })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { a } = await loadA(req, String(req.params.id))
  const f: any = await PeerFeedback.findOne({ _id: req.params.fid, appraisalId: a._id, status: 'submitted' }).lean()
  if (!f || !f.comment) throw new AppError('Comment not found', 404)
  if (isPublished(a)) throw new AppError('This result is published, so its comments can no longer change', 400)
  const { action, text, reason } = req.body
  if (action === 'edit' && !text) throw new AppError('Write the edited comment', 400)
  const moderation = action === 'restore' ? null : { hidden: action === 'hide', ...(action === 'edit' && { text }), reason, by: req.user!.userId, at: new Date() }
  await PeerFeedback.updateOne({ _id: f._id }, moderation ? { $set: { moderation } } : { $unset: { moderation: '' } })
  await audit(req, 'APPRAISAL_COMMENT_MODERATED', 'appraisal', a._id, { action, reason })
  ok(res, { moderated: action })
}))

appraisalRouter.get('/feedback/mine', asyncHandler(async (req, res) => {
  const { tenantId, employeeId } = req.user!
  const rows: any[] = await PeerFeedback.find({ tenantId, reviewerEmployeeId: employeeId ?? '-', status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).limit(100).lean()
  const apps = new Map(((await Appraisal.find({ _id: { $in: rows.map((r) => r.appraisalId) } }).lean()) as any[]).map((x) => [x._id, x]))
  const cycles = new Map(((await AppraisalCycle.find({ _id: { $in: rows.map((r) => r.cycleId) } }).lean()) as any[]).map((c) => [c._id, c]))
  const nm = await names(rows.map((r) => r.subjectEmployeeId))
  const comps = new Map(((await AppraisalCompetency.find({ tenantId }).lean()) as any[]).map((c) => [c._id, c]))
  ok(res, rows.map((r) => ({ id: r._id, status: r.status, subject: nm.get(r.subjectEmployeeId) ?? null, cycleName: cycles.get(r.cycleId)?.name, scaleMax: cycles.get(r.cycleId)?.scaleMax, open: cycles.get(r.cycleId)?.status === 'active',
    competencies: (cycles.get(r.cycleId)?.competencyIds ?? []).map((c: string) => ({ id: c, name: comps.get(c)?.name })), _a: apps.has(r.appraisalId) })).map(({ _a, ...x }) => x))
}))
appraisalRouter.post('/feedback/:id', validate(z.object({ params: id, body: z.object({ ratings: z.record(z.string().uuid(), z.number().int().min(1).max(10)), comment: z.string().trim().max(2000).optional() }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, employeeId } = req.user!
  const f: any = await PeerFeedback.findOne({ _id: req.params.id, tenantId, reviewerEmployeeId: employeeId ?? '-' }).lean()
  if (!f) throw new AppError('Request not found', 404)
  const cycle: any = await AppraisalCycle.findById(f.cycleId).lean()
  if (cycle.status !== 'active') throw new AppError('This review cycle is not open', 400)
  checkRatings(req.body.ratings, cycle)
  const r = await PeerFeedback.updateOne({ _id: f._id, status: 'requested' }, { $set: { status: 'submitted', ratings: req.body.ratings, comment: req.body.comment ?? null, submittedAt: new Date() } })
  if (!r.modifiedCount) throw new AppError('You already answered this', 409)
  ok(res, { status: 'submitted' })
}))

// ─── Calibration (HR), acknowledgement, summary ───
appraisalRouter.post('/appraisals/:id/calibrate', validate(z.object({ params: id, body: z.object({ finalScore: z.number().min(0).max(150), reason: z.string().trim().min(5).max(500) }).strict() })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { a, cycle } = await loadA(req, String(req.params.id))
  const own = await ownRuleMessage(req, a.employeeId)
  if (own) throw new AppError(own, 403)
  if (cycle.status !== 'calibration') throw new AppError('Calibration happens while the cycle is in calibration', 400)
  if (a.status !== 'manager_submitted') throw new AppError('The manager has not reviewed this yet', 400)
  await recompute(a, cycle) // the score the change is measured from is today's, not a stale one
  const fresh: any = await Appraisal.findById(a._id).lean()
  await Appraisal.updateOne({ _id: a._id }, { $set: { calibration: { finalScore: req.body.finalScore, previous: finalOf(fresh), reason: req.body.reason, by: req.user!.userId, at: new Date() } } })
  await audit(req, 'APPRAISAL_CALIBRATED', 'appraisal', a._id, { from: finalOf(fresh), to: req.body.finalScore, reason: req.body.reason })
  ok(res, { finalScore: req.body.finalScore, rating: ratingOf(req.body.finalScore) })
}))

appraisalRouter.post('/appraisals/:id/acknowledge', validate(z.object({ params: id, body: z.object({ comment: z.string().trim().max(2000).optional() }).strict() })), asyncHandler(async (req, res) => {
  const { a, who } = await loadA(req, String(req.params.id))
  if (!who.own) throw new AppError('Only the person reviewed can acknowledge', 403)
  const r = await Appraisal.updateOne({ _id: a._id, status: 'published' }, { $set: { status: 'acknowledged', acknowledged: { comment: req.body.comment ?? null, at: new Date() } } })
  if (!r.modifiedCount) throw new AppError('Nothing to acknowledge yet', 400)
  await tell(a.tenantId, a.managerEmployeeId, 'appraisal.acknowledged', 'A review was acknowledged', req.body.comment ?? '')
  ok(res, { status: 'acknowledged' })
}))

// Rating distribution and the 9-box (performance x potential). HR sees everyone; a manager sees their own team.
appraisalRouter.get('/cycles/:id/summary', validate(z.object({ params: id })), asyncHandler(async (req, res) => {
  const { tenantId, employeeId, roleIds } = req.user!
  const cycle: any = await AppraisalCycle.findOne({ _id: req.params.id, tenantId }).lean()
  if (!cycle) throw new AppError('Cycle not found', 404)
  let where: any = { tenantId, cycleId: cycle._id, status: { $in: ['manager_submitted', 'published', 'acknowledged'] } }
  if (!isHR(roleIds)) { if (!employeeId || !roleIds.includes('manager')) throw new AppError('Not allowed', 403); where.employeeId = { $in: await getReportingSubtreeIds(employeeId, tenantId) } }
  const rows: any[] = await Appraisal.find(where).lean()
  const nm = await names(rows.map((r) => r.employeeId))
  const dist: Record<string, number> = { 'Exceeds expectations': 0, 'Meets expectations': 0, 'Partly meets expectations': 0, 'Below expectations': 0 }
  const grid: Record<string, string[]> = {}
  for (const a of rows) {
    const f = finalOf(a); if (f == null) continue
    dist[ratingOf(f)]++
    const perf = f < 80 ? 'low' : f < 105 ? 'medium' : 'high' // with the version 2 scale a perfect competency score is 120%, so "high" is reachable without goals above 100%
    ;(grid[`${perf}:${a.manager?.potential ?? 2}`] ||= []).push(nm.get(a.employeeId) ?? '')
  }
  ok(res, { reviewed: rows.length, distribution: dist, grid })
}))

// ─── Improvement plans ───
const planWho = async (req: any, employeeId: string) => {
  const { employeeId: me, roleIds } = req.user
  if (isHR(roleIds)) return 'hr'
  if (me && roleIds.includes('manager') && me !== employeeId && (await isReportingChainOf(me, employeeId))) return 'manager'
  if (me === employeeId) return 'self'
  throw new AppError('Plan not found', 404)
}
appraisalRouter.get('/plans', validate(z.object({ query: z.object({ scope: z.enum(['mine', 'team', 'all']).default('mine') }) })), asyncHandler(async (req, res) => {
  const { tenantId, employeeId } = req.user!
  const scope = String(req.query.scope ?? 'mine')
  const where: any = { tenantId }
  if (scope === 'mine') where.employeeId = employeeId ?? '-'
  else if (scope === 'all') hrOnly(req)
  else { if (!employeeId) return ok(res, []); where.employeeId = { $in: await getReportingSubtreeIds(employeeId, tenantId) } }
  const rows: any[] = await ImprovementPlan.find(where).sort({ createdAt: -1 }).limit(300).lean()
  const nm = await names(rows.map((r) => r.employeeId))
  ok(res, rows.map((p) => ({ ...ser(p), employee: nm.get(p.employeeId) ?? null })))
}))
appraisalRouter.post('/plans', validate(z.object({ body: z.object({ employeeId: z.string().uuid(), reason: z.string().trim().min(5).max(1000), endDate: date, objectives: z.array(z.string().trim().min(3).max(300)).min(1).max(8) }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, employeeId: me } = req.user!
  const b = req.body
  if (!(await Employee.exists({ _id: b.employeeId, tenantId, active: true }))) throw new AppError('Employee not found', 404)
  if (b.employeeId === me) throw new AppError('You cannot start a plan for yourself', 403)
  if ((await planWho(req, b.employeeId)) === 'self') throw new AppError('Plan not found', 404)
  if (b.endDate <= todayYmd()) throw new AppError('The plan must end in the future', 400)
  if (await ImprovementPlan.exists({ tenantId, employeeId: b.employeeId, status: 'active' })) throw new AppError('This person already has an active plan', 409)
  const p: any = await ImprovementPlan.create({ _id: uuid(), tenantId, employeeId: b.employeeId, createdBy: req.user!.userId, reason: b.reason, startDate: new Date(), endDate: new Date(`${b.endDate}T00:00:00Z`), status: 'active', objectives: b.objectives.map((text: string) => ({ id: uuid(), text, done: false })), notes: [{ text: `Plan started, until ${b.endDate}`, by: 'system', at: new Date() }] })
  await audit(req, 'IMPROVEMENT_PLAN_CREATED', 'improvement_plan', p._id, { employeeId: b.employeeId })
  await tell(tenantId, b.employeeId, 'appraisal.plan', 'A development plan was set up for you', 'Open it to see the objectives and the dates.')
  ok(res, ser(p.toObject()), 201)
}))
appraisalRouter.post('/plans/:id/progress', validate(z.object({ params: id, body: z.object({ objectiveId: z.string().uuid().optional(), done: z.boolean().optional(), note: z.string().trim().min(2).max(1000).optional() }).strict() })), asyncHandler(async (req, res) => {
  const p: any = await ImprovementPlan.findOne({ _id: req.params.id, tenantId: req.user!.tenantId }).lean()
  if (!p) throw new AppError('Plan not found', 404)
  const who = await planWho(req, p.employeeId)
  if (p.status !== 'active') throw new AppError('This plan is closed', 400)
  if (req.body.objectiveId !== undefined) {
    if (who === 'self') throw new AppError('Your manager marks objectives done', 403)
    const o = (p.objectives ?? []).find((x: any) => x.id === req.body.objectiveId)
    if (!o) throw new AppError('Objective not found', 404)
    const done = req.body.done ?? true
    await ImprovementPlan.updateOne({ _id: p._id, 'objectives.id': req.body.objectiveId }, { $set: { 'objectives.$.done': done }, $push: { notes: { text: `${done ? 'Done' : 'Reopened'}: ${o.text}`, by: who, at: new Date() } } })
  }
  if (req.body.note) await ImprovementPlan.updateOne({ _id: p._id }, { $push: { notes: { text: req.body.note, by: who, at: new Date() } } })
  ok(res, { updated: true })
}))
// Extend (a new end date in the future) or close as successful / unsuccessful; both need a note, and the history keeps it
appraisalRouter.post('/plans/:id/close', validate(z.object({ params: id, body: z.object({ outcome: z.enum(['successful', 'extended', 'unsuccessful']), note: z.string().trim().min(3).max(1000), endDate: date.optional() }).strict() })), asyncHandler(async (req, res) => {
  const p: any = await ImprovementPlan.findOne({ _id: req.params.id, tenantId: req.user!.tenantId }).lean()
  if (!p) throw new AppError('Plan not found', 404)
  const who = await planWho(req, p.employeeId)
  if (who === 'self') throw new AppError('Plan not found', 404)
  if (p.status !== 'active') throw new AppError('This plan is closed', 400)
  if (req.body.outcome === 'extended') {
    if (!req.body.endDate || req.body.endDate <= todayYmd()) throw new AppError('Give a new end date in the future', 400)
    await ImprovementPlan.updateOne({ _id: p._id }, { $set: { endDate: new Date(`${req.body.endDate}T00:00:00Z`) }, $push: { notes: { text: `Extended until ${req.body.endDate}: ${req.body.note}`, by: who, at: new Date() } } })
    await audit(req, 'IMPROVEMENT_PLAN_EXTENDED', 'improvement_plan', p._id, { endDate: req.body.endDate })
    await tell(req.user!.tenantId, p.employeeId, 'appraisal.plan', 'Your development plan was extended', `Now until ${req.body.endDate}.`)
    return ok(res, { status: 'active' })
  }
  await ImprovementPlan.updateOne({ _id: p._id }, { $set: { status: 'closed', outcome: req.body.outcome, closedAt: new Date(), closedBy: req.user!.userId }, $push: { notes: { text: `Closed (${req.body.outcome === 'successful' ? 'objectives met' : 'objectives not met'}): ${req.body.note}`, by: who, at: new Date() } } })
  await audit(req, 'IMPROVEMENT_PLAN_CLOSED', 'improvement_plan', p._id, { outcome: req.body.outcome, note: req.body.note })
  await tell(req.user!.tenantId, p.employeeId, 'appraisal.plan', 'Your development plan was closed', req.body.outcome === 'successful' ? 'The objectives were met.' : 'The objectives were not met.')
  ok(res, { status: 'closed' })
}))

// Daily job 'appraisal-reminders': a peer who has not answered 3 days after being asked gets one nudge (idempotent: remindedAt is claimed first)
export async function appraisalReminders(only?: string) {
  const tenants: string[] = only ? [only] : ((await col('tenants').find({ active: true }).project({ _id: 1 }).toArray()) as any[]).map((t) => String(t._id))
  let n = 0
  for (const t of tenants) {
    if (!(await tenantHasFeature(t, 'pmsAdvanced'))) continue
    n += await nudge(t, { remindedAt: { $exists: false }, createdAt: { $lte: new Date(Date.now() - 3 * 86400000) } })
  }
  return n
}

// Self-check: node -r dotenv/config -r ts-node/register/transpile-only src/modules/performance/appraisal.mongo.router.ts
if (require.main === module) {
  console.assert(competencyPct(5, 5) === 120 && competencyPct(4, 5) === 100 && competencyPct(3, 5) === 80 && competencyPct(1, 5) === 40, 'on a 1 to 5 scale: 5 = 120, 4 = 100, 3 = 80, 1 = 40')
  console.assert(competencyPct(10, 10) === 120 && competencyPct(1, 10) === 40, 'the top and bottom of any scale map to 120 and 40')
  console.assert(ratingOf(competencyPct(5, 5)) === 'Exceeds expectations' && ratingOf(competencyPct(4, 5)) === 'Meets expectations' && ratingOf(competencyPct(3, 5)) === 'Partly meets expectations' && ratingOf(competencyPct(2, 5)) === 'Below expectations', 'a perfect appraisal can exceed, 4 of 5 meets')
  console.log('appraisal scale check done')
  process.exit(0)
}

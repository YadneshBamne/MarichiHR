import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { requireFeature } from '../../middleware/module.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { isReportingChainOf, getReportingSubtreeIds } from '../../shared/utils/access'
import { Employee, AuditLog, Notification, AppraisalCompetency, AppraisalCycle, Appraisal, PeerFeedback, ImprovementPlan } from '../../infrastructure/mongo/mongo'
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
const MIN_PEERS = 3 // peer comments and averages are shown to the manager only once this many have answered, so nobody can be identified

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
async function tell(tenantId: string, employeeId: string | null | undefined, type: string, title: string, body: string) {
  const e: any = employeeId ? await Employee.findOne({ _id: employeeId, tenantId }).select('userId').lean() : null
  if (e?.userId) await Notification.create({ _id: uuid(), tenantId, userId: e.userId, type, title, body, link: '/appraisals', read: false } as any)
}
const audit = (req: any, action: string, entityType: string, entityId: string, newValue?: object) => AuditLog.create({ tenantId: req.user.tenantId, userId: req.user.userId, action, entityType, entityId, newValue })
async function names(ids: (string | null | undefined)[]) {
  const rows: any[] = await Employee.find({ _id: { $in: ids.filter(Boolean) as string[] } }).select('firstName lastName employeeCode').lean()
  return new Map(rows.map((e) => [e._id as string, `${e.firstName} ${e.lastName}`]))
}

// Final score: goals (the person's reviewed goals that fall in the cycle) and competencies (the manager's ratings), weighted per cycle
export async function computeScores(a: any, cycle: any) {
  const comp = a.manager?.ratings && Object.keys(a.manager.ratings).length
    ? r1((Object.values(a.manager.ratings as Record<string, number>).reduce((s, n) => s + n, 0) / Object.keys(a.manager.ratings).length / cycle.scaleMax) * 100) : null
  const goals: any[] = await mongoose.connection.collection('performance_goals').find({ tenantId: a.tenantId, employeeId: a.employeeId, status: { $in: ['reviewed', 'acknowledged'] }, reviewedAt: { $gte: cycle.startDate, $lte: new Date(cycle.endDate.getTime() + 86400000) } } as any).toArray()
  const goalScore = goals.length ? r1(goals.reduce((s, g) => s + (g.score ?? 0), 0) / goals.length) : null
  let computed: number | null = null
  if (comp != null) computed = goalScore == null ? comp : r1((goalScore * cycle.goalsWeight + comp * (100 - cycle.goalsWeight)) / 100)
  return { competencyScore: comp, goalScore, computed }
}
const finalOf = (a: any) => (a.calibration?.finalScore ?? a.scores?.computed ?? null) as number | null

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

appraisalRouter.get('/cycles', asyncHandler(async (req, res) => {
  const { tenantId, roleIds } = req.user!
  const rows: any[] = await AppraisalCycle.find({ tenantId }).sort({ startDate: -1 }).lean()
  const counts: any[] = await Appraisal.aggregate([{ $match: { tenantId } }, { $group: { _id: '$cycleId', n: { $sum: 1 } } }])
  const n = new Map(counts.map((c) => [c._id, c.n]))
  ok(res, rows.filter((c) => isHR(roleIds) || c.status !== 'draft').map((c) => ({ ...ser(c), participants: n.get(c._id) ?? 0 })))
}))
const CycleBody = z.object({
  name: z.string().trim().min(2).max(60), startDate: date, endDate: date, scaleMax: z.number().int().min(3).max(10).default(5), goalsWeight: z.number().min(0).max(100).default(50),
  competencyIds: z.array(z.string().uuid()).min(1).max(15), peerReview: z.boolean().default(true),
}).strict()
appraisalRouter.post('/cycles', validate(z.object({ body: CycleBody })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { tenantId } = req.user!
  const b = req.body as z.infer<typeof CycleBody>
  if (b.endDate <= b.startDate) throw new AppError('The cycle must end after it starts', 400)
  if (await AppraisalCycle.exists({ tenantId, name: b.name })) throw new AppError('A cycle with that name exists', 409)
  if ((await AppraisalCompetency.countDocuments({ tenantId, active: true, _id: { $in: b.competencyIds } })) !== b.competencyIds.length) throw new AppError('Competency not found', 404)
  const c: any = await AppraisalCycle.create({ _id: uuid(), tenantId, ...b, startDate: new Date(`${b.startDate}T00:00:00Z`), endDate: new Date(`${b.endDate}T00:00:00Z`), status: 'draft', createdBy: req.user!.userId })
  await audit(req, 'APPRAISAL_CYCLE_CREATED', 'appraisal_cycle', c._id, { name: b.name })
  ok(res, ser(c.toObject()), 201)
}))

// Launch: every chosen (or every active) employee gets an appraisal with their manager at that moment
appraisalRouter.post('/cycles/:id/launch', validate(z.object({ params: id, body: z.object({ employeeIds: z.array(z.string().uuid()).max(5000).optional() }).strict() })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { tenantId } = req.user!
  const cycle: any = await AppraisalCycle.findOne({ _id: req.params.id, tenantId }).lean()
  if (!cycle) throw new AppError('Cycle not found', 404)
  if (cycle.status !== 'draft') throw new AppError('This cycle was already launched', 409)
  const emps: any[] = await Employee.find({ tenantId, active: true, employmentStatus: { $ne: 'terminated' }, ...(req.body.employeeIds && { _id: { $in: req.body.employeeIds } }) }).select('managerId').lean()
  if (!emps.length) throw new AppError('There is nobody to review', 400)
  await Appraisal.insertMany(emps.map((e) => ({ _id: uuid(), tenantId, cycleId: cycle._id, employeeId: e._id, managerEmployeeId: e.managerId ?? null, status: 'pending_self', peers: [] })), { ordered: false })
  await AppraisalCycle.updateOne({ _id: cycle._id, status: 'draft' }, { $set: { status: 'active', launchedAt: new Date() } })
  await audit(req, 'APPRAISAL_CYCLE_LAUNCHED', 'appraisal_cycle', cycle._id, { participants: emps.length })
  for (const e of emps) await tell(tenantId, e._id, 'appraisal.started', `${cycle.name}: your self appraisal is open`, 'Rate yourself on each competency and choose your peer reviewers.')
  ok(res, { participants: emps.length })
}))

const NEXT: Record<string, string[]> = { active: ['calibration'], calibration: ['active', 'published'], published: ['closed'] }
appraisalRouter.post('/cycles/:id/status', validate(z.object({ params: id, body: z.object({ status: z.enum(['active', 'calibration', 'published', 'closed']) }).strict() })), asyncHandler(async (req, res) => {
  hrOnly(req)
  const { tenantId } = req.user!
  const cycle: any = await AppraisalCycle.findOne({ _id: req.params.id, tenantId }).lean()
  if (!cycle) throw new AppError('Cycle not found', 404)
  if (!(NEXT[cycle.status] ?? []).includes(req.body.status)) throw new AppError(`A ${cycle.status} cycle cannot move to ${req.body.status}`, 400)
  if (req.body.status === 'published') {
    // Anyone whose manager has not reviewed yet would have nothing to publish
    const open = await Appraisal.countDocuments({ tenantId, cycleId: cycle._id, status: { $in: ['pending_self', 'self_submitted'] } })
    if (open) throw new AppError(`${open} appraisal${open === 1 ? ' is' : 's are'} still waiting for the manager's review`, 409)
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
const peersView = async (a: any, who: { own: boolean }) => {
  const reqs: any[] = await PeerFeedback.find({ appraisalId: a._id }).lean()
  const done = reqs.filter((r) => r.status === 'submitted')
  const total = reqs.length
  if (who.own) return { requested: total, answered: done.length } // the subject never sees who answered or what
  const cycle: any = await AppraisalCycle.findById(a.cycleId).lean()
  const comps: any[] = await AppraisalCompetency.find({ _id: { $in: cycle.competencyIds } }).lean()
  const enough = done.length >= MIN_PEERS
  const averages = enough ? Object.fromEntries(comps.map((c) => [c._id, r1(done.reduce((s, r) => s + (r.ratings?.[c._id] ?? 0), 0) / done.length)])) : null
  const comments = enough ? done.map((r) => r.comment).filter(Boolean).sort(() => Math.random() - 0.5) : []
  return { requested: total, answered: done.length, minimum: MIN_PEERS, averages, comments }
}
function shape(a: any, cycle: any, who: { own: boolean; hr: boolean; manager: boolean }, nm: Map<string, string>) {
  const published = ['published', 'acknowledged'].includes(a.status)
  const hide = who.own && !published
  return {
    id: a._id, cycleId: a.cycleId, cycleName: cycle?.name, cycleStatus: cycle?.status, scaleMax: cycle?.scaleMax, employeeId: a.employeeId, employee: nm.get(a.employeeId) ?? null, manager: a.managerEmployeeId ? nm.get(a.managerEmployeeId) ?? null : null,
    status: a.status, self: a.self ?? null,
    managerReview: hide ? null : a.manager ?? null,
    scores: hide ? null : a.scores ?? null,
    finalScore: hide ? null : finalOf(a), rating: hide || finalOf(a) == null ? null : ratingOf(finalOf(a)!),
    calibration: who.own ? null : a.calibration ?? null,
    acknowledged: a.acknowledged ?? null,
  }
}

appraisalRouter.get('/appraisals', validate(z.object({ query: z.object({ scope: z.enum(['mine', 'team', 'all']).default('mine'), cycleId: z.string().uuid().optional() }) })), asyncHandler(async (req, res) => {
  const { tenantId, employeeId, roleIds } = req.user!
  const scope = String(req.query.scope ?? 'mine') as 'mine' | 'team' | 'all'
  const where: any = { tenantId, ...(req.query.cycleId && { cycleId: req.query.cycleId }) }
  if (scope === 'mine') where.employeeId = employeeId ?? '-'
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
  const peers = cycle.peerReview ? await peersView(a, who) : null
  ok(res, { ...shape(a, cycle, who, nm), competencies: comps.map(ser), peerReview: cycle.peerReview, peers, goalsWeight: cycle.goalsWeight, can: { self: who.own && cycle.status === 'active' && a.status === 'pending_self', manager: (who.manager || who.hr) && cycle.status === 'active' && ['self_submitted', 'manager_submitted'].includes(a.status), calibrate: who.hr && cycle.status === 'calibration', acknowledge: who.own && a.status === 'published' } })
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

appraisalRouter.post('/appraisals/:id/manager', validate(z.object({ params: id, body: z.object({ ratings: z.record(z.string().uuid(), z.number().int().min(1).max(10)), potential: z.number().int().min(1).max(3), comment: z.string().trim().min(3).max(3000) }).strict() })), asyncHandler(async (req, res) => {
  const { a, cycle, who } = await loadA(req, String(req.params.id))
  if (!who.manager && !who.hr) throw new AppError('Only the manager or HR can review this', 403)
  if (cycle.status !== 'active') throw new AppError('This review cycle is not open', 400)
  if (!['self_submitted', 'manager_submitted'].includes(a.status)) throw new AppError('Wait for the self appraisal first', 400)
  checkRatings(req.body.ratings, cycle)
  const manager = { ratings: req.body.ratings, potential: req.body.potential, comment: req.body.comment, by: req.user!.userId, submittedAt: new Date() }
  const scores = await computeScores({ ...a, manager }, cycle)
  await Appraisal.updateOne({ _id: a._id }, { $set: { manager, scores, status: 'manager_submitted' } })
  await audit(req, 'APPRAISAL_MANAGER_REVIEW', 'appraisal', a._id, { computed: scores.computed })
  ok(res, { status: 'manager_submitted', scores })
}))

// 360: the person (while their self appraisal is open), their manager or HR names 2 to 5 peers; asking again adds more up to 5
appraisalRouter.post('/appraisals/:id/peers', validate(z.object({ params: id, body: z.object({ employeeIds: z.array(z.string().uuid()).min(1).max(5) }).strict() })), asyncHandler(async (req, res) => {
  const { a, cycle, who } = await loadA(req, String(req.params.id))
  if (!cycle.peerReview) throw new AppError('This cycle has no peer feedback', 400)
  if (cycle.status !== 'active') throw new AppError('This review cycle is not open', 400)
  const existing: any[] = await PeerFeedback.find({ appraisalId: a._id }).select('reviewerEmployeeId').lean()
  const have = new Set(existing.map((e) => e.reviewerEmployeeId))
  const fresh = [...new Set(req.body.employeeIds as string[])].filter((e) => !have.has(e) && e !== a.employeeId && e !== a.managerEmployeeId)
  if (!fresh.length) throw new AppError('Choose people who are not already reviewers (and not the person or their manager)', 400)
  if (existing.length + fresh.length > 5) throw new AppError('At most 5 peer reviewers', 400)
  if ((await Employee.countDocuments({ tenantId: req.user!.tenantId, active: true, _id: { $in: fresh } })) !== fresh.length) throw new AppError('Employee not found', 404)
  await PeerFeedback.insertMany(fresh.map((e) => ({ _id: uuid(), tenantId: a.tenantId, appraisalId: a._id, cycleId: a.cycleId, subjectEmployeeId: a.employeeId, reviewerEmployeeId: e, status: 'requested', nominatedBy: who.own ? 'self' : 'manager' })))
  for (const e of fresh) await tell(a.tenantId, e, 'appraisal.feedback_requested', 'You were asked for feedback', `${cycle.name}: your answers are anonymous.`)
  ok(res, { requested: existing.length + fresh.length }, 201)
}))

appraisalRouter.get('/feedback/mine', asyncHandler(async (req, res) => {
  const { tenantId, employeeId } = req.user!
  const rows: any[] = await PeerFeedback.find({ tenantId, reviewerEmployeeId: employeeId ?? '-' }).sort({ createdAt: -1 }).limit(100).lean()
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
  if (cycle.status !== 'calibration') throw new AppError('Calibration happens while the cycle is in calibration', 400)
  if (a.status !== 'manager_submitted') throw new AppError('The manager has not reviewed this yet', 400)
  await Appraisal.updateOne({ _id: a._id }, { $set: { calibration: { finalScore: req.body.finalScore, previous: finalOf(a), reason: req.body.reason, by: req.user!.userId, at: new Date() } } })
  await audit(req, 'APPRAISAL_CALIBRATED', 'appraisal', a._id, { from: finalOf(a), to: req.body.finalScore, reason: req.body.reason })
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
    const perf = f < 80 ? 'low' : f < 105 ? 'medium' : 'high'
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
  if (await ImprovementPlan.exists({ tenantId, employeeId: b.employeeId, status: 'active' })) throw new AppError('This person already has an active plan', 409)
  const p: any = await ImprovementPlan.create({ _id: uuid(), tenantId, employeeId: b.employeeId, createdBy: req.user!.userId, reason: b.reason, startDate: new Date(), endDate: new Date(`${b.endDate}T00:00:00Z`), status: 'active', objectives: b.objectives.map((text: string) => ({ id: uuid(), text, done: false })), notes: [] })
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
    if (!(p.objectives ?? []).some((o: any) => o.id === req.body.objectiveId)) throw new AppError('Objective not found', 404)
    await ImprovementPlan.updateOne({ _id: p._id, 'objectives.id': req.body.objectiveId }, { $set: { 'objectives.$.done': req.body.done ?? true } })
  }
  if (req.body.note) await ImprovementPlan.updateOne({ _id: p._id }, { $push: { notes: { text: req.body.note, by: who, at: new Date() } } })
  ok(res, { updated: true })
}))
appraisalRouter.post('/plans/:id/close', validate(z.object({ params: id, body: z.object({ outcome: z.enum(['successful', 'extended', 'unsuccessful']), note: z.string().trim().min(3).max(1000), endDate: date.optional() }).strict() })), asyncHandler(async (req, res) => {
  const p: any = await ImprovementPlan.findOne({ _id: req.params.id, tenantId: req.user!.tenantId }).lean()
  if (!p) throw new AppError('Plan not found', 404)
  if ((await planWho(req, p.employeeId)) === 'self') throw new AppError('Plan not found', 404)
  if (p.status !== 'active') throw new AppError('This plan is closed', 400)
  if (req.body.outcome === 'extended') {
    if (!req.body.endDate || req.body.endDate <= new Date().toISOString().slice(0, 10)) throw new AppError('Give a new end date in the future', 400)
    await ImprovementPlan.updateOne({ _id: p._id }, { $set: { endDate: new Date(`${req.body.endDate}T00:00:00Z`) }, $push: { notes: { text: `Extended: ${req.body.note}`, by: 'manager', at: new Date() } } })
    return ok(res, { status: 'active' })
  }
  await ImprovementPlan.updateOne({ _id: p._id }, { $set: { status: 'closed', outcome: req.body.outcome, closedAt: new Date(), closedBy: req.user!.userId }, $push: { notes: { text: req.body.note, by: 'manager', at: new Date() } } })
  await audit(req, 'IMPROVEMENT_PLAN_CLOSED', 'improvement_plan', p._id, { outcome: req.body.outcome })
  await tell(req.user!.tenantId, p.employeeId, 'appraisal.plan', 'Your development plan was closed', req.body.outcome)
  ok(res, { status: 'closed' })
}))

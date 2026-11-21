import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { requireFeature } from '../../middleware/module.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { ConfirmationCase, Employee, AuditLog } from '../../infrastructure/mongo/mongo'

// Probation confirmation: HR opens a review for someone whose probation is ending, their manager gives a rating and a
// recommendation, and HR makes the final call (confirm, extend, or not confirm). MongoDB mode only.
// Rules: the manager never reviews themselves and HR never decides their own case; the employee only sees the outcome, never the review.
// ponytail: "not confirmed" records the decision and tells HR to start an exit; it does not end the employment itself. No letter template yet.
export const confirmationRouter = Router()
confirmationRouter.use(authenticate, requireFeature('confirmation'))

const HR = ['hr_admin', 'system_admin']
const isHr = (roleIds: string[]) => roleIds.some((r) => HR.includes(r))
const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }
const idp = z.object({ id: z.string().uuid() })
const day = (d: Date) => d.toISOString().slice(0, 10)
const todayUtc = () => new Date(`${day(new Date())}T00:00:00.000Z`)
const name = (e: any) => (e ? `${e.firstName} ${e.lastName}` : null)

async function empMap(tenantId: string, ids: string[]) {
  const rows: any[] = await Employee.find({ tenantId, _id: { $in: [...new Set(ids)] } }).select('firstName lastName employeeCode managerId userId probationEndDate confirmationDate').lean()
  return new Map(rows.map((e) => [e._id, e]))
}
// What the caller may see of a case: HR everything; the manager of that person everything; the employee only the outcome
function view(c: any, e: any, req: any) {
  const out: any = { ...ser(c), employeeName: name(e), employeeCode: e?.employeeCode ?? null }
  const { userId, employeeId, roleIds } = req.user
  out.canReview = c.status === 'manager_review' && !!employeeId && e?.managerId === employeeId && e._id !== employeeId
  const seesReview = isHr(roleIds) || (employeeId && e?.managerId === employeeId)
  if (!seesReview) { delete out.review; if (out.decision) out.decision = { outcome: out.decision.outcome, newEndDate: out.decision.newEndDate, at: out.decision.at } }
  if (e?.userId === userId && c.status !== 'closed') out.status = 'in_review'
  return out
}

// ── HR: who is coming up (probation ending within 90 days or already past, not yet confirmed, no open review)
confirmationRouter.get('/due', requireRoles(...HR), asyncHandler(async (req, res) => {
  const { tenantId } = req.user!
  const soon = new Date(todayUtc().getTime() + 90 * 86400000)
  const open: any[] = await ConfirmationCase.find({ tenantId, status: { $ne: 'closed' } }).select('employeeId').lean()
  const rows: any[] = await Employee.find({ tenantId, active: true, confirmationDate: null, probationEndDate: { $ne: null, $lte: soon }, _id: { $nin: open.map((o) => o.employeeId) } }).sort({ probationEndDate: 1 }).limit(200).select('firstName lastName employeeCode probationEndDate managerId').lean()
  const now = todayUtc().getTime()
  res.json({ success: true, data: rows.map((e) => ({ employeeId: e._id, name: name(e), code: e.employeeCode, probationEndDate: day(e.probationEndDate), daysLeft: Math.round((e.probationEndDate.getTime() - now) / 86400000), hasManager: !!e.managerId })) })
}))

confirmationRouter.post('/cases', requireRoles(...HR), validate(z.object({ body: z.object({ employeeId: z.string().uuid() }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const e: any = await Employee.findOne({ _id: req.body.employeeId, tenantId, active: true }).lean()
  if (!e) throw new AppError('Employee not found', 404)
  if (e.userId === userId) throw new AppError('You cannot open your own confirmation review', 403)
  if (!e.probationEndDate) throw new AppError('This person has no probation end date. Set one on their profile first.', 400)
  if (e.confirmationDate) throw new AppError('This person is already confirmed', 409)
  if (await ConfirmationCase.exists({ tenantId, employeeId: e._id, status: { $ne: 'closed' } })) throw new AppError('A review is already open for this person', 409)
  // without a manager there is nobody to review: it goes straight to HR
  const c: any = await ConfirmationCase.create({ tenantId, employeeId: e._id, status: e.managerId ? 'manager_review' : 'hr_decision', probationEndDate: e.probationEndDate, startedBy: userId, review: null, decision: null })
  await AuditLog.create({ tenantId, userId, action: 'CONFIRMATION_STARTED', entityType: 'confirmation_case', entityId: c._id, newValue: { employeeId: e._id } })
  res.status(201).json({ success: true, data: view(c.toObject(), e, req) })
}))

// HR sees every case; a manager the open ones for their direct reports; an employee their own
confirmationRouter.get('/cases', asyncHandler(async (req, res) => {
  const { tenantId, employeeId, roleIds } = req.user!
  const q: any = { tenantId }
  if (!isHr(roleIds)) {
    const team: any[] = employeeId ? await Employee.find({ tenantId, managerId: employeeId, active: true }).select('_id').lean() : []
    q.employeeId = { $in: [...team.map((t) => t._id), ...(employeeId ? [employeeId] : [])] }
  }
  if (typeof req.query.status === 'string' && req.query.status) q.status = req.query.status
  const rows: any[] = await ConfirmationCase.find(q).sort({ createdAt: -1 }).limit(200).lean()
  const em = await empMap(tenantId, rows.map((r) => r.employeeId))
  res.json({ success: true, data: rows.map((r) => view(r, em.get(r.employeeId), req)) })
}))

async function loadCase(req: any, id: string) {
  const { tenantId, employeeId, roleIds } = req.user
  const c: any = await ConfirmationCase.findOne({ _id: id, tenantId }).lean()
  const e: any = c ? (await Employee.findOne({ _id: c.employeeId, tenantId }).lean()) : null
  if (!c || !e || !(isHr(roleIds) || e.managerId === employeeId || e._id === employeeId)) throw new AppError('Review not found', 404)
  return { c, e }
}
confirmationRouter.get('/cases/:id', validate(z.object({ params: idp })), asyncHandler(async (req, res) => {
  const { c, e } = await loadCase(req, String(req.params.id))
  res.json({ success: true, data: view(c, e, req) })
}))

const Review = z.object({ rating: z.number().int().min(1).max(5), strengths: z.string().trim().min(3).max(1500), concerns: z.string().trim().max(1500).default(''), recommendation: z.enum(['confirm', 'extend', 'not_confirm']), extensionMonths: z.number().int().min(1).max(12).optional() }).strict()
confirmationRouter.post('/cases/:id/review', validate(z.object({ params: idp, body: Review })), asyncHandler(async (req, res) => {
  const { tenantId, userId, employeeId } = req.user!
  const { c, e } = await loadCase(req, String(req.params.id))
  if (e.managerId !== employeeId || e._id === employeeId) throw new AppError('Only the employee\'s manager reviews', 403)
  if (c.status !== 'manager_review') throw new AppError('This review is not waiting for the manager', 409)
  if (req.body.recommendation === 'extend' && !req.body.extensionMonths) throw new AppError('Say how many months to extend', 400)
  if (req.body.recommendation !== 'confirm' && !req.body.concerns) throw new AppError('Explain the concerns behind a recommendation not to confirm', 400)
  const r: any = await ConfirmationCase.findOneAndUpdate({ _id: c._id, tenantId, status: 'manager_review' }, { $set: { status: 'hr_decision', review: { ...req.body, by: userId, at: new Date() } } }, { returnDocument: 'after' }).lean()
  if (!r) throw new AppError('Someone else just acted on this review', 409)
  await AuditLog.create({ tenantId, userId, action: 'CONFIRMATION_REVIEWED', entityType: 'confirmation_case', entityId: c._id, newValue: { recommendation: req.body.recommendation, rating: req.body.rating } })
  res.json({ success: true, data: view(r, e, req) })
}))

const Decide = z.object({ outcome: z.enum(['confirmed', 'extended', 'not_confirmed']), note: z.string().trim().max(1000).default(''), newEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict()
confirmationRouter.post('/cases/:id/decide', requireRoles(...HR), validate(z.object({ params: idp, body: Decide })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const { c, e } = await loadCase(req, String(req.params.id))
  if (e.userId === userId) throw new AppError('You cannot decide your own confirmation', 403)
  if (c.status !== 'hr_decision') throw new AppError('This review is not waiting for HR', 409)
  const { outcome, note, newEndDate } = req.body
  if (outcome !== 'confirmed' && !note) throw new AppError('Give a reason', 400)
  let end: Date | null = null
  if (outcome === 'extended') {
    if (!newEndDate) throw new AppError('Choose the new probation end date', 400)
    end = new Date(`${newEndDate}T00:00:00.000Z`)
    const base = e.probationEndDate ?? c.probationEndDate
    if (end <= base) throw new AppError('The new end date must be after the current one', 400)
    if (end.getTime() > base.getTime() + 366 * 86400000) throw new AppError('A probation can be extended by at most a year', 400)
  }
  const r: any = await ConfirmationCase.findOneAndUpdate({ _id: c._id, tenantId, status: 'hr_decision' }, { $set: { status: 'closed', decision: { outcome, note, newEndDate: end ? day(end) : null, by: userId, at: new Date() } } }, { returnDocument: 'after' }).lean()
  if (!r) throw new AppError('Someone else just acted on this review', 409)
  if (outcome === 'confirmed') await Employee.updateOne({ _id: e._id, tenantId }, { $set: { confirmationDate: todayUtc() } })
  if (outcome === 'extended') await Employee.updateOne({ _id: e._id, tenantId }, { $set: { probationEndDate: end } })
  await AuditLog.create({ tenantId, userId, action: 'CONFIRMATION_DECIDED', entityType: 'confirmation_case', entityId: c._id, newValue: { outcome, newEndDate: end ? day(end) : null } })
  res.json({ success: true, data: { ...view(r, e, req), nextStep: outcome === 'not_confirmed' ? 'Start an exit for this person if you are ending the employment.' : null } })
}))

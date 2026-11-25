import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { requireFeature } from '../../middleware/module.middleware.mongo'
import { tenantHasFeature } from '../../middleware/module.middleware.mongo'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { ConfirmationCase, Employee, Tenant, JobPosition, AuditLog } from '../../infrastructure/mongo/mongo'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { generatePayslipPdf, escapeHtml } from '../payroll/payslip.pdf'

// Probation confirmation: HR opens a review for someone whose probation is ending, their manager gives a rating and a
// recommendation, and HR makes the final call (confirm, extend, or not confirm). MongoDB mode only.
// Rules: the manager never reviews themselves and HR never decides their own case; the employee only sees the outcome, never the review.
// Everyone concerned is told at each step; HR can reassign the reviewer, review for an absent manager, or cancel a stuck case (each with a reason, audited).
// Confirmed and extended people get a letter (PDF) built from the company's template.
// ponytail: "not confirmed" records the decision and tells HR to start an exit; it does not end the employment itself.
export const confirmationRouter = Router()
confirmationRouter.use(authenticate, requireFeature('confirmation'))

const HR = ['hr_admin', 'system_admin']
const isHr = (roleIds: string[]) => roleIds.some((r) => HR.includes(r))
const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }
const idp = z.object({ id: z.string().uuid() })
const day = (d: Date) => d.toISOString().slice(0, 10)
const todayUtc = () => new Date(`${day(new Date())}T00:00:00.000Z`)
const name = (e: any) => (e ? `${e.firstName} ${e.lastName}` : null)
const reviewerOf = (c: any, e: any): string | null => c.reviewerEmployeeId ?? e?.managerId ?? null
const longDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const addMonths = (d: Date, n: number) => { const x = new Date(d.getTime()); x.setUTCMonth(x.getUTCMonth() + n); return x }

async function empMap(tenantId: string, ids: string[]) {
  const rows: any[] = await Employee.find({ tenantId, _id: { $in: [...new Set(ids)] } }).select('firstName lastName employeeCode managerId userId probationEndDate confirmationDate').lean()
  return new Map(rows.map((e) => [e._id, e]))
}
// In-app and, by each person's settings, email
async function tell(tenantId: string, userIds: (string | null | undefined)[], type: string, title: string, body: string, entityId: string, eventId?: string) {
  const ids = [...new Set(userIds.filter(Boolean) as string[])]
  if (ids.length) await notify({ tenantId, userIds: ids, type, title, body, link: '/confirmation', entityType: 'confirmation_case', entityId, eventId: eventId ?? `${type}:${entityId}:${crypto.randomUUID()}` }).catch(() => undefined)
}
const hrUserIds = async (tenantId: string) => [...new Set([...(await userIdsWithRole(tenantId, 'hr_admin')), ...(await userIdsWithRole(tenantId, 'system_admin'))])]
const userOfEmployee = async (tenantId: string, employeeId?: string | null) => (employeeId ? ((await Employee.findOne({ _id: employeeId, tenantId }).select('userId').lean()) as any)?.userId ?? null : null)

// What the caller may see of a case: HR everything; the reviewing manager everything; the employee only the outcome
function view(c: any, e: any, req: any) {
  const out: any = { ...ser(c), employeeName: name(e), employeeCode: e?.employeeCode ?? null }
  const { userId, employeeId, roleIds } = req.user
  const reviewer = reviewerOf(c, e)
  out.canReview = c.status === 'manager_review' && !!employeeId && reviewer === employeeId && e._id !== employeeId
  out.canReviewOnBehalf = isHr(roleIds) && c.status === 'manager_review' && e?.userId !== userId
  const seesReview = isHr(roleIds) || (employeeId && (e?.managerId === employeeId || reviewer === employeeId))
  if (!seesReview) { delete out.review; delete out.reviewerEmployeeId; if (out.decision) out.decision = { outcome: out.decision.outcome, newEndDate: out.decision.newEndDate, at: out.decision.at } }
  if (e?.userId === userId && c.status !== 'closed') out.status = 'in_review'
  // the extension the manager recommended, as a date, for HR's date box; and how early a confirmation would be
  const end: Date | null = e?.probationEndDate ?? c.probationEndDate ?? null
  if (seesReview && out.review?.recommendation === 'extend' && out.review.extensionMonths && end) out.suggestedEndDate = day(addMonths(end, out.review.extensionMonths))
  if (end) out.daysEarly = Math.max(0, Math.ceil((end.getTime() - todayUtc().getTime()) / 86400000))
  out.letterAvailable = c.status === 'closed' && ['confirmed', 'extended'].includes(c.decision?.outcome)
  return out
}

// ── who is coming up (probation ending within 90 days or already past, not yet confirmed, no open review): HR sees everyone, a manager their own people
confirmationRouter.get('/due', asyncHandler(async (req, res) => {
  const { tenantId, employeeId, roleIds } = req.user!
  const hr = isHr(roleIds)
  if (!hr && !(roleIds.includes('manager') && employeeId)) throw new AppError('Access denied', 403)
  const soon = new Date(todayUtc().getTime() + 90 * 86400000)
  const open: any[] = await ConfirmationCase.find({ tenantId, status: { $ne: 'closed' } }).select('employeeId').lean()
  const rows: any[] = await Employee.find({ tenantId, active: true, confirmationDate: null, probationEndDate: { $ne: null, $lte: soon }, _id: { $nin: open.map((o) => o.employeeId) }, ...(!hr && { managerId: employeeId }) }).sort({ probationEndDate: 1 }).limit(200).select('firstName lastName employeeCode probationEndDate managerId').lean()
  const now = todayUtc().getTime()
  res.json({ success: true, data: rows.map((e) => ({ employeeId: e._id, name: name(e), code: e.employeeCode, probationEndDate: day(e.probationEndDate), daysLeft: Math.round((e.probationEndDate.getTime() - now) / 86400000), hasManager: !!e.managerId, canStart: hr })) })
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
  if (e.managerId) await tell(tenantId, [await userOfEmployee(tenantId, e.managerId)], 'confirmation.review_opened', `Probation review: ${name(e)}`, `Their probation ends on ${longDate(e.probationEndDate)}. Please rate them and recommend what to do.`, c._id)
  else await tell(tenantId, (await hrUserIds(tenantId)).filter((u) => u !== userId), 'confirmation.hr_waiting', `Probation review waiting for HR: ${name(e)}`, 'This person has no manager, so the decision is with HR.', c._id)
  res.status(201).json({ success: true, data: view(c.toObject(), e, req) })
}))

// HR sees every case; a manager the open ones for their direct reports; an employee their own
confirmationRouter.get('/cases', asyncHandler(async (req, res) => {
  const { tenantId, employeeId, roleIds } = req.user!
  const q: any = { tenantId }
  const hr = isHr(roleIds)
  if (!hr) {
    const team: any[] = employeeId ? await Employee.find({ tenantId, managerId: employeeId, active: true }).select('_id').lean() : []
    const reassigned: any[] = employeeId ? await ConfirmationCase.find({ tenantId, reviewerEmployeeId: employeeId }).select('employeeId').lean() : []
    q.employeeId = { $in: [...team.map((t) => t._id), ...reassigned.map((r) => r.employeeId), ...(employeeId ? [employeeId] : [])] }
  }
  if (typeof req.query.status === 'string' && req.query.status) q.status = req.query.status
  let rows: any[] = await ConfirmationCase.find(q).sort({ createdAt: -1 }).limit(200).lean()
  if (!hr) rows = rows.filter((r) => !(r.decision?.outcome === 'cancelled' && r.employeeId === employeeId)) // a cancelled review is HR's housekeeping, not news for the employee
  const em = await empMap(tenantId, rows.map((r) => r.employeeId))
  res.json({ success: true, data: rows.map((r) => view(r, em.get(r.employeeId), req)) })
}))

async function loadCase(req: any, id: string) {
  const { tenantId, employeeId, roleIds } = req.user
  const c: any = await ConfirmationCase.findOne({ _id: id, tenantId }).lean()
  const e: any = c ? (await Employee.findOne({ _id: c.employeeId, tenantId }).lean()) : null
  if (!c || !e || !(isHr(roleIds) || e.managerId === employeeId || reviewerOf(c, e) === employeeId || e._id === employeeId)) throw new AppError('Review not found', 404)
  if (c.decision?.outcome === 'cancelled' && !isHr(roleIds) && e._id === employeeId) throw new AppError('Review not found', 404)
  return { c, e }
}
confirmationRouter.get('/cases/:id', validate(z.object({ params: idp })), asyncHandler(async (req, res) => {
  const { c, e } = await loadCase(req, String(req.params.id))
  res.json({ success: true, data: view(c, e, req) })
}))

const Review = z.object({ rating: z.number().int().min(1).max(5), strengths: z.string().trim().min(3).max(1500), concerns: z.string().trim().max(1500).default(''), recommendation: z.enum(['confirm', 'extend', 'not_confirm']), extensionMonths: z.number().int().min(1).max(12).optional(), onBehalfReason: z.string().trim().min(5).max(500).optional() }).strict()
confirmationRouter.post('/cases/:id/review', validate(z.object({ params: idp, body: Review })), asyncHandler(async (req, res) => {
  const { tenantId, userId, employeeId, roleIds } = req.user!
  const { c, e } = await loadCase(req, String(req.params.id))
  const isReviewer = reviewerOf(c, e) === employeeId && e._id !== employeeId
  // HR can write the review for a manager who is away or has left, with a reason (never for their own case)
  const onBehalf = !isReviewer && isHr(roleIds) && !!req.body.onBehalfReason && e.userId !== userId
  if (!isReviewer && !onBehalf) throw new AppError('Only the employee\'s reviewing manager reviews. HR can review on behalf of an absent manager, with a reason.', 403)
  if (c.status !== 'manager_review') throw new AppError('This review is not waiting for the manager', 409)
  if (req.body.recommendation === 'extend' && !req.body.extensionMonths) throw new AppError('Say how many months to extend', 400)
  if (req.body.recommendation !== 'confirm' && !req.body.concerns) throw new AppError('Explain the concerns behind a recommendation not to confirm', 400)
  const { onBehalfReason, ...body } = req.body
  const r: any = await ConfirmationCase.findOneAndUpdate({ _id: c._id, tenantId, status: 'manager_review' }, { $set: { status: 'hr_decision', review: { ...body, by: userId, at: new Date(), ...(onBehalf && { onBehalfOf: { reason: onBehalfReason } }) } } }, { returnDocument: 'after' }).lean()
  if (!r) throw new AppError('Someone else just acted on this review', 409)
  await AuditLog.create({ tenantId, userId, action: onBehalf ? 'CONFIRMATION_REVIEWED_ON_BEHALF' : 'CONFIRMATION_REVIEWED', entityType: 'confirmation_case', entityId: c._id, newValue: { recommendation: req.body.recommendation, rating: req.body.rating, ...(onBehalf && { reason: onBehalfReason }) } })
  await tell(tenantId, (await hrUserIds(tenantId)).filter((u) => u !== userId && u !== e.userId), 'confirmation.hr_waiting', `Probation review ready for your decision: ${name(e)}`, `${onBehalf ? 'HR wrote the review for the manager' : 'The manager has finished the review'}. Recommendation: ${String(req.body.recommendation).replace('_', ' ')}.`, c._id)
  res.json({ success: true, data: view(r, e, req) })
}))

// HR hands the review to another manager (the manager left, is away, or the person moved)
confirmationRouter.post('/cases/:id/reassign', requireRoles(...HR), validate(z.object({ params: idp, body: z.object({ managerEmployeeId: z.string().uuid(), reason: z.string().trim().min(5).max(500) }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const { c, e } = await loadCase(req, String(req.params.id))
  if (c.status !== 'manager_review') throw new AppError('Only a review that is waiting for the manager can be handed over', 409)
  const m: any = await Employee.findOne({ _id: req.body.managerEmployeeId, tenantId, active: true, employmentStatus: { $ne: 'terminated' } }).select('firstName lastName userId').lean()
  if (!m) throw new AppError('Manager not found', 404)
  if (m._id === e._id) throw new AppError('A person cannot review themselves', 400)
  await ConfirmationCase.updateOne({ _id: c._id, tenantId, status: 'manager_review' }, { $set: { reviewerEmployeeId: m._id }, $push: { history: { action: 'reassigned', to: m._id, reason: req.body.reason, by: userId, at: new Date() } } })
  await AuditLog.create({ tenantId, userId, action: 'CONFIRMATION_REASSIGNED', entityType: 'confirmation_case', entityId: c._id, newValue: { to: m._id, reason: req.body.reason } })
  await tell(tenantId, [m.userId], 'confirmation.review_opened', `Probation review: ${name(e)}`, 'HR asked you to review this person\'s probation. Please rate them and recommend what to do.', c._id)
  res.json({ success: true, data: { reviewer: name(m) } })
}))

// HR closes a stuck case without a decision; the person reappears in "due soon" and a new review can be opened
confirmationRouter.post('/cases/:id/cancel', requireRoles(...HR), validate(z.object({ params: idp, body: z.object({ reason: z.string().trim().min(5).max(500) }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const { c } = await loadCase(req, String(req.params.id))
  if (c.status === 'closed') throw new AppError('This review is already closed', 409)
  const r = await ConfirmationCase.updateOne({ _id: c._id, tenantId, status: { $ne: 'closed' } }, { $set: { status: 'closed', decision: { outcome: 'cancelled', note: req.body.reason, newEndDate: null, by: userId, at: new Date() } } })
  if (!r.modifiedCount) throw new AppError('Someone else just acted on this review', 409)
  await AuditLog.create({ tenantId, userId, action: 'CONFIRMATION_CANCELLED', entityType: 'confirmation_case', entityId: c._id, newValue: { reason: req.body.reason } })
  res.json({ success: true, data: { status: 'closed' } })
}))

const Decide = z.object({ outcome: z.enum(['confirmed', 'extended', 'not_confirmed']), note: z.string().trim().max(1000).default(''), newEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), ackEarly: z.boolean().optional() }).strict()
confirmationRouter.post('/cases/:id/decide', requireRoles(...HR), validate(z.object({ params: idp, body: Decide })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const { c, e } = await loadCase(req, String(req.params.id))
  if (e.userId === userId) throw new AppError('You cannot decide your own confirmation', 403)
  if (c.status !== 'hr_decision') throw new AppError('This review is not waiting for HR', 409)
  const { outcome, note, newEndDate, ackEarly } = req.body
  if (outcome !== 'confirmed' && !note) throw new AppError('Give a reason', 400)
  const base: Date = e.probationEndDate ?? c.probationEndDate
  // confirming before the probation has run its course needs a deliberate "yes"
  if (outcome === 'confirmed' && base && base.getTime() > todayUtc().getTime() && !ackEarly) {
    const left = Math.ceil((base.getTime() - todayUtc().getTime()) / 86400000)
    throw new AppError(`Probation ends on ${longDate(base)}, ${left} day${left === 1 ? '' : 's'} from now. Confirm anyway?`, 409, 'EARLY_CONFIRMATION')
  }
  let end: Date | null = null
  if (outcome === 'extended') {
    if (!newEndDate) throw new AppError('Choose the new probation end date', 400)
    end = new Date(`${newEndDate}T00:00:00.000Z`)
    if (end <= base) throw new AppError('The new end date must be after the current one', 400)
    if (end.getTime() > base.getTime() + 366 * 86400000) throw new AppError('A probation can be extended by at most a year', 400)
  }
  const r: any = await ConfirmationCase.findOneAndUpdate({ _id: c._id, tenantId, status: 'hr_decision' }, { $set: { status: 'closed', decision: { outcome, note, newEndDate: end ? day(end) : null, by: userId, at: new Date(), ...(outcome === 'confirmed' && base && base.getTime() > todayUtc().getTime() && { early: true }) } } }, { returnDocument: 'after' }).lean()
  if (!r) throw new AppError('Someone else just acted on this review', 409)
  // The data model has no "probation" status: a person is on probation until their confirmation date is set, so confirming sets it
  if (outcome === 'confirmed') await Employee.updateOne({ _id: e._id, tenantId }, { $set: { confirmationDate: todayUtc() } })
  if (outcome === 'extended') await Employee.updateOne({ _id: e._id, tenantId }, { $set: { probationEndDate: end } })
  await AuditLog.create({ tenantId, userId, action: 'CONFIRMATION_DECIDED', entityType: 'confirmation_case', entityId: c._id, newValue: { outcome, newEndDate: end ? day(end) : null } })
  if (outcome === 'confirmed') await AuditLog.create({ tenantId, userId, action: 'EMPLOYEE_CONFIRMED', entityType: 'employee', entityId: e._id, newValue: { confirmationDate: day(todayUtc()), probationEndDate: base ? day(base) : null } })
  // the person hears the outcome only (never the concerns or HR's note); the reviewing manager hears it too
  const said = outcome === 'confirmed' ? 'Your probation is complete and you are confirmed.' : outcome === 'extended' ? `Your probation has been extended until ${longDate(end!)}.` : 'Your probation review is complete. HR will talk to you about the outcome.'
  await tell(tenantId, [e.userId], 'confirmation.decided', `Your probation review: ${outcome === 'confirmed' ? 'confirmed' : outcome === 'extended' ? 'extended' : 'decided'}`, said, c._id)
  await tell(tenantId, [await userOfEmployee(tenantId, reviewerOf(c, e))].filter((u) => u !== userId), 'confirmation.decided', `Probation decided: ${name(e)}`, `Outcome: ${outcome.replace('_', ' ')}.`, c._id)
  res.json({ success: true, data: { ...view(r, e, req), nextStep: outcome === 'not_confirmed' ? 'Start an exit for this person if you are ending the employment.' : null } })
}))

// ── Letters: a confirmation or extension letter from the company's template, as a PDF (the PDF engine is the one payslips use)
const PLACEHOLDERS = ['name', 'designation', 'date', 'company', 'newEndDate', 'probationEndDate', 'employeeCode']
export const DEFAULT_TEMPLATES = {
  confirmed: 'Dear {name},\n\nWe are pleased to confirm your employment with {company} as {designation}, with effect from {date}. You have successfully completed your probation period.\n\nWe thank you for your contribution so far and look forward to your continued success with us.\n\nYours sincerely,\nHuman Resources\n{company}',
  extended: 'Dear {name},\n\nFollowing the review of your probation, your probation period with {company} as {designation} is extended until {newEndDate}.\n\nWe will review your progress again before that date. Please speak to your manager or to HR if you have any questions.\n\nYours sincerely,\nHuman Resources\n{company}',
}
export const fillTemplate = (t: string, vars: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
const unknownPlaceholders = (t: string) => [...new Set([...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !PLACEHOLDERS.includes(k)))]
const templates = async (tenantId: string) => { const d: any = await mongoose.connection.collection('confirmation_templates').findOne({ _id: tenantId } as any); return { confirmed: d?.confirmed ?? DEFAULT_TEMPLATES.confirmed, extended: d?.extended ?? DEFAULT_TEMPLATES.extended } }
export function letterHtml(company: string, dateText: string, body: string) {
  const paras = escapeHtml(body).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.65;color:#222;padding:30px 12px}h1{font-size:19px;margin:0 0 2px}.muted{color:#666;margin-bottom:6px}hr{border:0;border-top:1px solid #ccc;margin:14px 0 22px}p{margin:0 0 14px}</style></head><body><h1>${escapeHtml(company)}</h1><div class="muted">${escapeHtml(dateText)}</div><hr>${paras}</body></html>`
}
const sendPdf = (res: any, buf: Buffer, file: string) => { res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${file}"`); res.send(buf) }

confirmationRouter.get('/templates', requireRoles(...HR), asyncHandler(async (req, res) => {
  res.json({ success: true, data: { ...(await templates(req.user!.tenantId)), placeholders: PLACEHOLDERS, defaults: DEFAULT_TEMPLATES } })
}))
confirmationRouter.put('/templates', requireRoles(...HR), validate(z.object({ body: z.object({ confirmed: z.string().trim().min(20).max(4000).optional(), extended: z.string().trim().min(20).max(4000).optional() }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  for (const [k, t] of Object.entries(req.body) as [string, string][]) { const bad = unknownPlaceholders(t); if (bad.length) throw new AppError(`The ${k} letter uses {${bad.join('}, {')}}, which is not a known placeholder. Use: ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`, 400) }
  await mongoose.connection.collection('confirmation_templates').updateOne({ _id: tenantId } as any, { $set: { ...req.body, updatedBy: userId, updatedAt: new Date() } }, { upsert: true })
  await AuditLog.create({ tenantId, userId, action: 'CONFIRMATION_TEMPLATE_CHANGED', entityType: 'confirmation_template', entityId: tenantId, newValue: { changed: Object.keys(req.body) } })
  res.json({ success: true, data: await templates(tenantId) })
}))
// A preview with sample names, so HR sees the letter before anyone gets it
confirmationRouter.get('/templates/preview', requireRoles(...HR), validate(z.object({ query: z.object({ kind: z.enum(['confirmed', 'extended']) }) })), asyncHandler(async (req, res) => {
  const { tenantId } = req.user!
  const t: any = await Tenant.findById(tenantId).select('name').lean()
  const kind = String(req.query.kind) as 'confirmed' | 'extended'
  const vars = { name: 'Sample Person', designation: 'Sales Executive', date: longDate(new Date()), company: t?.name ?? 'Your company', newEndDate: longDate(addMonths(new Date(), 3)), probationEndDate: longDate(new Date()), employeeCode: 'EMP0000' }
  sendPdf(res, await generatePayslipPdf(letterHtml(vars.company, vars.date, fillTemplate((await templates(tenantId))[kind], vars))), `${kind}-letter-preview.pdf`)
}))
// The letter of a decided case: HR, the reviewing manager and the person themselves
confirmationRouter.get('/cases/:id/letter', validate(z.object({ params: idp })), asyncHandler(async (req, res) => {
  const { tenantId } = req.user!
  const { c, e } = await loadCase(req, String(req.params.id))
  const outcome = c.decision?.outcome
  if (c.status !== 'closed' || !['confirmed', 'extended'].includes(outcome)) throw new AppError('There is no letter for this review', 404)
  const [t, pos, tpl]: any[] = await Promise.all([Tenant.findById(tenantId).select('name').lean(), e.jobPositionId ? JobPosition.findById(e.jobPositionId).select('title').lean() : null, templates(tenantId)])
  const when: Date = c.decision.at ?? new Date()
  const vars = { name: name(e) ?? '', designation: pos?.title ?? 'your role', date: longDate(outcome === 'confirmed' ? (e.confirmationDate ?? when) : when), company: t?.name ?? '', newEndDate: c.decision.newEndDate ? longDate(new Date(`${c.decision.newEndDate}T00:00:00Z`)) : '', probationEndDate: longDate(c.probationEndDate ?? when), employeeCode: e.employeeCode ?? '' }
  sendPdf(res, await generatePayslipPdf(letterHtml(vars.company, longDate(when), fillTemplate(tpl[outcome as 'confirmed' | 'extended'], vars))), `${outcome}-letter-${e.employeeCode ?? 'employee'}.pdf`)
}))

// Daily job 'probation-reminders': 30 and 7 days before a probation ends, HR and the manager are told once each (no mail if a review is already open)
export async function probationReminders(only?: string) {
  const tenants: string[] = only ? [only] : ((await Tenant.find({ active: true }).select('_id').lean()) as any[]).map((t) => String(t._id))
  let sent = 0
  for (const tenantId of tenants) {
    if (!(await tenantHasFeature(tenantId, 'confirmation'))) continue
    const today = todayUtc()
    const open = new Set(((await ConfirmationCase.find({ tenantId, status: { $ne: 'closed' } }).select('employeeId').lean()) as any[]).map((o) => o.employeeId))
    const rows: any[] = await Employee.find({ tenantId, active: true, employmentStatus: { $ne: 'terminated' }, confirmationDate: null, probationEndDate: { $ne: null, $gte: today, $lte: new Date(today.getTime() + 30 * 86400000) } }).select('firstName lastName managerId userId probationEndDate').lean()
    const hr = await hrUserIds(tenantId)
    for (const e of rows) {
      if (open.has(e._id)) continue
      const left = Math.round((e.probationEndDate.getTime() - today.getTime()) / 86400000)
      const thr = left <= 7 ? 7 : 30
      const who = [...hr, await userOfEmployee(tenantId, e.managerId)].filter((u) => u && u !== e.userId)
      // one notification per (person, threshold, end date, recipient): notify drops a repeat with the same event id
      await tell(tenantId, who, 'confirmation.due', `Probation ending ${thr === 7 ? 'within a week' : 'within 30 days'}: ${name(e)}`, `Their probation ends on ${longDate(e.probationEndDate)}. HR can open the review under Confirmations.`, e._id, `probation:${e._id}:${thr}:${day(e.probationEndDate)}`)
      sent += who.length
    }
  }
  return sent
}

// Self-check: node -r dotenv/config -r ts-node/register/transpile-only src/modules/employees/confirmation.mongo.router.ts
if (require.main === module) {
  console.assert(fillTemplate('Dear {name}, {unknown} {company}', { name: 'Mary', company: 'Acme' }) === 'Dear Mary, {unknown} Acme', 'placeholders are filled and unknown ones are left as they are')
  console.assert(unknownPlaceholders('Hi {name} {foo} {foo} {bar}').join() === 'foo,bar', 'unknown placeholders are listed once')
  console.assert(unknownPlaceholders(DEFAULT_TEMPLATES.confirmed + DEFAULT_TEMPLATES.extended).length === 0, 'the default letters use only known placeholders')
  console.assert(letterHtml('A & B', '1 January 2026', 'Hi <b>\n\nBye').includes('A &amp; B') && !letterHtml('x', 'y', '<script>').includes('<script>'), 'the letter is escaped')
  console.log('confirmation letter check done')
  process.exit(0)
}

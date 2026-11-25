import { Router } from 'express'
import { z } from 'zod'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { requireFeature } from '../../middleware/module.middleware.mongo'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { getReportingSubtreeIds } from '../../shared/utils/access'
import { Employee } from '../../infrastructure/mongo/mongo'
import { notify, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { isHR, canManage, audit, afterGoalChange } from './performance.service'
import { addProgress, addHistory, claimReminder } from './performance.meta'
import { businessToday } from '../../shared/utils/businessDate'

// Goal extras on the MongoDB API, mounted before the main performance router under /api/v1/performance:
//  - who the caller may set goals for (server-driven, searchable picker);
//  - withdrawing a sent goal (the manager; a reason is needed once the person accepted it), and HR reopening a reviewed goal;
//  - the person's progress updates;
//  - the daily goal reminders job.
export const performanceExtras = Router()
performanceExtras.use(authenticate, requireFeature('pms'))
const idp = z.object({ id: z.string().uuid() })
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data })
const goals = () => mongoose.connection.collection('performance_goals')
const cycles = () => mongoose.connection.collection('performance_cycles')

async function tell(tenantId: string, userId: string | null | undefined, type: string, title: string, body: string, goalId: string, stamp = String(Date.now())) {
  if (userId) await notify({ tenantId, userIds: [userId], type, title, body, link: '/performance', entityType: 'performance_goal', entityId: goalId, eventId: `${type}:${goalId}:${stamp}` }).catch(() => undefined)
}
async function loadGoal(req: any, id: string) {
  const g: any = await goals().findOne({ _id: id, tenantId: req.user.tenantId } as any)
  if (!g) throw new AppError('Goal not found', 404)
  const own = g.employeeId === req.user.employeeId
  const manages = !own && (await canManage(req.user, g.employeeId))
  if (!own && !manages) throw new AppError('Goal not found', 404)
  const cycle: any = await cycles().findOne({ _id: g.cycleId } as any)
  return { g: { ...g, id: g._id }, own, manages, cycle }
}

// People the caller may set a goal for: HR anyone active except themselves, a manager the people below them in the reporting line
performanceExtras.get('/people', validate(z.object({ query: z.object({ q: z.string().trim().max(40).default('') }) })), asyncHandler(async (req, res) => {
  const { tenantId, employeeId, roleIds } = req.user!
  const where: any = { tenantId, active: true, employmentStatus: { $ne: 'terminated' }, _id: { $ne: employeeId ?? '-' } }
  if (!isHR(req.user!)) {
    if (!employeeId || !roleIds.includes('manager')) return ok(res, [])
    where._id = { $in: (await getReportingSubtreeIds(employeeId, tenantId)).filter((x) => x !== employeeId) }
  }
  const words = String(req.query.q ?? '').split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (words.length) where.$and = words.map((w) => ({ $or: [{ firstName: new RegExp(w, 'i') }, { lastName: new RegExp(w, 'i') }, { employeeCode: new RegExp(`^${w}`, 'i') }] }))
  const rows: any[] = await Employee.find(where).sort({ firstName: 1, lastName: 1 }).limit(20).select('firstName lastName employeeCode').lean()
  ok(res, rows.map((e) => ({ id: e._id, name: `${e.firstName} ${e.lastName}`, code: e.employeeCode })))
}))

// Withdraw: a goal that was sent or agreed is taken back. Before the person accepts, no reason is needed; after, a reason is, and they are told.
performanceExtras.post('/goals/:id/withdraw', validate(z.object({ params: idp, body: z.object({ reason: z.string().trim().min(3).max(500).optional() }).strict() })), asyncHandler(async (req, res) => {
  const { g, manages } = await loadGoal(req, String(req.params.id))
  if (!manages) throw new AppError('Only the manager who sets the goal, or HR, can withdraw it', 403)
  if (['reviewed', 'acknowledged'].includes(g.status)) throw new AppError('This goal has been reviewed. HR can reopen the review first.', 400)
  if (g.status === 'withdrawn') throw new AppError('This goal was already withdrawn', 409)
  if (g.status === 'accepted' && !req.body.reason) throw new AppError('Give a reason: the person already accepted this goal', 400)
  const r = await goals().updateOne({ _id: g._id, status: g.status } as any, { $set: { status: 'withdrawn', withdrawnAt: new Date(), updatedAt: new Date() } })
  if (!r.modifiedCount) throw new AppError('Someone just changed this goal. Reload and try again.', 409)
  await addHistory(g.tenantId, g._id, 'withdrawn', req.user!.userId, req.body.reason ?? null)
  await audit(req.user!, 'GOAL_WITHDRAWN', g._id, { was: g.status, reason: req.body.reason ?? null })
  if (g.status !== 'draft') await tell(g.tenantId, await userIdOfEmployee(g.tenantId, g.employeeId), 'performance.goal.withdrawn', `Goal withdrawn: ${g.title}`, req.body.reason ? `Reason: ${req.body.reason}` : 'Your manager took this goal back before you accepted it.', g._id)
  await afterGoalChange(g.tenantId, g.employeeId)
  ok(res, { status: 'withdrawn' })
}))

// Reopen: HR puts a reviewed or acknowledged goal back to "agreed" so the manager can review it again
performanceExtras.post('/goals/:id/reopen', validate(z.object({ params: idp, body: z.object({ reason: z.string().trim().min(5).max(500) }).strict() })), asyncHandler(async (req, res) => {
  if (!isHR(req.user!)) throw new AppError('Only HR can reopen a goal review', 403)
  const { g, cycle } = await loadGoal(req, String(req.params.id))
  if (g.employeeId === req.user!.employeeId) throw new AppError('You cannot reopen your own goal review. Another HR admin does it.', 403)
  if (!['reviewed', 'acknowledged'].includes(g.status)) throw new AppError('Only a reviewed goal can be reopened', 400)
  if (cycle?.status === 'closed') throw new AppError('The review cycle is closed. Reopen the cycle first.', 400)
  const r = await goals().updateOne({ _id: g._id, status: g.status } as any, { $set: { status: 'accepted', acknowledgedAt: null, reopenedAt: new Date(), updatedAt: new Date() } })
  if (!r.modifiedCount) throw new AppError('Someone just changed this goal. Reload and try again.', 409)
  await addHistory(g.tenantId, g._id, 'review reopened', req.user!.userId, req.body.reason)
  await audit(req.user!, 'GOAL_REVIEW_REOPENED', g._id, { reason: req.body.reason, previousScore: g.score ?? null })
  const stamp = String(Date.now())
  await tell(g.tenantId, await userIdOfEmployee(g.tenantId, g.employeeId), 'performance.goal.reopened', `Review reopened: ${g.title}`, `HR reopened the review: ${req.body.reason}`, g._id, stamp)
  await tell(g.tenantId, g.setByUserId, 'performance.goal.reopened', `Review reopened: ${g.title}`, `HR reopened your review for another look: ${req.body.reason}`, g._id, stamp)
  await afterGoalChange(g.tenantId, g.employeeId)
  ok(res, { status: 'accepted' })
}))

// Progress: the person tells how far along they are (0 to 100) with an optional note; the manager is told
performanceExtras.post('/goals/:id/progress', validate(z.object({ params: idp, body: z.object({ percent: z.number().min(0).max(100), note: z.string().trim().max(500).optional() }).strict() })), asyncHandler(async (req, res) => {
  const { g, own } = await loadGoal(req, String(req.params.id))
  if (!own) throw new AppError('Only the person the goal is for can update its progress', 403)
  if (g.status !== 'accepted') throw new AppError('Progress can be reported once you have accepted the goal and until it is reviewed', 400)
  const percent = Math.round(req.body.percent * 10) / 10
  await addProgress(g.tenantId, g._id, percent, req.body.note ?? null)
  await audit(req.user!, 'GOAL_PROGRESS', g._id, { percent })
  await tell(g.tenantId, g.setByUserId, 'performance.goal.progress', `Progress: ${g.title}`, `${percent}% done${req.body.note ? `. ${req.body.note}` : ''}`, g._id)
  ok(res, { progress: percent })
}))

// Daily reminders (job 'goal-reminders'), once per goal, kind and day: a deadline within 3 days or passed (the person, and the manager once it is late),
// a goal waiting 3 days for acceptance (the person), and an agreed goal whose cycle has ended, or whose deadline passed, with no review (the manager)
export async function goalReminders(only?: string) {
  const tenants: string[] = only ? [only] : ((await mongoose.connection.collection('tenants').find({ active: true }).project({ _id: 1 }).toArray()) as any[]).map((t) => t._id)
  let sent = 0
  for (const tenantId of tenants) {
    const today = (await businessToday(tenantId)).toISOString().slice(0, 10)
    const day3 = new Date(Date.parse(`${today}T00:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10)
    const rows: any[] = await goals().find({ tenantId, status: { $in: ['sent', 'accepted'] } } as any).limit(2000).toArray()
    if (!rows.length) continue
    const meta = new Map(((await mongoose.connection.collection('performance_goal_meta').find({ _id: { $in: rows.map((g) => g._id) } } as any).toArray()) as any[]).map((m) => [String(m._id), m]))
    const cyc = new Map(((await cycles().find({ _id: { $in: [...new Set(rows.map((g) => g.cycleId))] } } as any).toArray()) as any[]).map((c) => [String(c._id), c]))
    const send = async (g: any, kind: string, to: 'person' | 'manager', title: string, body: string) => {
      if (!(await claimReminder(tenantId, g._id, `${kind}-${to}`, today))) return
      const uid = to === 'person' ? await userIdOfEmployee(tenantId, g.employeeId) : g.setByUserId
      if (!uid) return
      await notify({ tenantId, userIds: [uid], type: `performance.goal.${kind}`, title, body, link: '/performance', entityType: 'performance_goal', entityId: g._id, eventId: `goal-reminder:${kind}:${to}:${g._id}:${today}` }).catch(() => undefined)
      sent++
    }
    for (const g of rows) {
      const deadline: string | null = meta.get(String(g._id))?.deadline ?? null
      const ended = cyc.get(String(g.cycleId))?.endDate ? new Date(cyc.get(String(g.cycleId)).endDate).toISOString().slice(0, 10) < today : false
      if (g.status === 'sent' && g.sentAt && new Date(g.sentAt).getTime() <= Date.now() - 3 * 86400000) await send(g, 'unaccepted', 'person', `Goal waiting for you: ${g.title}`, 'Please accept it, or send it back with a note.')
      if (g.status === 'accepted' && deadline) {
        if (deadline < today) {
          await send(g, 'overdue', 'person', `Goal overdue: ${g.title}`, `The deadline was ${deadline}. Update your progress.`)
          await send(g, 'overdue', 'manager', `Goal overdue: ${g.title}`, `The deadline was ${deadline} and it has not been reviewed.`)
        } else if (deadline <= day3) await send(g, 'due', 'person', `Goal due soon: ${g.title}`, `The deadline is ${deadline}.`)
      }
      if (g.status === 'accepted' && ended) await send(g, 'review_due', 'manager', `Review due: ${g.title}`, 'The review cycle has ended and this goal has not been reviewed.')
    }
  }
  return sent
}

import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { leaveService } from '../leave/leave.service'
import { attendanceService } from '../attendance/attendance.service'
import { expenseRequestService } from '../expenses/requests.service'
import { policyRequestsService } from '../policies/policy-requests.service'
import { pendingApprovals, approvalTrail, chainService, delegationService, RequestType } from './approvals.service'

const id = z.string().uuid()
const type = z.enum(['leave', 'regularisation', 'overtime', 'pre_approval', 'policy_exception'])
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const level = z.object({ kind: z.enum(['manager', 'skip_manager', 'hr', 'user']), userId: z.string().uuid().optional() }).strict()

// Decide a request of any type through its own module, so balances, records and events stay right
async function decide(u: AccessUser, t: RequestType, rid: string, approve: boolean, comments: string | undefined, override = false) {
  const opts = { override, comments }
  if (t === 'leave') return approve ? leaveService.approveLeave(rid, u, { comments } as any, opts) : leaveService.rejectLeave(rid, u, { comments } as any, opts)
  if (t === 'regularisation') return approve ? attendanceService.approveRegularisation(rid, u, opts) : attendanceService.rejectRegularisation(rid, u, opts)
  if (t === 'overtime') return approve ? attendanceService.approveOvertime(rid, u, undefined, opts) : attendanceService.rejectOvertime(rid, u, opts)
  if (t === 'pre_approval') return expenseRequestService.decide(u, rid, approve, comments, override)
  if (t === 'policy_exception') return policyRequestsService.decide(u, rid, approve, comments, override)
  throw new AppError('Unknown request type', 400)
}

export const approvalsRouter = Router()
approvalsRouter.use(authenticate)
const hr = requireRoles('hr_admin', 'system_admin')

approvalsRouter.get('/pending', asyncHandler(async (req, res) => res.json({ success: true, data: await pendingApprovals(req.user!, false) })))
approvalsRouter.get('/monitor', hr, asyncHandler(async (req, res) => res.json({ success: true, data: await pendingApprovals(req.user!, true) })))

// Chains (HR)
approvalsRouter.get('/chains', hr, asyncHandler(async (req, res) => res.json({ success: true, data: await chainService.list(req.user!.tenantId) })))
const Chain = z.object({ requestType: type, name: z.string().trim().min(2).max(80), priority: z.number().int().min(0).max(1000), leaveTypeIds: z.array(id).max(50), minDays: z.number().min(0).max(366).nullable(), levels: z.array(level).min(1).max(5), active: z.boolean() }).partial().strict()
approvalsRouter.post('/chains', hr, validate(z.object({ body: Chain.required({ requestType: true, name: true, levels: true }) })), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await chainService.save(req.user!, null, req.body) })
}))
approvalsRouter.patch('/chains/:id', hr, validate(z.object({ params: z.object({ id }), body: Chain.omit({ requestType: true }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await chainService.save(req.user!, String(req.params.id), req.body) })
}))

// Delegations: people hand their approvals to someone while away; HR can set one up for anyone
approvalsRouter.get('/delegations', asyncHandler(async (req, res) => res.json({ success: true, data: await delegationService.list(req.user!) })))
approvalsRouter.post('/delegations', validate(z.object({ body: z.object({ fromUserId: z.string().uuid().optional(), toUserId: z.string().uuid(), startDate: ymd, endDate: ymd, reason: z.string().trim().max(200).optional() }).strict() })), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await delegationService.create(req.user!, req.body) })
}))
approvalsRouter.post('/delegations/:id/end', validate(z.object({ params: z.object({ id }) })), asyncHandler(async (req, res) => res.json({ success: true, data: await delegationService.end(req.user!, String(req.params.id)) })))

// Acting on one request
approvalsRouter.get('/:type/:id/trail', validate(z.object({ params: z.object({ type, id }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await approvalTrail(req.user!.tenantId, req.params.type as RequestType, String(req.params.id)) })
}))
approvalsRouter.post('/:type/:id/approve', validate(z.object({ params: z.object({ type, id }), body: z.object({ comments: z.string().trim().max(500).optional() }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await decide(req.user!, req.params.type as RequestType, String(req.params.id), true, req.body.comments) })
}))
approvalsRouter.post('/:type/:id/reject', validate(z.object({ params: z.object({ type, id }), body: z.object({ comments: z.string().trim().min(1).max(500) }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await decide(req.user!, req.params.type as RequestType, String(req.params.id), false, req.body.comments) })
}))
approvalsRouter.post('/:type/:id/override', hr, validate(z.object({ params: z.object({ type, id }), body: z.object({ approve: z.boolean(), comments: z.string().trim().min(2).max(500) }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await decide(req.user!, req.params.type as RequestType, String(req.params.id), req.body.approve, req.body.comments, true) })
}))

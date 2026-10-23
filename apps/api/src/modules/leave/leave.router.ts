import { z } from 'zod'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { yearEndService } from './yearend.service'
import { balancesService } from './balances.service'
import { Router } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission, requireRoles } from '../../middleware/rbac.middleware'
import { leaveController } from './leave.controller'
import { contractController } from '../employees/contracts.controller'
import { validate } from '../../middleware/validate.middleware'
import { CreateContractSchema, ContractTransitionSchema } from '../employees/employees.schema'
import { CreateLeaveTypeSchema, UpdateLeaveTypeSchema } from './leave.schema'
import { leaveExtras, ApplyLeaveSchema, BlackoutBody } from './leave-extras.service'
import { returnLeave } from './leave-rules'
import { leaveService } from './leave.service'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'

export const leaveRouter = Router()

leaveRouter.use(authenticate)

// ─── LEAVE TYPES ──────────────────────────────────────────────
leaveRouter.get('/types', requirePermission('leave:read'), leaveController.listTypes)
leaveRouter.get('/types/all', requirePermission('leave:configure'), leaveController.listAllTypes)
leaveRouter.post('/types', requirePermission('leave:configure'), validate(CreateLeaveTypeSchema), leaveController.createType)
leaveRouter.patch('/types/:id', requirePermission('leave:configure'), validate(UpdateLeaveTypeSchema), leaveController.updateType)

// ─── BALANCES ─────────────────────────────────────────────────
leaveRouter.get('/balances/me', requirePermission('leave:read'), leaveController.getMyBalances)
leaveRouter.get('/balances/:employeeId', requirePermission('leave:read'), leaveController.getEmployeeBalances)
leaveRouter.get('/allocations/:employeeId', requirePermission('leave:read'), leaveController.listAllocations)

// ─── REQUESTS ─────────────────────────────────────────────────
leaveRouter.post('/requests', requirePermission('leave:write'), validate(ApplyLeaveSchema), leaveController.applyLeave)
// Teammates already off on these dates (shown while applying)
leaveRouter.get('/overlap', requirePermission('leave:read'), validate(z.object({ query: z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) })), asyncHandler(async (req, res) => {
  if (!req.user!.employeeId) return res.json({ success: true, data: [] })
  res.json({ success: true, data: await leaveExtras.overlaps(req.user!.tenantId, req.user!.employeeId, new Date(`${req.query.startDate}T00:00:00Z`), new Date(`${req.query.endDate}T00:00:00Z`)) })
}))
leaveRouter.get('/requests/:id/attachment', requirePermission('leave:read'), validate(z.object({ params: z.object({ id: z.string().uuid() }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await leaveExtras.attachment(req.user!, String(req.params.id)) })
}))
// Blackout periods: everyone sees them; HR sets them
leaveRouter.get('/blackouts', requirePermission('leave:read'), asyncHandler(async (req, res) => { res.json({ success: true, data: await leaveExtras.blackouts(req.user!.tenantId) }) }))
leaveRouter.post('/blackouts', requirePermission('leave:configure'), validate(z.object({ body: BlackoutBody })), asyncHandler(async (req, res) => { res.status(201).json({ success: true, data: await leaveExtras.createBlackout(req.user!, req.body) }) }))
leaveRouter.post('/blackouts/:id/remove', requirePermission('leave:configure'), validate(z.object({ params: z.object({ id: z.string().uuid() }) })), asyncHandler(async (req, res) => { res.json({ success: true, data: await leaveExtras.removeBlackout(req.user!, String(req.params.id)) }) }))
leaveRouter.get('/requests/me', requirePermission('leave:read'), leaveController.listMyRequests)
leaveRouter.get('/requests/pending', requirePermission('leave:approve'), leaveController.getPendingApprovals)
leaveRouter.post('/requests/:id/approve', requirePermission('leave:approve'), validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({ comments: z.string().trim().max(500).optional(), shortfall: z.enum(['paid', 'unpaid']).optional() }).strict() })), leaveController.approve)
leaveRouter.post('/requests/:id/reject', requirePermission('leave:approve'), leaveController.reject)
leaveRouter.post('/requests/:id/cancel', requirePermission('leave:write'), leaveController.cancel)
// The approver sends a request back for changes; the person edits it and sends it again
leaveRouter.post('/requests/:id/return', requirePermission('leave:approve'), validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({ note: z.string().trim().min(3).max(500) }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await returnLeave(req.user!, String(req.params.id), req.body.note) })
}))
leaveRouter.post('/requests/:id/resubmit', requirePermission('leave:write'), validate(z.object({ params: z.object({ id: z.string().uuid() }), body: ApplyLeaveSchema.shape.body })), asyncHandler(async (req, res) => {
  const u = req.user!
  const old = await prisma.leaveRequest.findFirst({ where: { id: String(req.params.id), employeeId: u.employeeId ?? '-', status: 'returned' } })
  if (!old) throw new AppError('Only your own returned request can be sent again', 404)
  const fresh = await leaveService.applyLeave(u.employeeId!, u.tenantId, req.body)
  await prisma.leaveRequest.update({ where: { id: old.id }, data: { status: 'resubmitted' } })
  res.status(201).json({ success: true, data: fresh })
}))

// ─── TEAM CALENDAR ────────────────────────────────────────────
leaveRouter.get('/calendar/team', requirePermission('leave:read'), requireRoles('manager', 'hr_admin', 'system_admin'), leaveController.getTeamCalendar)

// ─── ALLOCATION REQUESTS ──────────────────────────────────────
leaveRouter.get('/allocation-requests/pending', requirePermission('leave:approve'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await balancesService.pendingRequests(req.user!) })
}))
const halfDays = (max: number) => z.number().positive().max(max).refine((d) => Number.isInteger(d * 2), 'Use whole or half days')
const AllocId = z.object({ id: z.string().uuid() })
leaveRouter.post('/allocation-requests', requirePermission('leave:write'), validate(z.object({ body: z.object({ leaveTypeId: z.string().uuid(), requestedDays: halfDays(366), reason: z.string().trim().min(3).max(500), supportingRefType: z.string().max(50).optional(), supportingRefId: z.string().max(100).optional() }).strict() })), leaveController.requestAllocation)
leaveRouter.post('/allocation-requests/:id/approve', requirePermission('leave:approve'), validate(z.object({ params: AllocId, body: z.object({ approvedDays: halfDays(366), note: z.string().trim().max(500).optional() }).strict() })), leaveController.approveAllocationRequest)
leaveRouter.post('/allocation-requests/:id/reject', requirePermission('leave:approve'), validate(z.object({ params: AllocId, body: z.object({ note: z.string().trim().min(2).max(500) }).strict() })), leaveController.rejectAllocationRequest)

// ─── HR ONLY ──────────────────────────────────────────────────
// One person's balances for every type, credit history, and manual adjustments with a reason
const EmpId = z.object({ employeeId: z.string().uuid() })
leaveRouter.get('/admin/balances/:employeeId', requirePermission('leave:configure'), validate(z.object({ params: EmpId })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await balancesService.forEmployee(req.user!, String(req.params.employeeId)) })
}))
leaveRouter.post('/admin/balances/:employeeId/adjust', requirePermission('leave:configure'), validate(z.object({ params: EmpId, body: z.object({
  leaveTypeId: z.string().uuid(),
  days: z.number().refine((d) => d !== 0 && Math.abs(d) <= 366 && Number.isInteger(d * 2), 'Days must be a non-zero whole or half number up to 366'),
  reason: z.string().trim().min(3).max(300),
  allowNegative: z.boolean().optional(),
}).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await balancesService.adjust(req.user!, String(req.params.employeeId), req.body) })
}))
leaveRouter.post('/allocations/manual', requirePermission('leave:configure'), leaveController.manualAllocation)
leaveRouter.post('/accrual/run', requirePermission('leave:configure'), leaveController.triggerAccrual)

// ─── CONTRACTS ────────────────────────────────────────────────
leaveRouter.post('/contracts', requirePermission('salary:write'), validate(CreateContractSchema), contractController.create)
leaveRouter.get('/contracts/employee/:employeeId', requirePermission('salary:read'), contractController.getByEmployee)
leaveRouter.get('/contracts/:id', requirePermission('salary:read'), contractController.getById)
leaveRouter.post('/contracts/:id/draft', requirePermission('salary:write'), validate(ContractTransitionSchema), contractController.draft)
leaveRouter.post('/contracts/:id/confirm', requirePermission('salary:write'), validate(ContractTransitionSchema), contractController.confirm)
leaveRouter.post('/contracts/:id/activate', requirePermission('salary:write'), validate(ContractTransitionSchema), contractController.activate)
leaveRouter.post('/contracts/:id/cancel', requirePermission('salary:write'), validate(ContractTransitionSchema), contractController.cancel)
leaveRouter.post('/contracts/cron/auto-activate', requirePermission('system:configure'), contractController.triggerAutoActivate)
leaveRouter.post('/contracts/cron/auto-expire', requirePermission('system:configure'), contractController.triggerAutoExpire)

// ─── LEAVE YEAR END (carry forward, encash, lapse; preview, run, roll back) ────
leaveRouter.get('/year-end', requirePermission('leave:configure'), asyncHandler(async (req, res) => res.json({ success: true, data: await yearEndService.preview(req.user!.tenantId) })))
leaveRouter.post('/year-end/run', requirePermission('leave:configure'), asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await yearEndService.run(req.user!.tenantId, req.user!) })))
leaveRouter.post('/year-end/:id/rollback', requirePermission('leave:configure'), validate(z.object({ params: z.object({ id: z.string().uuid() }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await yearEndService.rollback(req.user!, String(req.params.id)) })
}))

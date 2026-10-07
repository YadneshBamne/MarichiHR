import { Router } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission } from '../../middleware/rbac.middleware'
import { leaveController } from './leave.controller'
import { contractController } from '../employees/contracts.controller'

export const leaveRouter = Router()

leaveRouter.use(authenticate)

// ─── LEAVE TYPES ──────────────────────────────────────────────
leaveRouter.get('/types', requirePermission('leave:read'), leaveController.listTypes)

// ─── BALANCES ─────────────────────────────────────────────────
leaveRouter.get('/balances/me', requirePermission('leave:read'), leaveController.getMyBalances)
leaveRouter.get('/balances/:employeeId', requirePermission('leave:read'), leaveController.getEmployeeBalances)
leaveRouter.get('/allocations/:employeeId', requirePermission('leave:read'), leaveController.listAllocations)

// ─── REQUESTS ─────────────────────────────────────────────────
leaveRouter.post('/requests', requirePermission('leave:write'), leaveController.applyLeave)
leaveRouter.get('/requests/me', requirePermission('leave:read'), leaveController.listMyRequests)
leaveRouter.get('/requests/pending', requirePermission('leave:approve'), leaveController.getPendingApprovals)
leaveRouter.post('/requests/:id/approve', requirePermission('leave:approve'), leaveController.approve)
leaveRouter.post('/requests/:id/reject', requirePermission('leave:approve'), leaveController.reject)
leaveRouter.post('/requests/:id/cancel', requirePermission('leave:write'), leaveController.cancel)

// ─── TEAM CALENDAR ────────────────────────────────────────────
leaveRouter.get('/calendar/team', requirePermission('leave:read'), leaveController.getTeamCalendar)

// ─── ALLOCATION REQUESTS ──────────────────────────────────────
leaveRouter.post('/allocation-requests', requirePermission('leave:write'), leaveController.requestAllocation)
leaveRouter.post('/allocation-requests/:id/approve', requirePermission('leave:approve'), leaveController.approveAllocationRequest)
leaveRouter.post('/allocation-requests/:id/reject', requirePermission('leave:approve'), leaveController.rejectAllocationRequest)

// ─── HR ONLY ──────────────────────────────────────────────────
leaveRouter.post('/allocations/manual', requirePermission('leave:configure'), leaveController.manualAllocation)
leaveRouter.post('/accrual/run', requirePermission('leave:configure'), leaveController.triggerAccrual)

// ─── CONTRACTS ────────────────────────────────────────────────
leaveRouter.post('/contracts', requirePermission('salary:write'), contractController.create)
leaveRouter.get('/contracts/employee/:employeeId', requirePermission('salary:read'), contractController.getByEmployee)
leaveRouter.get('/contracts/:id', requirePermission('salary:read'), contractController.getById)
leaveRouter.post('/contracts/:id/draft', requirePermission('salary:write'), contractController.draft)
leaveRouter.post('/contracts/:id/confirm', requirePermission('salary:write'), contractController.confirm)
leaveRouter.post('/contracts/:id/activate', requirePermission('salary:write'), contractController.activate)
leaveRouter.post('/contracts/:id/cancel', requirePermission('salary:write'), contractController.cancel)
leaveRouter.post('/contracts/cron/auto-activate', requirePermission('system:configure'), contractController.triggerAutoActivate)
leaveRouter.post('/contracts/cron/auto-expire', requirePermission('system:configure'), contractController.triggerAutoExpire)

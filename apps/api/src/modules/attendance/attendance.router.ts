import { Router } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission, requireRoles } from '../../middleware/rbac.middleware'
import { z } from 'zod'
import { attendanceController } from './attendance.controller'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { policyService } from './policy.service'

import { attendanceExtras, ShiftBody, RosterBody } from './attendance-extras.service'
export const attendanceRouter = Router()

attendanceRouter.use(authenticate)

// ─── CLOCK IN/OUT ─────────────────────────────────────────────
attendanceRouter.post('/clock-in', requirePermission('attendance:write'), attendanceController.clockIn)
attendanceRouter.post('/clock-out', requirePermission('attendance:write'), attendanceController.clockOut)
attendanceRouter.get('/today', requirePermission('attendance:read'), attendanceController.getTodayStatus)

// ─── CALENDAR ─────────────────────────────────────────────────
attendanceRouter.get('/calendar/me', requirePermission('attendance:read'), attendanceController.getMyCalendar)
attendanceRouter.get('/calendar/:employeeId', requirePermission('attendance:read'), attendanceController.getEmployeeCalendar)

// ─── TEAM VIEW ────────────────────────────────────────────────
// Team views are for people with a team: managers and HR
attendanceRouter.get('/team/today', requirePermission('attendance:read'), requireRoles('manager', 'hr_admin', 'system_admin'), attendanceController.getTeamToday)

// ─── REGULARISATIONS ──────────────────────────────────────────
attendanceRouter.post('/regularisations', requirePermission('attendance:write'), attendanceController.raiseRegularisation)
attendanceRouter.get('/regularisations/me', requirePermission('attendance:read'), attendanceController.listMyRegularisations)
attendanceRouter.get('/regularisations/pending', requirePermission('attendance:approve'), attendanceController.listPendingRegularisations)
attendanceRouter.post('/regularisations/:id/approve', requirePermission('attendance:approve'), attendanceController.approveRegularisation)
attendanceRouter.post('/regularisations/:id/reject', requirePermission('attendance:approve'), attendanceController.rejectRegularisation)

// ─── OVERTIME ─────────────────────────────────────────────────
attendanceRouter.post('/overtime', requirePermission('attendance:write'), attendanceController.requestOvertime)
attendanceRouter.get('/overtime/me', requirePermission('attendance:read'), attendanceController.listMyOvertime)
attendanceRouter.get('/overtime/pending', requirePermission('attendance:approve'), attendanceController.listPendingOvertime)
attendanceRouter.post('/overtime/:id/approve', requirePermission('attendance:approve'), attendanceController.approveOvertime)
attendanceRouter.post('/overtime/:id/reject', requirePermission('attendance:approve'), attendanceController.rejectOvertime)

// ─── HR ONLY ──────────────────────────────────────────────────
attendanceRouter.post('/override', requirePermission('attendance:lock'), attendanceController.overrideAttendance)
attendanceRouter.post('/lock', requirePermission('attendance:lock'), attendanceController.lockAttendance)

// ─── ATTENDANCE POLICIES (office hours and day rules per employee group) ─────
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')
const hours = z.number().min(0).max(24)
const PolicyBody = z.object({
  name: z.string().trim().min(2).max(80), priority: z.number().int().min(0).max(1000), isDefault: z.boolean(), active: z.boolean(),
  orgUnitIds: z.array(z.string().uuid()).max(200), workLocationIds: z.array(z.string().uuid()).max(200), employeeCategories: z.array(z.string().max(40)).max(50), employmentTypes: z.array(z.string().max(40)).max(50),
  flexible: z.boolean(), startTime: hhmm, endTime: hhmm, graceInMinutes: z.number().int().min(0).max(240), graceOutMinutes: z.number().int().min(0).max(240), halfDayHours: hours, fullDayHours: hours,
  lateEarlyAllowedPerMonth: z.number().int().min(0).max(31), latePenalty: z.enum(['none', 'half_day_lop', 'full_day_lop']),
  regularisationDaysBack: z.number().int().min(0).max(366), regularisationPerMonth: z.number().int().min(0).max(31),
  overtimeEnabled: z.boolean(), overtimeAfterHours: hours, overtimeRate: z.number().min(0).max(4), overtimeMaxHoursPerMonth: z.number().min(0).max(744).nullable(),
  compOffEnabled: z.boolean(), compOffHalfDayHours: hours, compOffFullDayHours: hours, allowWeb: z.boolean(), requireGeofence: z.boolean(),
  lwpFlagAfterAbsences: z.number().int().min(1).max(31).nullable(),
}).partial().strict()
const policyAdmins = requireRoles('hr_admin', 'system_admin')

// ─── Shifts, rosters, QR, heatmap, adjustments ──────────────────
const id = z.object({ id: z.string().uuid() })
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
attendanceRouter.get('/shifts', asyncHandler(async (req, res) => res.json({ success: true, data: await attendanceExtras.shifts(req.user!.tenantId) })))
attendanceRouter.post('/shifts', policyAdmins, validate(z.object({ body: ShiftBody })), asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await attendanceExtras.saveShift(req.user!, null, req.body) })))
attendanceRouter.patch('/shifts/:id', policyAdmins, validate(z.object({ params: id, body: ShiftBody.partial() })), asyncHandler(async (req, res) => res.json({ success: true, data: await attendanceExtras.saveShift(req.user!, String(req.params.id), req.body as any) })))
attendanceRouter.post('/roster', policyAdmins, validate(z.object({ body: RosterBody })), asyncHandler(async (req, res) => res.json({ success: true, data: await attendanceExtras.assignRoster(req.user!, req.body) })))
attendanceRouter.get('/roster', validate(z.object({ query: z.object({ from: day, to: day, employeeId: z.string().uuid().optional() }) })), asyncHandler(async (req, res) => res.json({ success: true, data: await attendanceExtras.roster(req.user!, String(req.query.from), String(req.query.to), req.query.employeeId as string | undefined) })))
attendanceRouter.get('/locations/:id/qr', policyAdmins, validate(z.object({ params: id })), asyncHandler(async (req, res) => res.json({ success: true, data: await attendanceExtras.qrToken(req.user!, String(req.params.id)) })))
attendanceRouter.post('/locations/:id/qr/rotate', policyAdmins, validate(z.object({ params: id })), asyncHandler(async (req, res) => res.json({ success: true, data: await attendanceExtras.qrToken(req.user!, String(req.params.id), true) })))
attendanceRouter.get('/heatmap', policyAdmins, validate(z.object({ query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }) })), asyncHandler(async (req, res) => res.json({ success: true, data: await attendanceExtras.heatmap(req.user!.tenantId, String(req.query.month)) })))
attendanceRouter.get('/adjustments', requireRoles('hr_admin', 'payroll_admin'), validate(z.object({ query: z.object({ pending: z.enum(['true', 'false']).optional() }) })), asyncHandler(async (req, res) => res.json({ success: true, data: await attendanceExtras.adjustments(req.user!.tenantId, req.query.pending === 'true') })))
attendanceRouter.get('/policies', policyAdmins, asyncHandler(async (req, res) => res.json({ success: true, data: await policyService.list(req.user!.tenantId) })))
attendanceRouter.get('/policies/mine', asyncHandler(async (req, res) => res.json({ success: true, data: await policyService.mine(req.user!.employeeId) })))
attendanceRouter.post('/policies', policyAdmins, validate(z.object({ body: PolicyBody.required({ name: true }) })), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await policyService.save(req.user!, null, req.body) })
}))
attendanceRouter.patch('/policies/:id', policyAdmins, validate(z.object({ params: z.object({ id: z.string().uuid() }), body: PolicyBody })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await policyService.save(req.user!, String(req.params.id), req.body) })
}))

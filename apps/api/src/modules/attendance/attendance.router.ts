import { Router } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission } from '../../middleware/rbac.middleware'
import { attendanceController } from './attendance.controller'

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
attendanceRouter.get('/team/today', requirePermission('attendance:read'), attendanceController.getTeamToday)

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

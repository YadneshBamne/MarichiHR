import { Request, Response } from 'express'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { attendanceService } from './attendance.service'
import { businessToday } from '../../shared/utils/businessDate'

export const attendanceController = {
  clockIn: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId } = req.user!
    const record = await attendanceService.clockIn(employeeId!, tenantId, req.body)
    res.status(201).json({ success: true, data: record })
  }),

  clockOut: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId } = req.user!
    const record = await attendanceService.clockOut(employeeId!, tenantId, req.body)
    res.json({ success: true, data: record })
  }),

  getTodayStatus: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId } = req.user!
    const status = await attendanceService.getTodayStatus(employeeId!, tenantId)
    res.json({ success: true, data: status })
  }),

  getMyCalendar: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId } = req.user!
    const today = await businessToday(tenantId)
    const year = parseInt(req.query['year'] as string) || today.getUTCFullYear()
    const month = parseInt(req.query['month'] as string) || today.getUTCMonth() + 1
    const result = await attendanceService.getMonthlyCalendar(employeeId!, year, month)
    res.json({ success: true, data: result })
  }),

  getEmployeeCalendar: asyncHandler(async (req: Request, res: Response) => {
    const today = await businessToday(req.user!.tenantId)
    const year = parseInt(req.query['year'] as string) || today.getUTCFullYear()
    const month = parseInt(req.query['month'] as string) || today.getUTCMonth() + 1
    const result = await attendanceService.getEmployeeCalendar(req.params['employeeId'] as string, year, month, req.user!)
    res.json({ success: true, data: result })
  }),

  getTeamToday: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId, roleIds } = req.user!
    const isHR = roleIds.some((r) => ['hr_admin', 'payroll_admin', 'system_admin'].includes(r))
    const result = await attendanceService.getTeamAttendanceToday(employeeId!, tenantId, isHR)
    res.json({ success: true, data: result })
  }),

  raiseRegularisation: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId } = req.user!
    const result = await attendanceService.raiseRegularisation(employeeId!, tenantId, req.body)
    res.status(201).json({ success: true, data: result })
  }),

  listMyRegularisations: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId } = req.user!
    const result = await attendanceService.listMyRegularisations(employeeId!)
    res.json({ success: true, data: result })
  }),

  listPendingRegularisations: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId, roleIds } = req.user!
    const isHR = roleIds.some((r) => ['hr_admin', 'payroll_admin', 'system_admin'].includes(r))
    const result = await attendanceService.listPendingRegularisations(employeeId!, tenantId, isHR)
    res.json({ success: true, data: result })
  }),

  approveRegularisation: asyncHandler(async (req: Request, res: Response) => {
    const result = await attendanceService.approveRegularisation(req.params['id'] as string, req.user!)
    res.json({ success: true, data: result })
  }),

  rejectRegularisation: asyncHandler(async (req: Request, res: Response) => {
    const result = await attendanceService.rejectRegularisation(req.params['id'] as string, req.user!)
    res.json({ success: true, data: result })
  }),

  requestOvertime: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId } = req.user!
    const result = await attendanceService.requestOvertime(employeeId!, tenantId, req.body)
    res.status(201).json({ success: true, data: result })
  }),

  listMyOvertime: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId } = req.user!
    const result = await attendanceService.listMyOvertime(employeeId!)
    res.json({ success: true, data: result })
  }),

  listPendingOvertime: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId } = req.user!
    const result = await attendanceService.listPendingOvertime(employeeId!)
    res.json({ success: true, data: result })
  }),

  approveOvertime: asyncHandler(async (req: Request, res: Response) => {
    const approvedRate = req.body.approvedRate ?? 1.5
    const result = await attendanceService.approveOvertime(req.params['id'] as string, req.user!, approvedRate)
    res.json({ success: true, data: result })
  }),

  rejectOvertime: asyncHandler(async (req: Request, res: Response) => {
    const result = await attendanceService.rejectOvertime(req.params['id'] as string, req.user!)
    res.json({ success: true, data: result })
  }),

  overrideAttendance: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const result = await attendanceService.overrideAttendance(tenantId, req.body, userId)
    res.json({ success: true, data: result })
  }),

  lockAttendance: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const { startDate, endDate } = req.body
    const result = await attendanceService.lockAttendance(tenantId, startDate, endDate, userId)
    res.json({ success: true, data: result })
  }),
}

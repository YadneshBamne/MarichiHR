import { Request, Response } from 'express'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { leaveService } from './leave.service'

export const leaveController = {
  listTypes: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const types = await leaveService.listTypes(tenantId)
    res.json({ success: true, data: types })
  }),

  getMyBalances: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId } = req.user!
    const balances = await leaveService.getBalances(employeeId!)
    res.json({ success: true, data: balances })
  }),

  getEmployeeBalances: asyncHandler(async (req: Request, res: Response) => {
    const balances = await leaveService.getEmployeeBalances(req.params['employeeId'] as string, req.user!)
    res.json({ success: true, data: balances })
  }),

  applyLeave: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId } = req.user!
    const request = await leaveService.applyLeave(employeeId!, tenantId, req.body)
    res.status(201).json({ success: true, data: request })
  }),

  listMyRequests: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId } = req.user!
    const result = await leaveService.listMyRequests(employeeId!, req.query)
    res.json({ success: true, data: result })
  }),

  getPendingApprovals: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId, roleIds } = req.user!
    const isHR = roleIds.includes('hr_admin')
    const result = await leaveService.listPendingApprovals(employeeId!, tenantId, isHR)
    res.json({ success: true, data: result })
  }),

  approve: asyncHandler(async (req: Request, res: Response) => {
    const result = await leaveService.approveLeave(req.params['id'] as string, req.user!, req.body)
    res.json({ success: true, data: result })
  }),

  reject: asyncHandler(async (req: Request, res: Response) => {
    const result = await leaveService.rejectLeave(req.params['id'] as string, req.user!, req.body)
    res.json({ success: true, data: result })
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId } = req.user!
    const result = await leaveService.cancelLeave(req.params['id'] as string, employeeId!, tenantId)
    res.json({ success: true, data: result })
  }),

  getTeamCalendar: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId } = req.user!
    const { startDate, endDate } = req.query as { startDate: string; endDate: string }
    const result = await leaveService.getTeamCalendar(employeeId!, startDate, endDate)
    res.json({ success: true, data: result })
  }),

  requestAllocation: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId } = req.user!
    const result = await leaveService.requestAllocation(employeeId!, tenantId, req.body)
    res.status(201).json({ success: true, data: result })
  }),

  approveAllocationRequest: asyncHandler(async (req: Request, res: Response) => {
    const { approvedDays, note } = req.body
    const result = await leaveService.approveAllocationRequest(
      req.params['id'] as string, req.user!, approvedDays, note
    )
    res.json({ success: true, data: result })
  }),

  rejectAllocationRequest: asyncHandler(async (req: Request, res: Response) => {
    const result = await leaveService.rejectAllocationRequest(
      req.params['id'] as string, req.user!, req.body.note
    )
    res.json({ success: true, data: result })
  }),

  manualAllocation: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const result = await leaveService.manualAllocation(tenantId, req.body, userId)
    res.status(201).json({ success: true, data: result })
  }),

  listAllocations: asyncHandler(async (req: Request, res: Response) => {
    const result = await leaveService.listAllocations(req.params['employeeId'] as string, req.user!)
    res.json({ success: true, data: result })
  }),

  triggerAccrual: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const count = await leaveService.runMonthlyAccrual(tenantId)
    res.json({ success: true, message: `Accrual complete: ${count} entries credited` })
  }),
}

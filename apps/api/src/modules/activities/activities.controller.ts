import { Request, Response } from 'express'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { activitiesService } from './activities.service'

export const activitiesController = {
  dashboard: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId, roleIds } = req.user!
    const result = await activitiesService.getDashboardSummary(employeeId!, tenantId, roleIds)
    res.json({ success: true, data: result })
  }),

  types: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await activitiesService.types(req.user!.tenantId) })
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const result = await activitiesService.createActivity(req.user!, req.body)
    res.status(201).json({ success: true, data: result })
  }),

  listCreated: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await activitiesService.listCreated(req.user!, req.query['status'] as string) })
  }),

  listForEntity: asyncHandler(async (req: Request, res: Response) => {
    const { entityType, entityId } = req.params
    const result = await activitiesService.listForEntity(entityType as string, entityId as string, req.user!)
    res.json({ success: true, data: result })
  }),

  listMine: asyncHandler(async (req: Request, res: Response) => {
    const result = await activitiesService.listMyActivities(req.user!, req.query['status'] as string)
    res.json({ success: true, data: result })
  }),

  complete: asyncHandler(async (req: Request, res: Response) => {
    const { employeeId, tenantId } = req.user!
    const result = await activitiesService.completeActivity(req.params['id'] as string, employeeId!, tenantId, req.body)
    res.json({ success: true, data: result })
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const result = await activitiesService.cancelActivity(req.params['id'] as string, req.user!)
    res.json({ success: true, data: result })
  }),

  postMessage: asyncHandler(async (req: Request, res: Response) => {
    const { roleIds } = req.user!
    const isHR = roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
    const result = await activitiesService.postMessage(req.user!, req.body, isHR)
    res.status(201).json({ success: true, data: result })
  }),

  listMessages: asyncHandler(async (req: Request, res: Response) => {
    const { entityType, entityId } = req.params
    const { roleIds } = req.user!
    const isHR = roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
    const result = await activitiesService.listMessages(entityType as string, entityId as string, isHR, req.user!)
    res.json({ success: true, data: result })
  }),
}

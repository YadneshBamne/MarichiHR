import { Request, Response } from 'express'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { contractService } from './contracts.service'

export const contractController = {
  create: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const contract = await contractService.create(req.body, tenantId, userId)
    res.status(201).json({ success: true, data: contract })
  }),

  getByEmployee: asyncHandler(async (req: Request, res: Response) => {
    const contracts = await contractService.getByEmployee(req.params['employeeId'] as string, req.user!)
    res.json({ success: true, data: contracts })
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const contract = await contractService.getById(req.params['id'] as string, req.user!)
    res.json({ success: true, data: contract })
  }),

  draft: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const contract = await contractService.transition(req.params['id'] as string, 'draft', tenantId, userId, req.body.reason)
    res.json({ success: true, data: contract })
  }),

  confirm: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const contract = await contractService.transition(req.params['id'] as string, 'confirmed', tenantId, userId, req.body.reason)
    res.json({ success: true, data: contract })
  }),

  activate: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const contract = await contractService.transition(req.params['id'] as string, 'running', tenantId, userId, req.body.reason)
    res.json({ success: true, data: contract })
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const contract = await contractService.transition(req.params['id'] as string, 'cancelled', tenantId, userId, req.body.reason)
    res.json({ success: true, data: contract })
  }),

  triggerAutoActivate: asyncHandler(async (req: Request, res: Response) => {
    const count = await contractService.runAutoActivateCron()
    res.json({ success: true, message: `Auto-activated ${count} contracts` })
  }),

  triggerAutoExpire: asyncHandler(async (req: Request, res: Response) => {
    const count = await contractService.runAutoExpireCron()
    res.json({ success: true, message: `Auto-expired ${count} contracts` })
  }),
}

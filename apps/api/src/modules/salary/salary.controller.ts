import { Request, Response } from 'express'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { salaryService } from './salary.service'

export const salaryController = {
  listStructureTypes: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await salaryService.listStructureTypes(tenantId)
    res.json({ success: true, data: result })
  }),

  createStructureType: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await salaryService.createStructureType(tenantId, req.body)
    res.status(201).json({ success: true, data: result })
  }),

  listStructures: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await salaryService.listStructures(tenantId, req.query.countryCode as string)
    res.json({ success: true, data: result })
  }),

  getStructureById: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await salaryService.getStructureById(req.params.id as string, tenantId)
    res.json({ success: true, data: result })
  }),

  createStructure: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await salaryService.createStructure(tenantId, req.body)
    res.status(201).json({ success: true, data: result })
  }),

  listRuleCategories: asyncHandler(async (req: Request, res: Response) => {
    const result = await salaryService.listRuleCategories()
    res.json({ success: true, data: result })
  }),

  createRule: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await salaryService.createRule(tenantId, req.body)
    res.status(201).json({ success: true, data: result })
  }),

  updateRule: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await salaryService.updateRule(req.params.id as string, tenantId, req.body)
    res.json({ success: true, data: result })
  }),

  deleteRule: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    await salaryService.deleteRule(req.params.id as string, tenantId)
    res.json({ success: true, message: 'Rule deactivated' })
  }),

  listGradeBands: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await salaryService.listGradeBands(tenantId)
    res.json({ success: true, data: result })
  }),

  createGradeBand: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await salaryService.createGradeBand(tenantId, req.body)
    res.status(201).json({ success: true, data: result })
  }),

  updateGradeBand: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await salaryService.updateGradeBand(req.params.id as string, tenantId, req.body)
    res.json({ success: true, data: result })
  }),

  listInputTypes: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await salaryService.listInputTypes(tenantId)
    res.json({ success: true, data: result })
  }),

  createInputType: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await salaryService.createInputType(tenantId, req.body)
    res.status(201).json({ success: true, data: result })
  }),

  linkContractToStructure: asyncHandler(async (req: Request, res: Response) => {
    const { salaryStructureId, gradeBandId } = req.body
    const { tenantId } = req.user!
    const result = await salaryService.linkContractToStructure(req.params.contractId as string, tenantId, salaryStructureId, gradeBandId)
    res.json({ success: true, data: result })
  }),
}

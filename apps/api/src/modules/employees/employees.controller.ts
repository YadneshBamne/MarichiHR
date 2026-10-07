import { Request, Response } from 'express'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { employeeService, orgUnitService, jobPositionService, workLocationService } from './employees.service'

// ─── ORG UNITS ────────────────────────────────────────────────

export const orgUnitController = {
  getTree: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const tree = await orgUnitService.getTree(tenantId)
    res.json({ success: true, data: tree })
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const unit = await orgUnitService.getById(req.params['id'] as string, tenantId)
    res.json({ success: true, data: unit })
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const unit = await orgUnitService.create(tenantId, req.body)
    res.status(201).json({ success: true, data: unit })
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const unit = await orgUnitService.update(req.params['id'] as string, tenantId, req.body, userId)
    res.json({ success: true, data: unit })
  }),

  archive: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    await orgUnitService.archive(req.params['id'] as string, tenantId, userId, req.body.reason)
    res.json({ success: true, message: 'Org unit archived' })
  }),
}

// ─── JOB POSITIONS ────────────────────────────────────────────

export const jobPositionController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const positions = await jobPositionService.list(tenantId, req.query.orgUnitId as string)
    res.json({ success: true, data: positions })
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const position = await jobPositionService.create(tenantId, req.body)
    res.status(201).json({ success: true, data: position })
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const position = await jobPositionService.update(req.params['id'] as string, tenantId, req.body)
    res.json({ success: true, data: position })
  }),
}

// ─── WORK LOCATIONS ───────────────────────────────────────────

export const workLocationController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const locations = await workLocationService.list(tenantId)
    res.json({ success: true, data: locations })
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const location = await workLocationService.create(tenantId, req.body)
    res.status(201).json({ success: true, data: location })
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const location = await workLocationService.update(req.params['id'] as string, tenantId, req.body)
    res.json({ success: true, data: location })
  }),
}

// ─── EMPLOYEES ────────────────────────────────────────────────

export const employeeController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const result = await employeeService.list(tenantId, req.query, req.user!)
    res.json({ success: true, ...result })
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const employee = await employeeService.getById(req.params['id'] as string, tenantId, req.user!)
    res.json({ success: true, data: employee })
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const result = await employeeService.create(tenantId, req.body, userId)
    res.status(201).json({ success: true, data: result })
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const employee = await employeeService.update(req.params['id'] as string, tenantId, req.body, userId)
    res.json({ success: true, data: employee })
  }),

  updateBank: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const employee = await employeeService.updateBank(req.params['id'] as string, tenantId, userId, req.body)
    res.json({ success: true, data: employee })
  }),

  verifyBank: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const employee = await employeeService.verifyBank(req.params['id'] as string, tenantId, userId)
    res.json({ success: true, data: employee })
  }),

  archive: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    await employeeService.archive(req.params['id'] as string, tenantId, userId, req.body.reason)
    res.json({ success: true, message: 'Employee archived successfully' })
  }),

  addSkill: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const skill = await employeeService.addSkill(req.params['id'] as string, tenantId, req.body)
    res.status(201).json({ success: true, data: skill })
  }),

  removeSkill: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    await employeeService.removeSkill(req.params['skillId'] as string, req.params['id'] as string, tenantId)
    res.json({ success: true, message: 'Skill removed' })
  }),

  getSkillTypes: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const types = await employeeService.getSkillTypes(tenantId)
    res.json({ success: true, data: types })
  }),

  addResumeLine: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    const line = await employeeService.addResumeLine(req.params['id'] as string, tenantId, req.body)
    res.status(201).json({ success: true, data: line })
  }),

  updateResumeLine: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    await employeeService.updateResumeLine(req.params['lineId'] as string, req.params['id'] as string, tenantId, req.body)
    res.json({ success: true, message: 'Resume line updated' })
  }),

  removeResumeLine: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId } = req.user!
    await employeeService.removeResumeLine(req.params['lineId'] as string, req.params['id'] as string, tenantId)
    res.json({ success: true, message: 'Resume line removed' })
  }),
}

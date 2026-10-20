import { Router } from 'express'
import { starterFor, createStarterStructure } from './starter.service'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { prisma } from '../../infrastructure/database/prisma'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission, requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { salaryController } from './salary.controller'
import {
  UpdateSalaryRuleSchema, UpdateGradeBandSchema, LinkStructureSchema, CreateStructureTypeSchema, UpdateStructureTypeSchema,
  CreateStructureSchema, UpdateStructureSchema, CreateSalaryRuleSchema, CheckRuleSchema, CreateGradeBandSchema,
} from './salary.schema'

export const salaryRouter = Router()

salaryRouter.use(authenticate)

// Pay structures, formulas and grade bands are for payroll staff only
const salaryStaff = requireRoles('hr_admin', 'payroll_admin', 'compliance_officer')

salaryRouter.get('/rule-categories', salaryStaff, salaryController.listRuleCategories)

salaryRouter.get('/structure-types', requirePermission('salary:read'), salaryStaff, salaryController.listStructureTypes)
salaryRouter.post('/structure-types', requirePermission('salary:write'), validate(CreateStructureTypeSchema), salaryController.createStructureType)
salaryRouter.patch('/structure-types/:id', requirePermission('salary:write'), validate(UpdateStructureTypeSchema), salaryController.updateStructureType)

salaryRouter.get('/structures', requirePermission('salary:read'), salaryStaff, salaryController.listStructures)
// Ready-made structure for the company's country (preview, then create in one click)
salaryRouter.get('/structures/starter', requirePermission('salary:read'), salaryStaff, asyncHandler(async (req, res) => {
  const t = await prisma.tenant.findUnique({ where: { id: req.user!.tenantId }, select: { primaryCountry: true } })
  res.json({ success: true, data: starterFor(t?.primaryCountry) })
}))
salaryRouter.post('/structures/starter', requirePermission('salary:write'), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await createStarterStructure(req.user!.tenantId, req.user!.userId) })
}))
salaryRouter.get('/structures/:id', requirePermission('salary:read'), salaryStaff, salaryController.getStructureById)
salaryRouter.post('/structures', requirePermission('salary:write'), validate(CreateStructureSchema), salaryController.createStructure)
salaryRouter.patch('/structures/:id', requirePermission('salary:write'), validate(UpdateStructureSchema), salaryController.updateStructure)

salaryRouter.post('/rules', requirePermission('salary:write'), validate(CreateSalaryRuleSchema), salaryController.createRule)
salaryRouter.post('/rules/check', requirePermission('salary:write'), validate(CheckRuleSchema), salaryController.checkRule)
salaryRouter.patch('/rules/:id', requirePermission('salary:write'), validate(UpdateSalaryRuleSchema), salaryController.updateRule)
salaryRouter.delete('/rules/:id', requirePermission('salary:write'), salaryController.deleteRule)

salaryRouter.get('/grade-bands', requirePermission('salary:read'), salaryStaff, salaryController.listGradeBands)
salaryRouter.post('/grade-bands', requirePermission('salary:write'), validate(CreateGradeBandSchema), salaryController.createGradeBand)
salaryRouter.patch('/grade-bands/:id', requirePermission('salary:write'), validate(UpdateGradeBandSchema), salaryController.updateGradeBand)

salaryRouter.get('/input-types', requirePermission('salary:read'), salaryStaff, salaryController.listInputTypes)
salaryRouter.post('/input-types', requirePermission('salary:write'), salaryController.createInputType)

salaryRouter.get('/contracts', requirePermission('salary:read'), salaryStaff, salaryController.listContracts)
salaryRouter.post('/contracts/:contractId/link-structure', requirePermission('salary:write'), validate(LinkStructureSchema), salaryController.linkContractToStructure)

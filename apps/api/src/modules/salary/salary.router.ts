import { Router } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission, requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { salaryController } from './salary.controller'
import { UpdateSalaryRuleSchema, UpdateGradeBandSchema, LinkStructureSchema } from './salary.schema'

export const salaryRouter = Router()

salaryRouter.use(authenticate)

// Pay structures, formulas and grade bands are for payroll staff only
const salaryStaff = requireRoles('hr_admin', 'payroll_admin', 'compliance_officer')

salaryRouter.get('/rule-categories', salaryStaff, salaryController.listRuleCategories)

salaryRouter.get('/structure-types', requirePermission('salary:read'), salaryStaff, salaryController.listStructureTypes)
salaryRouter.post('/structure-types', requirePermission('salary:write'), salaryController.createStructureType)

salaryRouter.get('/structures', requirePermission('salary:read'), salaryStaff, salaryController.listStructures)
salaryRouter.get('/structures/:id', requirePermission('salary:read'), salaryStaff, salaryController.getStructureById)
salaryRouter.post('/structures', requirePermission('salary:write'), salaryController.createStructure)

salaryRouter.post('/rules', requirePermission('salary:write'), salaryController.createRule)
salaryRouter.patch('/rules/:id', requirePermission('salary:write'), validate(UpdateSalaryRuleSchema), salaryController.updateRule)
salaryRouter.delete('/rules/:id', requirePermission('salary:write'), salaryController.deleteRule)

salaryRouter.get('/grade-bands', requirePermission('salary:read'), salaryStaff, salaryController.listGradeBands)
salaryRouter.post('/grade-bands', requirePermission('salary:write'), salaryController.createGradeBand)
salaryRouter.patch('/grade-bands/:id', requirePermission('salary:write'), validate(UpdateGradeBandSchema), salaryController.updateGradeBand)

salaryRouter.get('/input-types', requirePermission('salary:read'), salaryStaff, salaryController.listInputTypes)
salaryRouter.post('/input-types', requirePermission('salary:write'), salaryController.createInputType)

salaryRouter.post('/contracts/:contractId/link-structure', requirePermission('salary:write'), validate(LinkStructureSchema), salaryController.linkContractToStructure)

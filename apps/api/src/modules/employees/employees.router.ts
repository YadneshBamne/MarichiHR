import { Router } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import {
  employeeController,
  orgUnitController,
  jobPositionController,
  workLocationController,
} from './employees.controller'
import { requireRoles } from '../../middleware/rbac.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { accessService } from './employees.service'
import {
  AccessSchema,
  CreateEmployeeSchema,
  UpdateEmployeeSchema,
  CreateOrgUnitSchema,
  CreateJobPositionSchema,
  CreateWorkLocationSchema,
  AddSkillSchema,
  AddResumeLineSchema,
  ArchiveSchema,
  ListQuerySchema,
  BankDetailsSchema,
  UpdateOrgUnitSchema,
  UpdateJobPositionSchema,
  UpdateWorkLocationSchema,
  UpdateResumeLineSchema,
} from './employees.schema'

export const employeeRouter = Router()

employeeRouter.use(authenticate)

// ─── ORG UNITS ────────────────────────────────────────────────
employeeRouter.get('/org-units/tree', requirePermission('employees:read'), orgUnitController.getTree)
employeeRouter.get('/org-units/:id', requirePermission('employees:read'), orgUnitController.getById)
employeeRouter.post('/org-units', requirePermission('employees:write'), validate(CreateOrgUnitSchema), orgUnitController.create)
employeeRouter.patch('/org-units/:id', requirePermission('employees:write'), validate(UpdateOrgUnitSchema), orgUnitController.update)
employeeRouter.post('/org-units/:id/archive', requirePermission('employees:write'), orgUnitController.archive)

// ─── JOB POSITIONS ────────────────────────────────────────────
employeeRouter.get('/job-positions', requirePermission('employees:read'), jobPositionController.list)
employeeRouter.post('/job-positions', requirePermission('employees:write'), validate(CreateJobPositionSchema), jobPositionController.create)
employeeRouter.patch('/job-positions/:id', requirePermission('employees:write'), validate(UpdateJobPositionSchema), jobPositionController.update)

// ─── WORK LOCATIONS ───────────────────────────────────────────
employeeRouter.get('/work-locations', requirePermission('employees:read'), workLocationController.list)
employeeRouter.post('/work-locations', requirePermission('employees:write'), validate(CreateWorkLocationSchema), workLocationController.create)
employeeRouter.patch('/work-locations/:id', requirePermission('employees:write'), validate(UpdateWorkLocationSchema), workLocationController.update)

// ─── SKILL TYPES ──────────────────────────────────────────────
employeeRouter.get('/skill-types', requirePermission('employees:read'), employeeController.getSkillTypes)

// ─── EMPLOYEES ────────────────────────────────────────────────
employeeRouter.get('/', requirePermission('employees:read'), validate(ListQuerySchema), employeeController.list)
employeeRouter.post('/', requirePermission('employees:write'), validate(CreateEmployeeSchema), employeeController.create)
employeeRouter.get('/:id', requirePermission('employees:read'), employeeController.getById)
employeeRouter.patch('/:id', requirePermission('employees:write'), validate(UpdateEmployeeSchema), employeeController.update)
employeeRouter.patch('/:id/bank', requirePermission('employees:write'), validate(BankDetailsSchema), employeeController.updateBank)
employeeRouter.post('/:id/bank/verify', requirePermission('payroll:disburse'), employeeController.verifyBank)
// Login access: HR and system admins decide who can sign in and with which roles
const accessAdmins = requireRoles('hr_admin', 'system_admin')
employeeRouter.get('/:id/access', accessAdmins, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await accessService.get(String(req.params.id), req.user!.tenantId) })
}))
employeeRouter.put('/:id/access', accessAdmins, validate(AccessSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await accessService.set(String(req.params.id), req.user!, req.body) })
}))
employeeRouter.post('/:id/archive', requirePermission('employees:write'), validate(ArchiveSchema), employeeController.archive)

// ─── SKILLS ───────────────────────────────────────────────────
employeeRouter.post('/:id/skills', requirePermission('employees:write'), validate(AddSkillSchema), employeeController.addSkill)
employeeRouter.delete('/:id/skills/:skillId', requirePermission('employees:write'), employeeController.removeSkill)

// ─── RESUME ───────────────────────────────────────────────────
employeeRouter.post('/:id/resume', requirePermission('employees:write'), validate(AddResumeLineSchema), employeeController.addResumeLine)
employeeRouter.patch('/:id/resume/:lineId', requirePermission('employees:write'), validate(UpdateResumeLineSchema), employeeController.updateResumeLine)
employeeRouter.delete('/:id/resume/:lineId', requirePermission('employees:write'), employeeController.removeResumeLine)

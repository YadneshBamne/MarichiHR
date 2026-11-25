import { z } from 'zod'
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
import { accessService, orgChartService, archiveJobPosition, archiveWorkLocation, mastersOverview, employeeService } from './employees.service'
import { assertInHrScope } from '../../shared/utils/access'
import { profile360 } from './profile360.service'
import { recordRouter } from './record.router'
import { documentsRouter } from './documents.router'
import { importEmployees, issueCredentials, IMPORT_COLUMNS } from './import.service'
import { importData, DATA_IMPORTS, type DataImportType } from './data-import.service'
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
  ReinstateSchema,
  BankDetailsSchema,
  UpdateOrgUnitSchema,
  UpdateJobPositionSchema,
  UpdateWorkLocationSchema,
  UpdateResumeLineSchema,
} from './employees.schema'

export const employeeRouter = Router()

employeeRouter.use(authenticate)
// Full record, form builder, custom fields, position history, rehire check
employeeRouter.use(recordRouter)
employeeRouter.use(documentsRouter)

// ─── ORG UNITS ────────────────────────────────────────────────
// Masters hub: departments with headcount plus the size of every other master list (HR and system admins)
employeeRouter.get('/masters', requireRoles('hr_admin', 'system_admin'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await mastersOverview(req.user!.tenantId) })
}))
employeeRouter.get('/org-units/tree', requirePermission('employees:read'), orgUnitController.getTree)
employeeRouter.get('/org-units/:id', requirePermission('employees:read'), orgUnitController.getById)
employeeRouter.post('/org-units', requirePermission('employees:write'), validate(CreateOrgUnitSchema), orgUnitController.create)
employeeRouter.patch('/org-units/:id', requirePermission('employees:write'), validate(UpdateOrgUnitSchema), orgUnitController.update)
employeeRouter.post('/org-units/:id/archive', requirePermission('employees:write'), orgUnitController.archive)

// ─── JOB POSITIONS ────────────────────────────────────────────
employeeRouter.get('/job-positions', requirePermission('employees:read'), jobPositionController.list)
employeeRouter.post('/job-positions', requirePermission('employees:write'), validate(CreateJobPositionSchema), jobPositionController.create)
employeeRouter.patch('/job-positions/:id', requirePermission('employees:write'), validate(UpdateJobPositionSchema), jobPositionController.update)
employeeRouter.post('/job-positions/:id/archive', requirePermission('employees:write'), validate(z.object({ params: z.object({ id: z.string().uuid() }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await archiveJobPosition(String(req.params.id), req.user!.tenantId, req.user!.userId) })
}))

// ─── WORK LOCATIONS ───────────────────────────────────────────
employeeRouter.get('/work-locations', requirePermission('employees:read'), workLocationController.list)
employeeRouter.post('/work-locations', requirePermission('employees:write'), validate(CreateWorkLocationSchema), workLocationController.create)
employeeRouter.patch('/work-locations/:id', requirePermission('employees:write'), validate(UpdateWorkLocationSchema), workLocationController.update)
employeeRouter.post('/work-locations/:id/archive', requirePermission('employees:write'), validate(z.object({ params: z.object({ id: z.string().uuid() }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await archiveWorkLocation(String(req.params.id), req.user!.tenantId, req.user!.userId) })
}))

// ─── SKILL TYPES ──────────────────────────────────────────────
employeeRouter.get('/skill-types', employeeController.getSkillTypes) // the catalogue is not sensitive: people pick from it for their own profile

// A person edits their own skills and resume; everyone else needs employees:write (HR; Business Partners only inside their departments, checked in the controller)
const selfOrWrite = (req: any, res: any, next: any) => (req.user?.employeeId && req.user.employeeId === req.params.id ? next() : requirePermission('employees:write')(req, res, next))

// ─── EMPLOYEES ────────────────────────────────────────────────
// Everyone in the company may see the org chart (public fields only); declared before /:id
employeeRouter.get('/org-chart', requirePermission('employees:read'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await orgChartService.get(req.user!) })
}))
// Bulk import (all-or-nothing; dryRun checks the file) and credentials sheets: HR and system admins
const ImportSchema = z.object({ body: z.object({
  rows: z.array(z.partialRecord(z.enum(IMPORT_COLUMNS), z.string().max(200))).min(1).max(1000),
  dryRun: z.boolean(), createMissing: z.boolean().default(false), grantLogin: z.boolean().default(false),
}).strict() })
employeeRouter.post('/import', requireRoles('hr_admin', 'system_admin'), validate(ImportSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await importEmployees(req.user!, req.body) })
}))
// Leave balances, bank details and contracts for people already here; each type needs the permission its own screen needs
const DataImportSchema = z.object({ params: z.object({ type: z.enum(Object.keys(DATA_IMPORTS) as [DataImportType, ...DataImportType[]]) }), body: z.object({ rows: z.array(z.record(z.string().max(40), z.string().max(200))).min(1).max(2000), dryRun: z.boolean() }).strict() })
const DATA_IMPORT_PERMISSION: Record<DataImportType, string> = { leave_balances: 'leave:configure', bank_details: 'employees:write', contracts: 'salary:write' }
employeeRouter.post('/import/:type', validate(DataImportSchema), (req, res, next) => requirePermission(DATA_IMPORT_PERMISSION[req.params.type as DataImportType] as any)(req, res, next), asyncHandler(async (req, res) => {
  const type = req.params.type as DataImportType
  const allowed = new Set<string>(DATA_IMPORTS[type])
  const rows = req.body.rows.map((r: Record<string, string>) => Object.fromEntries(Object.entries(r).filter(([k]) => allowed.has(k))))
  res.json({ success: true, data: await importData(req.user!, type, { rows, dryRun: req.body.dryRun }) })
}))
employeeRouter.post('/access/bulk', requireRoles('hr_admin', 'system_admin'), validate(z.object({ body: z.object({ employeeIds: z.array(z.string().uuid()).min(1).max(500) }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await issueCredentials(req.user!, req.body.employeeIds) })
}))
// CSV of the directory as the caller sees it (same filters and access scope as the list). Never pay, bank or ID numbers; phone numbers only for HR and payroll.
const csvCell = (v: unknown, raw = false) => {
  const t = v == null ? '' : String(v)
  const safe = !raw && /^[=+@-]/.test(t) ? `'${t}` : t // a leading = + - @ would run as a spreadsheet formula
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
employeeRouter.get('/export', requirePermission('employees:read'), validate(ListQuerySchema), asyncHandler(async (req, res) => {
  const u = req.user!
  const seesPhones = u.roleIds.some((r) => ['hr_admin', 'system_admin', 'payroll_admin'].includes(r))
  const rows: any[] = []
  for (let page = 1; page <= 50; page++) {
    const r: any = await employeeService.list(u.tenantId, { ...req.query, page: String(page), limit: '100' }, u)
    rows.push(...r.data)
    if (!r.meta?.hasNext) break
  }
  const head = ['Employee ID', 'First name', 'Last name', 'Work email', 'Department', 'Job title', 'Manager', 'Location', 'Employment type', 'Status', 'Joining date', ...(seesPhones ? ['Work mobile'] : [])]
  const day = (d: unknown) => (d ? new Date(d as any).toISOString().slice(0, 10) : '')
  const lines = [head.join(','), ...rows.map((e) => [e.employeeCode, e.firstName, e.lastName, e.workEmail, e.orgUnit?.name, e.jobPosition?.title, e.manager?.user?.fullName, e.workLocation?.name, e.employmentType, e.active === false ? 'archived' : e.employmentStatus, day(e.hireDate)].map((c) => csvCell(c)).concat(seesPhones ? [csvCell(e.mobileWork, true)] : []).join(','))]
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="people-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send(String.fromCharCode(0xFEFF) + lines.join(String.fromCharCode(13, 10)))
}))
employeeRouter.get('/', requirePermission('employees:read'), validate(ListQuerySchema), employeeController.list)
employeeRouter.post('/', requirePermission('employees:write'), validate(CreateEmployeeSchema), employeeController.create)
employeeRouter.get('/:id', requirePermission('employees:read'), employeeController.getById)
employeeRouter.get('/:id/360', requirePermission('employees:read'), validate(z.object({ params: z.object({ id: z.string().uuid() }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await profile360(req.user!, String(req.params.id)) })
}))
employeeRouter.patch('/:id', requirePermission('employees:write'), validate(UpdateEmployeeSchema), employeeController.update)
employeeRouter.patch('/:id/bank', requirePermission('employees:write'), validate(BankDetailsSchema), employeeController.updateBank)
employeeRouter.post('/:id/bank/verify', requirePermission('payroll:disburse'), employeeController.verifyBank)
// Login access: HR and system admins decide who can sign in and with which roles
const accessAdmins = requireRoles('hr_admin', 'system_admin')
employeeRouter.get('/:id/access', accessAdmins, asyncHandler(async (req, res) => {
  await assertInHrScope(req.user!, String(req.params.id))
  res.json({ success: true, data: await accessService.get(String(req.params.id), req.user!.tenantId) })
}))
employeeRouter.put('/:id/access', accessAdmins, validate(AccessSchema), asyncHandler(async (req, res) => {
  await assertInHrScope(req.user!, String(req.params.id))
  res.json({ success: true, data: await accessService.set(String(req.params.id), req.user!, req.body) })
}))
employeeRouter.post('/:id/archive', requirePermission('employees:write'), validate(ArchiveSchema), employeeController.archive)
employeeRouter.post('/:id/reinstate', requirePermission('employees:write'), validate(ReinstateSchema), employeeController.reinstate)

// ─── SKILLS ───────────────────────────────────────────────────
employeeRouter.post('/:id/skills', selfOrWrite, validate(AddSkillSchema), employeeController.addSkill)
employeeRouter.delete('/:id/skills/:skillId', selfOrWrite, employeeController.removeSkill)

// ─── RESUME ───────────────────────────────────────────────────
employeeRouter.post('/:id/resume', selfOrWrite, validate(AddResumeLineSchema), employeeController.addResumeLine)
employeeRouter.patch('/:id/resume/:lineId', selfOrWrite, validate(UpdateResumeLineSchema), employeeController.updateResumeLine)
employeeRouter.delete('/:id/resume/:lineId', selfOrWrite, employeeController.removeResumeLine)

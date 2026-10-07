import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { AppError } from '../../shared/utils/AppError'
import { payrollController } from './payroll.controller'
import { CreateCycleSchema, AddInputSchema } from './payroll.schema'

export const payrollRouter = Router()

payrollRouter.use(authenticate)

// 'payroll:read' is held by every employee, so cycle-level endpoints also need a staff check
const STAFF = ['hr_admin', 'payroll_admin', 'compliance_officer']
function payrollStaffOnly(req: Request, _res: Response, next: NextFunction) {
  if (!req.user!.roleIds.some((r) => STAFF.includes(r))) {
    return next(new AppError('Payroll staff only', 403))
  }
  next()
}

// ─── EMPLOYEE SELF-SERVICE (released payslips only) ───────────
payrollRouter.get('/payslips/me', requirePermission('payroll:read'), payrollController.myPayslips)
payrollRouter.get('/payslips/:id/pdf', requirePermission('payroll:read'), payrollController.pdf)
payrollRouter.get('/payslips/:id',requirePermission('payroll:read'), payrollController.getPayslip)

// ─── CYCLES (staff) ───────────────────────────────────────────
payrollRouter.post('/cycles', requirePermission('payroll:run'), validate(CreateCycleSchema), payrollController.createCycle)
payrollRouter.get('/cycles', requirePermission('payroll:read'), payrollStaffOnly, payrollController.listCycles)
payrollRouter.get('/cycles/:id', requirePermission('payroll:read'), payrollStaffOnly, payrollController.getCycle)
payrollRouter.get('/cycles/:id/payslips', requirePermission('payroll:read'), payrollStaffOnly, payrollController.listCyclePayslips)
payrollRouter.get('/cycles/:id/variance-report', requirePermission('payroll:read'), payrollStaffOnly, payrollController.variance)

payrollRouter.post('/cycles/:id/lock-attendance', requirePermission('payroll:run'), payrollController.lockAttendance)
payrollRouter.post('/cycles/:id/run', requirePermission('payroll:run'), payrollController.run)
payrollRouter.post('/cycles/:id/approve', requirePermission('payroll:run'), payrollController.approve)
payrollRouter.post('/cycles/:id/finance-approve', requirePermission('payroll:disburse'), payrollController.financeApprove)
payrollRouter.post('/cycles/:id/reopen', requirePermission('payroll:run'), payrollController.reopen)
payrollRouter.post('/cycles/:id/disburse', requirePermission('payroll:disburse'), payrollController.disburse)

// ─── EXPORTS ──────────────────────────────────────────────────
payrollRouter.get('/cycles/:id/bank-file/preview', requirePermission('payroll:disburse'), payrollStaffOnly, payrollController.bankFilePreview)
payrollRouter.get('/cycles/:id/bank-file', requirePermission('payroll:disburse'), payrollStaffOnly, payrollController.bankFile)
payrollRouter.get('/cycles/:id/gl-export', requirePermission('payroll:read'), payrollStaffOnly, payrollController.glExport)

// ─── PAYROLL INPUTS ───────────────────────────────────────────
payrollRouter.post('/cycles/:id/inputs', requirePermission('payroll:run'), validate(AddInputSchema), payrollController.addInput)
payrollRouter.get('/cycles/:id/inputs', requirePermission('payroll:read'), payrollStaffOnly, payrollController.listInputs)
payrollRouter.post('/inputs/:inputId/approve', requirePermission('payroll:disburse'), payrollController.approveInput)

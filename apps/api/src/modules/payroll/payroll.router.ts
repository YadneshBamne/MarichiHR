import { z } from 'zod'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { payrollService } from './payroll.service'
import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { AppError } from '../../shared/utils/AppError'
import { payrollController } from './payroll.controller'
import { CreateCycleSchema, AddInputSchema } from './payroll.schema'
import { prisma } from '../../infrastructure/database/prisma'
import { signoffThreshold } from './payroll.service'

export const payrollRouter = Router()

payrollRouter.use(authenticate)

// 'payroll:read' is held by every employee, so cycle-level endpoints also need a staff check
const STAFF = ['payroll_admin', 'compliance_officer']
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
// Two different Payroll admins approve every run (the service refuses the same person twice)
const roleStep = (role: string, message: string) => (req: any, _res: any, next: any) => (req.user!.roleIds.includes(role) ? next() : next(new AppError(message, 403)))
const NEEDS_PAYROLL_ADMIN = 'Payroll approvals come from Payroll admins. Give the role in Login & access.'
payrollRouter.post('/cycles/:id/approve', requirePermission('payroll:run'), roleStep('payroll_admin', NEEDS_PAYROLL_ADMIN), payrollController.approve)
payrollRouter.post('/cycles/:id/finance-approve', requirePermission('payroll:disburse'), roleStep('payroll_admin', NEEDS_PAYROLL_ADMIN), payrollController.financeApprove)
payrollRouter.post('/cycles/:id/reopen', requirePermission('payroll:run'), payrollController.reopen)
payrollRouter.post('/cycles/:id/disburse', requirePermission('payroll:disburse'), payrollController.disburse)
payrollRouter.post('/cycles/:id/release-payslips', requirePermission('payroll:run'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await payrollService.releasePayslips(String(req.params.id), req.user!.tenantId, req.user!.userId) })
}))
payrollRouter.post('/payslips/:id/withhold', requirePermission('payroll:run'), validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({ withheld: z.boolean(), reason: z.string().trim().min(2).max(300).optional() }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await payrollService.withholdPayslip(String(req.params.id), req.user!.tenantId, req.user!.userId, req.body.withheld, req.body.reason) })
}))

// ─── SIGN-OFF ABOVE A THRESHOLD (System admins) ───────────────
const sysOnly = (req: any, _res: any, next: any) => (req.user!.roleIds.includes('system_admin') ? next() : next(new AppError('Only a System admin signs off payroll', 403)))
payrollRouter.get('/signoff-threshold', asyncHandler(async (req, res) => {
  if (!req.user!.roleIds.some((r: string) => ['system_admin', 'payroll_admin'].includes(r))) throw new AppError('Not allowed', 403)
  res.json({ success: true, data: { amount: await signoffThreshold(req.user!.tenantId) } })
}))
payrollRouter.put('/signoff-threshold', sysOnly, validate(z.object({ body: z.object({ amount: z.number().positive().max(1e12).nullable() }).strict() })), asyncHandler(async (req, res) => {
  const t = await prisma.tenant.update({ where: { id: req.user!.tenantId }, data: { payrollSignoffAbove: req.body.amount } })
  await prisma.auditLog.create({ data: { tenantId: req.user!.tenantId, userId: req.user!.userId, action: 'PAYROLL_SIGNOFF_THRESHOLD_SET', entityType: 'tenant', entityId: t.id, newValue: { amount: req.body.amount } } })
  res.json({ success: true, data: { amount: req.body.amount } })
}))
// Cycles waiting for sign-off: totals only (a System admin does not see individual pay)
payrollRouter.get('/signoffs', sysOnly, asyncHandler(async (req, res) => {
  const tenantId = req.user!.tenantId
  const threshold = await signoffThreshold(tenantId)
  if (threshold == null) return res.json({ success: true, data: { threshold, cycles: [] } })
  const cycles = await prisma.payrollCycle.findMany({ where: { tenantId, status: 'approved', financeApprovedBy: { not: null }, signoffBy: null }, orderBy: { payPeriodStart: 'asc' } })
  const out = []
  for (const c of cycles) {
    const s = await prisma.payslip.aggregate({ where: { payrollCycleId: c.id }, _sum: { grossEarnings: true, netPay: true }, _count: true })
    if (Number(s._sum.netPay ?? 0) > threshold) out.push({ id: c.id, period: c.payPeriodStart.toISOString().slice(0, 7), people: s._count, gross: Number(s._sum.grossEarnings ?? 0), net: Number(s._sum.netPay ?? 0), currency: (await prisma.tenant.findUnique({ where: { id: tenantId }, select: { baseCurrency: true } }))?.baseCurrency })
  }
  res.json({ success: true, data: { threshold, cycles: out } })
}))
payrollRouter.post('/cycles/:id/signoff', sysOnly, validate(z.object({ params: z.object({ id: z.string().uuid() }) })), asyncHandler(async (req, res) => {
  const u = req.user!
  const c = await prisma.payrollCycle.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } })
  if (!c) throw new AppError('Payroll cycle not found', 404)
  if (c.status !== 'approved' || !c.financeApprovedBy) throw new AppError('Both Payroll approvals come first', 400)
  if (c.signoffBy) throw new AppError('Already signed off', 400)
  if ([c.approvedBy, c.financeApprovedBy].includes(u.userId)) throw new AppError('The sign-off must come from someone other than the two approvers', 403)
  const done = await prisma.payrollCycle.updateMany({ where: { id: c.id, signoffBy: null }, data: { signoffBy: u.userId, signoffAt: new Date() } })
  if (!done.count) throw new AppError('Someone else just signed it off', 409)
  await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'PAYROLL_SIGNED_OFF', entityType: 'payroll_cycle', entityId: c.id } })
  res.json({ success: true, data: { signedOff: true } })
}))

// ─── EXPORTS ──────────────────────────────────────────────────
payrollRouter.get('/cycles/:id/bank-file/preview', requirePermission('payroll:disburse'), payrollStaffOnly, payrollController.bankFilePreview)
payrollRouter.get('/cycles/:id/bank-file', requirePermission('payroll:disburse'), payrollStaffOnly, payrollController.bankFile)
payrollRouter.get('/cycles/:id/gl-export', requirePermission('payroll:read'), payrollStaffOnly, payrollController.glExport)

// ─── PAYROLL INPUTS ───────────────────────────────────────────
payrollRouter.post('/cycles/:id/inputs', requirePermission('payroll:run'), validate(AddInputSchema), payrollController.addInput)
payrollRouter.get('/cycles/:id/inputs', requirePermission('payroll:read'), payrollStaffOnly, payrollController.listInputs)
payrollRouter.post('/inputs/:inputId/approve', requirePermission('payroll:disburse'), payrollController.approveInput)

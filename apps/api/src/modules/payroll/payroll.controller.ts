import { Request, Response } from 'express'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { payrollService } from './payroll.service'

const id = (req: Request, key = 'id') => String(req.params[key])

export const payrollController = {
  createCycle: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const data = await payrollService.createCycle(tenantId, userId, req.body)
    res.status(201).json({ success: true, data })
  }),

  listCycles: asyncHandler(async (req: Request, res: Response) => {
    const data = await payrollService.listCycles(req.user!.tenantId)
    res.json({ success: true, data })
  }),

  getCycle: asyncHandler(async (req: Request, res: Response) => {
    const data = await payrollService.getCycle(id(req), req.user!.tenantId)
    res.json({ success: true, data })
  }),

  listCyclePayslips: asyncHandler(async (req: Request, res: Response) => {
    const data = await payrollService.listCyclePayslips(id(req), req.user!.tenantId)
    res.json({ success: true, data })
  }),

  lockAttendance: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const data = await payrollService.lockAttendance(id(req), tenantId, userId)
    res.json({ success: true, data })
  }),

  run: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const data = await payrollService.runCycle(id(req), tenantId, userId)
    res.json({ success: true, data })
  }),

  variance: asyncHandler(async (req: Request, res: Response) => {
    const data = await payrollService.getVarianceReport(id(req), req.user!.tenantId)
    res.json({ success: true, data })
  }),

  approve: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const data = await payrollService.approve(id(req), tenantId, userId)
    res.json({ success: true, data })
  }),

  financeApprove: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const data = await payrollService.financeApprove(id(req), tenantId, userId)
    res.json({ success: true, data })
  }),

  reopen: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const data = await payrollService.reopen(id(req), tenantId, userId)
    res.json({ success: true, data })
  }),

  disburse: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const data = await payrollService.disburse(id(req), tenantId, userId)
    res.json({ success: true, data })
  }),

  addInput: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const data = await payrollService.addInput(id(req), tenantId, userId, req.body)
    res.status(201).json({ success: true, data })
  }),

  listInputs: asyncHandler(async (req: Request, res: Response) => {
    const data = await payrollService.listInputs(id(req), req.user!.tenantId)
    res.json({ success: true, data })
  }),

  approveInput: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const data = await payrollService.approveInput(id(req, 'inputId'), tenantId, userId)
    res.json({ success: true, data })
  }),

  myPayslips: asyncHandler(async (req: Request, res: Response) => {
    const data = await payrollService.listMyPayslips(req.user!.employeeId || '')
    res.json({ success: true, data })
  }),

  pdf: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, employeeId, roleIds, userId } = req.user!
    const { pdf, filename } = await payrollService.getPayslipPdf(String(req.params.id), { tenantId, employeeId: employeeId || '', roleIds, userId })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', String(pdf.length))
    res.send(pdf)
  }),

  bankFilePreview: asyncHandler(async (req: Request, res: Response) => {
    const data = await payrollService.getBankFilePreview(id(req), req.user!.tenantId)
    res.json({ success: true, data })
  }),

  bankFile: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const { csv, filename } = await payrollService.generateBankFile(id(req), tenantId, userId, { allowPartial: req.query.allowPartial === 'true' })
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(csv)
  }),

  glExport: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!
    const { csv, filename } = await payrollService.generateGlExport(id(req), tenantId, userId)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(csv)
  }),

  getPayslip: asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, employeeId, roleIds } = req.user!
    const data = await payrollService.getPayslip(id(req), { tenantId, employeeId: employeeId || '', roleIds })
    res.json({ success: true, data })
  }),
}

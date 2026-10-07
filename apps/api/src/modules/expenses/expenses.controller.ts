import { Request, Response } from 'express'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { expensesService } from './expenses.service'
import { PerDiemQuoteQuery, FxQuoteQuery } from './expenses.schema'

const id = (req: Request) => String(req.params['id'])

export const expensesController = {
  listCategories: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.listCategories(req.user!.tenantId) })
  }),

  quotePerDiem: asyncHandler(async (req: Request, res: Response) => {
    const q = PerDiemQuoteQuery.parse(req.query)
    res.json({ success: true, data: await expensesService.quotePerDiem(req.user!.tenantId, q) })
  }),

  quoteFx: asyncHandler(async (req: Request, res: Response) => {
    const q = FxQuoteQuery.parse(req.query)
    res.json({ success: true, data: await expensesService.quoteFx(req.user!.tenantId, q) })
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ success: true, data: await expensesService.createClaim(req.user!, req.body) })
  }),

  listMine: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.listMine(req.user!) })
  }),

  getClaim: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.getClaim(id(req), req.user!) })
  }),

  withdraw: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.withdraw(id(req), req.user!) })
  }),

  listPending: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.listPending(req.user!) })
  }),

  approve: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.managerApprove(id(req), req.user!) })
  }),

  reject: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.managerReject(id(req), req.user!, req.body.reason) })
  }),

  listAwaitingFinance: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.listAwaitingFinance(req.user!) })
  }),

  financeApprove: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.financeApprove(id(req), req.user!) })
  }),

  financeReject: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.financeReject(id(req), req.user!, req.body.reason) })
  }),

  // ─── CONFIG ─────────────────────────────────────────────────
  listAllCategories: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.listAllCategories(req.user!.tenantId) })
  }),
  createCategory: asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ success: true, data: await expensesService.createCategory(req.user!.tenantId, req.body) })
  }),
  updateCategory: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.updateCategory(id(req), req.user!.tenantId, req.body) })
  }),
  listPerDiemRates: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.listPerDiemRates(req.user!.tenantId) })
  }),
  createPerDiemRate: asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ success: true, data: await expensesService.createPerDiemRate(req.user!.tenantId, req.body) })
  }),
  updatePerDiemRate: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.updatePerDiemRate(id(req), req.user!.tenantId, req.body) })
  }),
  listFxRates: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.listFxRates(req.user!.tenantId) })
  }),
  createFxRate: asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ success: true, data: await expensesService.createFxRate(req.user!.tenantId, req.body) })
  }),
  updateFxRate: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await expensesService.updateFxRate(id(req), req.user!.tenantId, req.body) })
  }),
}

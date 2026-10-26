import { Router } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { z } from 'zod'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { expensesController as c } from './expenses.controller'
import { expenseRequestService as pre, RequestBody } from './requests.service'
import {
  CreateClaimSchema, ClaimIdSchema, ReasonSchema,
  CreateCategorySchema, UpdateCategorySchema, CreatePerDiemRateSchema, UpdatePerDiemRateSchema, CreateFxRateSchema, UpdateFxRateSchema,
} from './expenses.schema'
import { smartInvoice, SendBody } from './smart-invoice.service'

export const expensesRouter = Router()

expensesRouter.use(authenticate)

// ─── EMPLOYEE ─────────────────────────────────────────────────
expensesRouter.get('/categories', requirePermission('expenses:read'), c.listCategories)
expensesRouter.get('/per-diem/quote', requirePermission('expenses:read'), c.quotePerDiem)
expensesRouter.get('/fx/quote', requirePermission('expenses:read'), c.quoteFx)
expensesRouter.post('/claims', requirePermission('expenses:write'), validate(CreateClaimSchema), c.create)

// ─── PRE-APPROVAL (money / travel / accommodation before spending); approvers act through /approvals ───
const rid = z.object({ id: z.string().uuid() })
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data })
expensesRouter.post('/requests', requirePermission('expenses:write'), validate(z.object({ body: RequestBody })), asyncHandler(async (req, res) => ok(res, await pre.create(req.user!, req.body), 201)))
expensesRouter.get('/requests', requirePermission('expenses:read'), validate(z.object({ query: z.object({ scope: z.enum(['mine', 'finance', 'all']).default('mine') }) })), asyncHandler(async (req, res) => ok(res, await pre.list(req.user!, (req.query.scope as any) || 'mine'))))
expensesRouter.get('/requests/:id', requirePermission('expenses:read'), validate(z.object({ params: rid })), asyncHandler(async (req, res) => ok(res, await pre.get(req.user!, String(req.params.id)))))
expensesRouter.post('/requests/:id/withdraw', requirePermission('expenses:write'), validate(z.object({ params: rid })), asyncHandler(async (req, res) => ok(res, await pre.withdraw(req.user!, String(req.params.id)))))
expensesRouter.post('/requests/:id/close', validate(z.object({ params: rid, body: z.object({ note: z.string().trim().max(500).optional() }).strict() })), asyncHandler(async (req, res) => ok(res, await pre.close(req.user!, String(req.params.id), req.body.note))))
expensesRouter.get('/claims/me', requirePermission('expenses:read'), c.listMine)

// ─── MANAGER / FINANCE QUEUES (before /claims/:id) ────────────
expensesRouter.get('/claims/pending', requirePermission('expenses:approve'), c.listPending)
expensesRouter.get('/claims/awaiting-finance', requirePermission('expenses:finance'), c.listAwaitingFinance)

expensesRouter.get('/claims/:id', requirePermission('expenses:read'), validate(ClaimIdSchema), c.getClaim)
expensesRouter.post('/claims/:id/withdraw', requirePermission('expenses:write'), validate(ClaimIdSchema), c.withdraw)
expensesRouter.post('/claims/:id/approve', requirePermission('expenses:approve'), validate(ClaimIdSchema), c.approve)
expensesRouter.post('/claims/:id/reject', requirePermission('expenses:approve'), validate(ReasonSchema), c.reject)
expensesRouter.post('/claims/:id/finance-approve', requirePermission('expenses:finance'), validate(ClaimIdSchema), c.financeApprove)
expensesRouter.post('/claims/:id/finance-reject', requirePermission('expenses:finance'), validate(ReasonSchema), c.financeReject)

// ZRA Smart Invoice purchases through DigiTax (only for the company the DigiTax key belongs to)
expensesRouter.get('/smart-invoice/items', requirePermission('expenses:finance'), asyncHandler(async (req, res) => ok(res, await smartInvoice.items(req.user!))))
expensesRouter.put('/smart-invoice/categories/:id', requirePermission('expenses:finance'), validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({ itemId: z.string().trim().min(1).max(80).nullable() }).strict() })), asyncHandler(async (req, res) => ok(res, await smartInvoice.mapCategory(req.user!, String(req.params.id), req.body.itemId))))
expensesRouter.post('/claims/:id/smart-invoice', requirePermission('expenses:finance'), validate(z.object({ params: z.object({ id: z.string().uuid() }), body: SendBody })), asyncHandler(async (req, res) => ok(res, await smartInvoice.send(req.user!, String(req.params.id), req.body))))
expensesRouter.post('/claims/:id/smart-invoice/refresh', requirePermission('expenses:finance'), validate(z.object({ params: z.object({ id: z.string().uuid() }) })), asyncHandler(async (req, res) => ok(res, await smartInvoice.refresh(req.user!, String(req.params.id)))))
expensesRouter.get('/smart-invoice', requirePermission('expenses:finance'), asyncHandler(async (req, res) => ok(res, await smartInvoice.overview(req.user!))))
expensesRouter.get('/smart-invoice/claims', requirePermission('expenses:finance'), asyncHandler(async (req, res) => ok(res, await smartInvoice.claims(req.user!))))

// ─── CONFIG ───────────────────────────────────────────────────
expensesRouter.get('/config/categories', requirePermission('expenses:configure'), c.listAllCategories)
expensesRouter.post('/config/categories', requirePermission('expenses:configure'), validate(CreateCategorySchema), c.createCategory)
expensesRouter.patch('/config/categories/:id', requirePermission('expenses:configure'), validate(UpdateCategorySchema), c.updateCategory)
expensesRouter.get('/config/per-diem-rates', requirePermission('expenses:configure'), c.listPerDiemRates)
expensesRouter.post('/config/per-diem-rates', requirePermission('expenses:configure'), validate(CreatePerDiemRateSchema), c.createPerDiemRate)
expensesRouter.patch('/config/per-diem-rates/:id', requirePermission('expenses:configure'), validate(UpdatePerDiemRateSchema), c.updatePerDiemRate)
expensesRouter.get('/config/fx-rates', requirePermission('expenses:configure'), c.listFxRates)
expensesRouter.post('/config/fx-rates', requirePermission('expenses:configure'), validate(CreateFxRateSchema), c.createFxRate)
expensesRouter.patch('/config/fx-rates/:id', requirePermission('expenses:configure'), validate(UpdateFxRateSchema), c.updateFxRate)

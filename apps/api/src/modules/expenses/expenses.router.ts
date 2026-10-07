import { Router } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { expensesController as c } from './expenses.controller'
import {
  CreateClaimSchema, ClaimIdSchema, ReasonSchema,
  CreateCategorySchema, UpdateCategorySchema, CreatePerDiemRateSchema, UpdatePerDiemRateSchema, CreateFxRateSchema, UpdateFxRateSchema,
} from './expenses.schema'

export const expensesRouter = Router()

expensesRouter.use(authenticate)

// ─── EMPLOYEE ─────────────────────────────────────────────────
expensesRouter.get('/categories', requirePermission('expenses:read'), c.listCategories)
expensesRouter.get('/per-diem/quote', requirePermission('expenses:read'), c.quotePerDiem)
expensesRouter.get('/fx/quote', requirePermission('expenses:read'), c.quoteFx)
expensesRouter.post('/claims', requirePermission('expenses:write'), validate(CreateClaimSchema), c.create)
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

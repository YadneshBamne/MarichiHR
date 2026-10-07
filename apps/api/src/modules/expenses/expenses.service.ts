import { Prisma } from '@prisma/client'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, assertCanApprove } from '../../shared/utils/access'
import { businessToday, normaliseDateInput } from '../../shared/utils/businessDate'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const ymd = (d: Date) => d.toISOString().slice(0, 10)

const claimInclude = {
  category: { select: { id: true, name: true, code: true } },
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } },
} as const

async function audit(user: AccessUser, action: string, claimId: string, newValue?: Prisma.InputJsonValue) {
  await prisma.auditLog.create({
    data: { tenantId: user.tenantId, userId: user.userId, action, entityType: 'expense_claim', entityId: claimId, newValue },
  })
}

async function getHomeCurrency(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { baseCurrency: true } })
  return tenant?.baseCurrency || 'USD'
}

// ─── RATE LOOKUPS ─────────────────────────────────────────────
async function resolveFx(tenantId: string, from: string, home: string, date: Date) {
  if (from === home) return { fxRate: 1, fxRateDate: null as Date | null }
  const fx = await prisma.fxRate.findFirst({
    where: { tenantId, fromCurrency: from, toCurrency: home, effectiveFrom: { lte: date } },
    orderBy: { effectiveFrom: 'desc' },
  })
  if (!fx) throw new AppError(`No FX rate for ${from} on ${ymd(date)}`, 400)
  return { fxRate: fx.rate, fxRateDate: fx.effectiveFrom }
}

async function resolvePerDiemRate(tenantId: string, countryCode: string, city: string | undefined, date: Date) {
  const effective = { active: true, effectiveFrom: { lte: date }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: date } }] }
  if (city) {
    const cityRate = await prisma.perDiemRate.findFirst({
      where: { tenantId, countryCode, city: { equals: city, mode: 'insensitive' }, ...effective },
      orderBy: { effectiveFrom: 'desc' },
    })
    if (cityRate) return cityRate
  }
  const countryRate = await prisma.perDiemRate.findFirst({
    where: { tenantId, countryCode, city: null, ...effective },
    orderBy: { effectiveFrom: 'desc' },
  })
  if (!countryRate) throw new AppError('No per-diem rate', 400)
  return countryRate
}

async function priceClaim(tenantId: string, input: {
  currency: string
  amount: number
  date: Date
}) {
  const homeCurrency = await getHomeCurrency(tenantId)
  const { fxRate, fxRateDate } = await resolveFx(tenantId, input.currency, homeCurrency, input.date)
  const expenseAmount = round2(input.amount)
  return { homeCurrency, fxRate, fxRateDate, expenseAmount, homeAmount: round2(expenseAmount * fxRate) }
}

// ─── SERVICE ──────────────────────────────────────────────────
export const expensesService = {
  async listCategories(tenantId: string) {
    return prisma.expenseCategory.findMany({ where: { tenantId, active: true }, orderBy: { name: 'asc' } })
  },

  async quotePerDiem(tenantId: string, q: { countryCode: string; city?: string; days: number; date: string }) {
    const date = normaliseDateInput(q.date)
    const rate = await resolvePerDiemRate(tenantId, q.countryCode, q.city, date)
    const priced = await priceClaim(tenantId, { currency: rate.currency, amount: q.days * rate.ratePerDay, date })
    return {
      rate: rate.ratePerDay,
      currency: rate.currency,
      days: q.days,
      expenseAmount: priced.expenseAmount,
      fxRate: priced.fxRate,
      homeAmount: priced.homeAmount,
      homeCurrency: priced.homeCurrency,
    }
  },

  async quoteFx(tenantId: string, q: { currency: string; date: string }) {
    const homeCurrency = await getHomeCurrency(tenantId)
    const { fxRate, fxRateDate } = await resolveFx(tenantId, q.currency, homeCurrency, normaliseDateInput(q.date))
    return { fxRate, fxRateDate: fxRateDate ? ymd(fxRateDate) : null, homeCurrency }
  },

  async createClaim(user: AccessUser, body: any) {
    // The claimant is always the caller — never taken from the request body
    if (!user.employeeId) throw new AppError('Only employees can submit expense claims', 403)
    const { tenantId } = user

    const category = await prisma.expenseCategory.findFirst({ where: { id: body.categoryId, tenantId, active: true } })
    if (!category) throw new AppError('Expense category not found', 404)

    const expenseDate = normaliseDateInput(body.expenseDate)
    if (expenseDate > (await businessToday(tenantId))) throw new AppError('Expense date cannot be in the future', 400)

    let data: Omit<Prisma.ReimbursementClaimUncheckedCreateInput, 'tenantId' | 'employeeId'>
    if (body.claimType === 'per_diem') {
      const rate = await resolvePerDiemRate(tenantId, body.countryCode, body.city, expenseDate)
      const priced = await priceClaim(tenantId, { currency: rate.currency, amount: body.days * rate.ratePerDay, date: expenseDate })
      data = {
        categoryId: category.id,
        claimType: 'per_diem',
        expenseDate,
        description: body.description,
        expenseCurrency: rate.currency,
        expenseAmount: priced.expenseAmount,
        fxRate: priced.fxRate,
        fxRateDate: priced.fxRateDate,
        homeCurrency: priced.homeCurrency,
        homeAmount: priced.homeAmount,
        perDiemRateId: rate.id,
        perDiemDays: body.days,
        perDiemCountry: body.countryCode,
        perDiemCity: body.city ?? null,
      }
    } else {
      const priced = await priceClaim(tenantId, { currency: body.expenseCurrency, amount: body.expenseAmount, date: expenseDate })
      if (category.receiptRequiredAbove != null && priced.homeAmount > category.receiptRequiredAbove && !body.receiptNumber) {
        throw new AppError(`A receipt number is required for ${category.name} claims above ${category.receiptRequiredAbove} ${priced.homeCurrency}`, 400)
      }
      let overLimit = false
      if (category.maxAmount != null && priced.homeAmount > category.maxAmount) {
        if (category.enforceLimit) {
          throw new AppError(`${category.name} claims are limited to ${category.maxAmount} ${priced.homeCurrency} per claim`, 400)
        }
        overLimit = true
      }
      data = {
        categoryId: category.id,
        claimType: 'actual',
        expenseDate,
        description: body.description,
        receiptNumber: body.receiptNumber ?? null,
        expenseCurrency: body.expenseCurrency,
        expenseAmount: priced.expenseAmount,
        fxRate: priced.fxRate,
        fxRateDate: priced.fxRateDate,
        homeCurrency: priced.homeCurrency,
        homeAmount: priced.homeAmount,
        overLimit,
      }
    }

    const claim = await prisma.reimbursementClaim.create({
      data: { ...data, tenantId, employeeId: user.employeeId, status: 'submitted' },
      include: claimInclude,
    })
    await audit(user, 'EXPENSE_SUBMITTED', claim.id, { claimType: claim.claimType, homeAmount: claim.homeAmount, homeCurrency: claim.homeCurrency })
    return claim
  },

  async listMine(user: AccessUser) {
    if (!user.employeeId) return []
    return prisma.reimbursementClaim.findMany({
      where: { tenantId: user.tenantId, employeeId: user.employeeId },
      include: claimInclude,
      orderBy: { createdAt: 'desc' },
    })
  },

  // Owner, their direct manager, hr_admin, payroll_admin — everyone else gets a 404
  async getClaim(id: string, user: AccessUser) {
    const claim = await prisma.reimbursementClaim.findFirst({ where: { id, tenantId: user.tenantId }, include: claimInclude })
    if (!claim) throw new AppError('Claim not found', 404)
    const isOwner = !!user.employeeId && claim.employeeId === user.employeeId
    const isManager = !!user.employeeId && claim.employee.managerId === user.employeeId
    if (!isOwner && !isManager && !user.roleIds.some((r) => ['hr_admin', 'payroll_admin'].includes(r))) {
      throw new AppError('Claim not found', 404)
    }
    return claim
  },

  async withdraw(id: string, user: AccessUser) {
    const claim = await prisma.reimbursementClaim.findFirst({ where: { id, tenantId: user.tenantId } })
    if (!claim || claim.employeeId !== user.employeeId) throw new AppError('Claim not found', 404)
    const res = await prisma.reimbursementClaim.updateMany({ where: { id, tenantId: user.tenantId, status: 'submitted' }, data: { status: 'withdrawn' } })
    if (res.count === 0) throw new AppError(`Only submitted claims can be withdrawn (this one is ${claim.status})`, 400)
    await audit(user, 'EXPENSE_WITHDRAWN', id)
    return prisma.reimbursementClaim.findUnique({ where: { id }, include: claimInclude })
  },

  // ─── MANAGER STEP ───────────────────────────────────────────
  async listPending(user: AccessUser) {
    const isHR = user.roleIds.includes('hr_admin')
    if (!isHR && !user.employeeId) return []
    return prisma.reimbursementClaim.findMany({
      where: {
        tenantId: user.tenantId,
        status: 'submitted',
        ...(isHR ? {} : { employee: { managerId: user.employeeId } }),
      },
      include: claimInclude,
      orderBy: { createdAt: 'asc' },
    })
  },

  async managerApprove(id: string, user: AccessUser) {
    const claim = await this.loadForManagerStep(id, user)
    const res = await prisma.reimbursementClaim.updateMany({
      where: { id, tenantId: user.tenantId, status: 'submitted' },
      data: { status: 'manager_approved', managerApprovedByUserId: user.userId, managerApprovedAt: new Date() },
    })
    if (res.count === 0) throw new AppError(`Claim is already ${claim.status}`, 400)
    await audit(user, 'EXPENSE_MANAGER_APPROVED', id)
    return prisma.reimbursementClaim.findUnique({ where: { id }, include: claimInclude })
  },

  async managerReject(id: string, user: AccessUser, reason: string) {
    const claim = await this.loadForManagerStep(id, user)
    const res = await prisma.reimbursementClaim.updateMany({
      where: { id, tenantId: user.tenantId, status: 'submitted' },
      data: { status: 'rejected', rejectionReason: reason, rejectedByUserId: user.userId },
    })
    if (res.count === 0) throw new AppError(`Claim is already ${claim.status}`, 400)
    await audit(user, 'EXPENSE_REJECTED', id, { step: 'manager', reason })
    return prisma.reimbursementClaim.findUnique({ where: { id }, include: claimInclude })
  },

  async loadForManagerStep(id: string, user: AccessUser) {
    const claim = await prisma.reimbursementClaim.findFirst({ where: { id, tenantId: user.tenantId } })
    if (!claim) throw new AppError('Claim not found', 404)
    if (!user.employeeId) throw new AppError('Only employees with an employee record can approve claims', 403)
    await assertCanApprove(user, claim.employeeId, user.tenantId, { entityType: 'expense_claim', entityId: id })
    return claim
  },

  // ─── FINANCE STEP ───────────────────────────────────────────
  async listAwaitingFinance(user: AccessUser) {
    return prisma.reimbursementClaim.findMany({
      where: { tenantId: user.tenantId, status: 'manager_approved' },
      include: claimInclude,
      orderBy: { createdAt: 'asc' },
    })
  },

  async loadForFinanceStep(id: string, user: AccessUser) {
    const claim = await prisma.reimbursementClaim.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { employee: { select: { userId: true } } },
    })
    if (!claim) throw new AppError('Claim not found', 404)
    if (claim.employee.userId === user.userId) throw new AppError('You cannot finance-approve your own claim', 403)
    return claim
  },

  async financeApprove(id: string, user: AccessUser) {
    const claim = await this.loadForFinanceStep(id, user)
    if (claim.managerApprovedByUserId === user.userId) {
      throw new AppError('Finance approval must come from a different user than the manager approver', 403)
    }
    const res = await prisma.reimbursementClaim.updateMany({
      where: { id, tenantId: user.tenantId, status: 'manager_approved' },
      data: { status: 'finance_approved', financeApprovedByUserId: user.userId, financeApprovedAt: new Date() },
    })
    if (res.count === 0) throw new AppError(`Claim must be manager-approved first (it is ${claim.status})`, 400)
    await audit(user, 'EXPENSE_FINANCE_APPROVED', id)
    return prisma.reimbursementClaim.findUnique({ where: { id }, include: claimInclude })
  },

  async financeReject(id: string, user: AccessUser, reason: string) {
    const claim = await this.loadForFinanceStep(id, user)
    const res = await prisma.reimbursementClaim.updateMany({
      where: { id, tenantId: user.tenantId, status: 'manager_approved' },
      data: { status: 'rejected', rejectionReason: reason, rejectedByUserId: user.userId },
    })
    if (res.count === 0) throw new AppError(`Claim must be manager-approved first (it is ${claim.status})`, 400)
    await audit(user, 'EXPENSE_REJECTED', id, { step: 'finance', reason })
    return prisma.reimbursementClaim.findUnique({ where: { id }, include: claimInclude })
  },

  // ─── CONFIG (tenant-scoped) ─────────────────────────────────
  listAllCategories: (tenantId: string) => prisma.expenseCategory.findMany({ where: { tenantId }, orderBy: { name: 'asc' } }),

  async createCategory(tenantId: string, d: { name: string; code: string; maxAmount?: number | null; enforceLimit?: boolean; receiptRequiredAbove?: number | null }) {
    try {
      return await prisma.expenseCategory.create({ data: { tenantId, name: d.name, code: d.code, maxAmount: d.maxAmount ?? null, enforceLimit: d.enforceLimit ?? false, receiptRequiredAbove: d.receiptRequiredAbove ?? null } })
    } catch (err: any) {
      if (err?.code === 'P2002') throw new AppError('A category with this code already exists', 409)
      throw err
    }
  },

  async updateCategory(id: string, tenantId: string, d: Record<string, any>) {
    const existing = await prisma.expenseCategory.findFirst({ where: { id, tenantId }, select: { id: true } })
    if (!existing) throw new AppError('Expense category not found', 404)
    return prisma.expenseCategory.update({ where: { id }, data: d })
  },

  listPerDiemRates: (tenantId: string) => prisma.perDiemRate.findMany({ where: { tenantId }, orderBy: [{ countryCode: 'asc' }, { effectiveFrom: 'desc' }] }),

  async createPerDiemRate(tenantId: string, d: { countryCode: string; city?: string | null; ratePerDay: number; currency: string; effectiveFrom: string; effectiveUntil?: string | null }) {
    return prisma.perDiemRate.create({
      data: {
        tenantId, countryCode: d.countryCode, city: d.city ?? null, ratePerDay: d.ratePerDay, currency: d.currency,
        effectiveFrom: normaliseDateInput(d.effectiveFrom), effectiveUntil: d.effectiveUntil ? normaliseDateInput(d.effectiveUntil) : null,
      },
    })
  },

  async updatePerDiemRate(id: string, tenantId: string, d: { ratePerDay?: number; currency?: string; effectiveUntil?: string | null; active?: boolean }) {
    const existing = await prisma.perDiemRate.findFirst({ where: { id, tenantId }, select: { id: true } })
    if (!existing) throw new AppError('Per-diem rate not found', 404)
    const { effectiveUntil, ...rest } = d
    return prisma.perDiemRate.update({
      where: { id },
      data: { ...rest, ...(effectiveUntil !== undefined && { effectiveUntil: effectiveUntil ? normaliseDateInput(effectiveUntil) : null }) },
    })
  },

  listFxRates: (tenantId: string) => prisma.fxRate.findMany({ where: { tenantId }, orderBy: [{ fromCurrency: 'asc' }, { effectiveFrom: 'desc' }] }),

  async createFxRate(tenantId: string, d: { fromCurrency: string; toCurrency: string; rate: number; effectiveFrom: string }) {
    if (d.fromCurrency === d.toCurrency) throw new AppError('From and to currencies must differ', 400)
    try {
      return await prisma.fxRate.create({ data: { tenantId, fromCurrency: d.fromCurrency, toCurrency: d.toCurrency, rate: d.rate, effectiveFrom: normaliseDateInput(d.effectiveFrom) } })
    } catch (err: any) {
      if (err?.code === 'P2002') throw new AppError('An FX rate for this pair and date already exists', 409)
      throw err
    }
  },

  async updateFxRate(id: string, tenantId: string, d: { rate: number }) {
    const existing = await prisma.fxRate.findFirst({ where: { id, tenantId }, select: { id: true } })
    if (!existing) throw new AppError('FX rate not found', 404)
    return prisma.fxRate.update({ where: { id }, data: { rate: d.rate } })
  },
}

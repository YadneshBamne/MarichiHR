import { z } from 'zod'

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const currency = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code such as ZMW')
const country = z.string().regex(/^[A-Za-z]{2}$/, 'Use a 2-letter country code').transform((s) => s.toUpperCase())
const idParam = z.object({ id: z.string().uuid() })

// Every body is strict: unknown keys (status, homeAmount, fxRate, employeeId, approver fields...) are rejected with 400
const common = {
  categoryId: z.string().uuid(),
  expenseDate: dateString,
  description: z.string().trim().min(1).max(500),
}

const ActualClaimBody = z.object({
  claimType: z.literal('actual'),
  ...common,
  receiptNumber: z.string().trim().min(1).max(60).optional(),
  expenseCurrency: currency,
  expenseAmount: z.number().positive().max(1_000_000_000),
}).strict()

const PerDiemClaimBody = z.object({
  claimType: z.literal('per_diem'),
  ...common,
  countryCode: country,
  city: z.string().trim().min(1).max(80).optional(),
  days: z.number().positive().max(366).refine((d) => Math.round(d * 2) === d * 2, 'Days must be a whole or half number'),
}).strict()

export const CreateClaimSchema = z.object({
  body: z.discriminatedUnion('claimType', [ActualClaimBody, PerDiemClaimBody]),
})

export const ClaimIdSchema = z.object({ params: idParam })

export const ReasonSchema = z.object({
  params: idParam,
  body: z.object({ reason: z.string().trim().min(1, 'A reason is required').max(500) }).strict(),
})

export const PerDiemQuoteQuery = z.object({
  countryCode: country,
  city: z.string().trim().min(1).max(80).optional(),
  days: z.coerce.number().positive().max(366).refine((d) => Math.round(d * 2) === d * 2, 'Days must be a whole or half number'),
  date: dateString,
})

export const FxQuoteQuery = z.object({ currency, date: dateString })

// ─── CONFIG ───────────────────────────────────────────────────
export const CreateCategorySchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(80),
    code: z.string().trim().min(1).max(30),
    maxAmount: z.number().positive().nullable().optional(),
    enforceLimit: z.boolean().optional(),
    receiptRequiredAbove: z.number().nonnegative().nullable().optional(),
  }).strict(),
})

export const UpdateCategorySchema = z.object({
  params: idParam,
  body: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    maxAmount: z.number().positive().nullable().optional(),
    enforceLimit: z.boolean().optional(),
    receiptRequiredAbove: z.number().nonnegative().nullable().optional(),
    active: z.boolean().optional(),
  }).strict(),
})

export const CreatePerDiemRateSchema = z.object({
  body: z.object({
    countryCode: country,
    city: z.string().trim().min(1).max(80).nullable().optional(),
    ratePerDay: z.number().positive(),
    currency,
    effectiveFrom: dateString,
    effectiveUntil: dateString.nullable().optional(),
  }).strict(),
})

export const UpdatePerDiemRateSchema = z.object({
  params: idParam,
  body: z.object({
    ratePerDay: z.number().positive().optional(),
    currency: currency.optional(),
    effectiveUntil: dateString.nullable().optional(),
    active: z.boolean().optional(),
  }).strict(),
})

export const CreateFxRateSchema = z.object({
  body: z.object({
    fromCurrency: currency,
    toCurrency: currency,
    rate: z.number().positive(),
    effectiveFrom: dateString,
  }).strict(),
})

export const UpdateFxRateSchema = z.object({
  params: idParam,
  body: z.object({ rate: z.number().positive() }).strict(),
})

import { z } from 'zod'

export const LEAVE_CATEGORIES = ['annual', 'sick', 'casual', 'maternity', 'paternity', 'bereavement', 'compensatory', 'unpaid', 'other'] as const

const leaveTypeFields = {
  name: z.string().trim().min(1).max(100),
  category: z.enum(LEAVE_CATEGORIES),
  isPaid: z.boolean(),
  isStatutory: z.boolean(),
  statutoryCountry: z.string().length(2).toUpperCase().nullable(),
  accrualType: z.enum(['monthly_prorate', 'annual_lumpsum', 'manual']).nullable(),
  accrualAmount: z.number().min(0).max(366).nullable(),
  accrualDayOfMonth: z.number().int().min(1).max(28).nullable(),
  carryForward: z.boolean(),
  carryForwardMax: z.number().min(0).nullable(),
  carryForwardExpiryMonths: z.number().int().min(1).max(60).nullable(),
  allowNegative: z.boolean(),
  encashable: z.boolean(),
  halfDayAllowed: z.boolean(),
  hourlyAllowed: z.boolean(),
  leaveUnit: z.enum(['day', 'hour']),
  approvalLevels: z.number().int().min(1).max(3),
  requiresHrForStatutory: z.boolean(),
  attachmentRequiredAfterDays: z.number().int().min(1).nullable(),
  sandwichRule: z.boolean(),
}

const partial = z.object(leaveTypeFields).partial()

export const consistent = (b: z.infer<typeof partial>) =>
  !(b.accrualType && b.accrualType !== 'manual' && !(b.accrualAmount && b.accrualAmount > 0))

export const CreateLeaveTypeSchema = z.object({
  body: partial
    .extend({ name: leaveTypeFields.name, category: leaveTypeFields.category, code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,19}$/, 'Code must be 2-20 upper-case letters, digits or _') })
    .strict()
    .refine(consistent, { message: 'Accruing leave types need an accrual amount above 0', path: ['accrualAmount'] }),
})

// Code is the stable key other records and reports use, so it cannot change; archive with active=false
export const UpdateLeaveTypeSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: partial.extend({ active: z.boolean().optional() }).strict(),
})

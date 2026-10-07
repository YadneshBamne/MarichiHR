import { z } from 'zod'

export const UpdateSalaryRuleSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    categoryId: z.string().uuid().optional(),
    name: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    sequence: z.number().int().optional(),
    amountType: z.enum(['fixed', 'percentage', 'python_code']).optional(),
    amountFixed: z.number().nullable().optional(),
    amountPercentage: z.number().nullable().optional(),
    amountPercentageBase: z.string().nullable().optional(),
    pythonCode: z.string().nullable().optional(),
    conditionSelect: z.enum(['always', 'python_expression']).optional(),
    conditionExpr: z.string().nullable().optional(),
    appearsOnPayslip: z.boolean().optional(),
  }).strict(),
})

export const UpdateGradeBandSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    code: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    salaryMin: z.number().optional(),
    salaryMid: z.number().optional(),
    salaryMax: z.number().optional(),
    currency: z.string().length(3).optional(),
    active: z.boolean().optional(),
  }).strict(),
})

export const LinkStructureSchema = z.object({
  params: z.object({ contractId: z.string().uuid() }),
  body: z.object({
    salaryStructureId: z.string().uuid(),
    gradeBandId: z.string().uuid().optional(),
  }).strict(),
})

const idParam = z.object({ id: z.string().uuid() })
// Rule codes are referenced from formulas as rules.CODE, so keep them identifier-safe
const ruleCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/, 'Use UPPER_CASE letters, digits and _ (e.g. HRA)')

export const CreateStructureTypeSchema = z.object({
  body: z.object({ name: z.string().trim().min(1).max(100), wageType: z.enum(['monthly', 'hourly']).optional() }).strict(),
})

export const UpdateStructureTypeSchema = z.object({
  params: idParam,
  body: z.object({ name: z.string().trim().min(1).max(100).optional(), wageType: z.enum(['monthly', 'hourly']).optional(), active: z.boolean().optional() }).strict(),
})

export const CreateStructureSchema = z.object({
  body: z.object({
    structureTypeId: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    code: z.string().trim().regex(/^[A-Z0-9_-]{1,40}$/, 'Use UPPER_CASE letters, digits, _ or -'),
    countryCode: z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter country code').optional(),
    description: z.string().trim().max(500).optional(),
  }).strict(),
})

export const UpdateStructureSchema = z.object({
  params: idParam,
  body: z.object({
    structureTypeId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(100).optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    active: z.boolean().optional(),
  }).strict(),
})

const ruleFields = {
  categoryId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  code: ruleCode,
  sequence: z.number().int().min(0).max(10000),
  amountType: z.enum(['fixed', 'percentage', 'python_code']),
  amountFixed: z.number().nullable().optional(),
  amountPercentage: z.number().nullable().optional(),
  amountPercentageBase: z.string().nullable().optional(),
  pythonCode: z.string().max(500).nullable().optional(),
  conditionSelect: z.enum(['always', 'python_expression']).optional(),
  conditionExpr: z.string().max(500).nullable().optional(),
  appearsOnPayslip: z.boolean().optional(),
}

export const CreateSalaryRuleSchema = z.object({
  body: z.object({ salaryStructureId: z.string().uuid(), ...ruleFields }).strict(),
})

// Dry-run a candidate rule inside its structure (replacing ruleId when editing) on a sample wage
export const CheckRuleSchema = z.object({
  body: z.object({
    salaryStructureId: z.string().uuid(),
    ruleId: z.string().uuid().optional(),
    sampleWage: z.number().positive().max(1_000_000_000).optional(),
    rule: z.object(ruleFields).strict(),
  }).strict(),
})

export const CreateGradeBandSchema = z.object({
  body: z.object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(100),
    salaryMin: z.number().nonnegative(),
    salaryMid: z.number().nonnegative(),
    salaryMax: z.number().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict().refine((b) => b.salaryMin <= b.salaryMid && b.salaryMid <= b.salaryMax, 'Band must satisfy min ≤ mid ≤ max'),
})

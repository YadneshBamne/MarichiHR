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
  }).strict(),
})

export const LinkStructureSchema = z.object({
  params: z.object({ contractId: z.string().uuid() }),
  body: z.object({
    salaryStructureId: z.string().uuid(),
    gradeBandId: z.string().uuid().optional(),
  }).strict(),
})

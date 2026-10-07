import { z } from 'zod'

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

export const CreateCycleSchema = z.object({
  body: z.object({
    payPeriodStart: dateString,
    payPeriodEnd: dateString,
    cycleType: z.enum(['monthly', 'bi_weekly', 'weekly']).optional(),
  }),
})

export const AddInputSchema = z.object({
  body: z.object({
    employeeId: z.string().uuid(),
    inputTypeId: z.string().uuid(),
    amount: z.number().positive(),
    description: z.string().optional(),
  }),
})

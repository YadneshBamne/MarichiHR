import { z } from 'zod'

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

export const CreateCycleSchema = z.object({
  body: z.object({
    payPeriodStart: dateString,
    payPeriodEnd: dateString,
    cycleType: z.enum(['monthly', 'bi_weekly', 'weekly']).optional(),
    offCycle: z.boolean().optional(), // a one-off run paying only its inputs
    reason: z.string().trim().max(300).optional(),
    correctsCycleId: z.string().uuid().optional(), // a correction to a run that was already paid
    legalEntityId: z.string().uuid().optional(), // a run for one legal entity's employees
  }).strict(),
})

export const AddInputSchema = z.object({
  body: z.object({
    employeeId: z.string().uuid(),
    inputTypeId: z.string().uuid(),
    amount: z.number().positive(),
    description: z.string().max(300).optional(),
  }).strict(),
})

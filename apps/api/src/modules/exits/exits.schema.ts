import { z } from 'zod'

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const idParam = z.object({ id: z.string().uuid() })

export const DEPARTMENTS = ['IT', 'FINANCE', 'ADMIN', 'MANAGER'] as const

export const InitiateExitSchema = z.object({
  body: z.object({
    employeeId: z.string().uuid(),
    exitType: z.string().trim().min(1).max(40), // exit_type master
    reason: z.string().trim().min(1).max(1000),
    noticeDate: dateString,
    lastWorkingDate: dateString,
    // The last working day is already past (the person has left): HR confirms that on purpose
    backdated: z.boolean().optional(),
    // Default: recover from a resigning employee, buy out (pay in lieu) for a termination
    shortfallAction: z.enum(['recover', 'buyout', 'waive']).optional(),
    // User responsible for each sign-off. MANAGER defaults to the employee's direct manager.
    clearance: z.object({
      IT: z.string().uuid(),
      FINANCE: z.string().uuid(),
      ADMIN: z.string().uuid(),
      MANAGER: z.string().uuid().optional(),
    }).strict(),
  }).strict(),
})

export const ExitIdSchema = z.object({ params: idParam })

export const SignClearanceSchema = z.object({
  params: z.object({ id: z.string().uuid(), department: z.enum(DEPARTMENTS) }),
  body: z.object({ note: z.string().trim().max(500).optional() }).strict(),
})

export const ComputeSchema = z.object({
  params: idParam,
  body: z.object({
    recoveries: z.array(z.object({
      description: z.string().trim().min(1).max(200),
      amount: z.number().positive().max(1_000_000_000),
    }).strict()).max(20).optional(),
  }).strict(),
})

export const CancelExitSchema = z.object({
  params: idParam,
  body: z.object({ reason: z.string().trim().min(1).max(500) }).strict(),
})

const clearanceBody = z.object({ IT: z.string().uuid(), FINANCE: z.string().uuid(), ADMIN: z.string().uuid(), MANAGER: z.string().uuid().optional() }).strict()

// An employee hands in their own resignation
export const ResignSchema = z.object({ body: z.object({ reason: z.string().trim().min(3).max(1000), lastWorkingDate: dateString.optional() }).strict() })

// HR accepts it (dates may be changed, the four sign-offs are chosen) or declines it with a reason
export const AcceptSchema = z.object({
  params: idParam,
  body: z.object({ noticeDate: dateString.optional(), lastWorkingDate: dateString.optional(), shortfallAction: z.enum(['recover', 'buyout', 'waive']).optional(), backdated: z.boolean().optional(), clearance: clearanceBody }).strict(),
})
export const DeclineSchema = z.object({ params: idParam, body: z.object({ reason: z.string().trim().min(3).max(500) }).strict() })

// How a negative settlement is recovered (or that it is waived)
export const RecoverySchema = z.object({
  params: idParam,
  body: z.object({ note: z.string().trim().min(5).max(500), recoveredAmount: z.number().min(0).max(1_000_000_000).nullable().optional(), waived: z.boolean().optional() }).strict(),
})

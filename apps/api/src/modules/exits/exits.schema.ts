import { z } from 'zod'

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const idParam = z.object({ id: z.string().uuid() })

export const DEPARTMENTS = ['IT', 'FINANCE', 'ADMIN', 'MANAGER'] as const

export const InitiateExitSchema = z.object({
  body: z.object({
    employeeId: z.string().uuid(),
    exitType: z.enum(['resignation', 'termination']),
    reason: z.string().trim().min(1).max(1000),
    noticeDate: dateString,
    lastWorkingDate: dateString,
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

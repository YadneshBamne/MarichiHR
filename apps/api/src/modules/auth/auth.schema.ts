import { z } from 'zod'

export const LoginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
    tenantSlug: z.string().min(1, 'Tenant slug is required'),
  }),
})

export const RefreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, 'Refresh token is required'),
  }),
})

export const MfaVerifySchema = z.object({
  body: z.object({
    mfaToken: z.string().min(1),
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  }).strict(),
})

export const MfaCodeSchema = z.object({
  body: z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict(),
})

export const SsoExchangeSchema = z.object({
  body: z.object({ code: z.string().min(1) }).strict(),
})

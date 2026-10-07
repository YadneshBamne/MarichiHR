import { z } from 'zod'

export const LoginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
    tenantSlug: z.string().trim().max(60).optional().or(z.literal('').transform(() => undefined)),
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

const pwRule = 'Use at least 10 characters with a letter and a number'
// Either email + password, or googleCode (from Continue with Google on the sign-up page) instead of both
export const SignupSchema = z.object({
  body: z.object({
    companyName: z.string().trim().min(2, 'Enter your company name').max(80),
    fullName: z.string().trim().min(2, 'Enter your full name').max(80),
    email: z.string().trim().toLowerCase().email('Enter a valid work email').optional(),
    password: z.string().min(10, pwRule).max(200).refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), pwRule).optional(),
    googleCode: z.string().regex(/^[0-9a-f]{48}$/, 'Your Google sign-up expired. Choose Continue with Google again.').optional(),
  }).strict()
    .refine((b) => (b.googleCode ? !b.email && !b.password : !!b.email && !!b.password), 'Enter your work email and a password, or continue with Google'),
})

export const ChangePasswordSchema = z.object({
  body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) }).strict(),
})

export const TourSchema = z.object({
  body: z.object({ status: z.enum(['done', 'reset']) }).strict(),
})

export const SsoExchangeSchema = z.object({
  body: z.object({ code: z.string().min(1) }).strict(),
})

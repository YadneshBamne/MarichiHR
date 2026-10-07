import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { Request, Response } from 'express'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { redis } from '../../infrastructure/cache/redis'
import { prisma } from '../../infrastructure/database/prisma'
import { authRepository } from './auth.repository'
import { completeLogin } from './auth.service'

// Google sign-in (OAuth 2.0 authorization code flow). Enabled only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
// Only existing, active users can sign in: the Google account is matched by its verified email within the tenant
// (and remembered by Google's `sub`). Nobody is auto-provisioned.
// The browser never sees tokens in a URL: the callback hands the SPA a one-time code (60 s, Redis) to exchange.

export const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
const stateKey = () => `${process.env.JWT_ACCESS_SECRET}.oauth`
const callbackUrl = () => process.env.GOOGLE_CALLBACK_URL || `http://localhost:${process.env.PORT || 4000}/api/v1/auth/google/callback`
const clientUrl = () => process.env.CLIENT_URL || 'http://localhost:5173'
const NONCE_COOKIE = 'g_oauth_nonce'

const cookie = (req: Request, name: string) =>
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1]

const fail = (res: Response, reason: string) => res.redirect(`${clientUrl()}/login?sso_error=${encodeURIComponent(reason)}`)

export const googleSso = {
  providers: (_req: Request, res: Response) => res.json({ success: true, data: { google: googleEnabled() } }),

  start: asyncHandler(async (req: Request, res: Response) => {
    if (!googleEnabled()) throw new AppError('Google sign-in is not configured', 501)
    const slug = String(req.query.tenant || '')
    const tenant = await authRepository.findTenantBySlug(slug)
    if (!tenant) throw new AppError('Organisation not found', 404)

    // The nonce ties the callback to this browser (login-CSRF protection)
    const nonce = crypto.randomBytes(16).toString('hex')
    const state = jwt.sign({ tenant: tenant.slug, nonce }, stateKey(), { expiresIn: '10m' })
    res.cookie(NONCE_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 600_000, path: '/api/v1/auth/google' })
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!, redirect_uri: callbackUrl(), response_type: 'code',
      scope: 'openid email profile', state, prompt: 'select_account',
    })
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  }),

  callback: async (req: Request, res: Response) => {
    try {
      if (!googleEnabled()) return fail(res, 'not_configured')
      let st: { tenant: string; nonce: string }
      try {
        st = jwt.verify(String(req.query.state || ''), stateKey()) as any
      } catch {
        return fail(res, 'expired')
      }
      const nonce = cookie(req, NONCE_COOKIE)
      res.clearCookie(NONCE_COOKIE, { path: '/api/v1/auth/google' })
      if (!nonce || nonce !== st.nonce) return fail(res, 'state_mismatch')
      if (!req.query.code) return fail(res, 'cancelled')

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code), client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: callbackUrl(), grant_type: 'authorization_code',
        }),
      })
      if (!tokenRes.ok) return fail(res, 'google_error')
      const { access_token } = (await tokenRes.json()) as { access_token: string }
      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${access_token}` } })
      if (!infoRes.ok) return fail(res, 'google_error')
      const info = (await infoRes.json()) as { sub: string; email?: string; email_verified?: boolean }
      if (!info.email || !info.email_verified) return fail(res, 'email_unverified')

      const tenant = await authRepository.findTenantBySlug(st.tenant)
      if (!tenant) return fail(res, 'no_account')
      const user = await prisma.user.findFirst({
        where: { tenantId: tenant.id, active: true, OR: [{ googleSub: info.sub }, { email: { equals: info.email, mode: 'insensitive' } }] },
      })
      if (!user || (user.googleSub && user.googleSub !== info.sub)) return fail(res, 'no_account')
      if (!user.googleSub) await prisma.user.update({ where: { id: user.id }, data: { googleSub: info.sub } })

      const code = crypto.randomBytes(24).toString('hex')
      await redis.set(`sso:${code}`, JSON.stringify({ userId: user.id, tenantId: tenant.id }), 'EX', 60)
      res.redirect(`${clientUrl()}/auth/sso?code=${code}`)
    } catch (err) {
      console.error('Google SSO callback failed:', err)
      fail(res, 'server_error')
    }
  },

  exchange: asyncHandler(async (req: Request, res: Response) => {
    const code = String(req.body?.code || '')
    const raw = /^[0-9a-f]{48}$/.test(code) ? await redis.getdel(`sso:${code}`) : null
    if (!raw) throw new AppError('Sign-in link expired. Try again.', 401)
    const { userId, tenantId } = JSON.parse(raw)
    const tenant = await prisma.tenant.findFirst({ where: { id: tenantId, active: true } })
    const u = await prisma.user.findFirst({ where: { id: userId, tenantId, active: true }, select: { email: true } })
    const user = tenant && u ? await authRepository.findUserByEmail(u.email, tenant.id) : null
    if (!tenant || !user) throw new AppError('Sign-in link expired. Try again.', 401)
    res.json({ success: true, data: await completeLogin(user, tenant) })
  }),
}

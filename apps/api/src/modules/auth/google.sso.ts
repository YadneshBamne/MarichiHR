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
// Sign-in (default): only existing, active users. The Google account is matched by its verified email (and then remembered
// by Google's `sub`) within the given organisation, or across all of them when none is given; nobody is auto-provisioned.
// Sign-up (intent=signup, only from the sign-up page): the verified profile is parked for 15 minutes and the SPA finishes
// the normal POST /auth/signup with it (company name still asked), so a workspace is never created from the login page.
// The browser never sees tokens in a URL: the callback hands the SPA a one-time code (60 s, Redis) to exchange.

export const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
const stateKey = () => `${process.env.JWT_ACCESS_SECRET}.oauth`
const callbackUrl = () => process.env.GOOGLE_CALLBACK_URL || `http://localhost:${process.env.PORT || 4000}/api/v1/auth/google/callback`
const clientUrl = () => process.env.CLIENT_URL || 'http://localhost:5173'
const NONCE_COOKIE = 'g_oauth_nonce'

const cookie = (req: Request, name: string) =>
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1]

const fail = (res: Response, reason: string, page = 'login') => res.redirect(`${clientUrl()}/${page}?sso_error=${encodeURIComponent(reason)}`)

type GoogleProfile = { sub: string; email: string; name: string; picture: string | null }
const signupKey = (code: string) => (/^[0-9a-f]{48}$/.test(code) ? `gsignup:${code}` : null)

// One-time: the sign-up consumes the parked Google profile
export async function takeGoogleSignup(code: string): Promise<GoogleProfile | null> {
  const key = signupKey(code)
  const raw = key ? await redis.getdel(key) : null
  return raw ? JSON.parse(raw) : null
}

export const googleSso = {
  providers: (_req: Request, res: Response) => res.json({ success: true, data: { google: googleEnabled() } }),

  start: asyncHandler(async (req: Request, res: Response) => {
    if (!googleEnabled()) throw new AppError('Google sign-in is not configured', 501)
    const intent = req.query.intent === 'signup' ? 'signup' : 'login'
    const slug = String(req.query.tenant || '').trim().toLowerCase()
    const tenant = slug ? await authRepository.findTenantBySlug(slug) : null
    if (slug && !tenant) throw new AppError('Organisation not found', 404)

    // The nonce ties the callback to this browser (login-CSRF protection)
    const nonce = crypto.randomBytes(16).toString('hex')
    const state = jwt.sign({ tenant: tenant?.slug ?? null, intent, nonce }, stateKey(), { expiresIn: '10m' })
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
      let st: { tenant: string | null; intent?: string; nonce: string }
      try {
        st = jwt.verify(String(req.query.state || ''), stateKey()) as any
      } catch {
        return fail(res, 'expired')
      }
      const back = (reason: string) => fail(res, reason, st.intent === 'signup' ? 'signup' : 'login')
      const nonce = cookie(req, NONCE_COOKIE)
      res.clearCookie(NONCE_COOKIE, { path: '/api/v1/auth/google' })
      if (!nonce || nonce !== st.nonce) return back('state_mismatch')
      if (!req.query.code) return back('cancelled')

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code), client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: callbackUrl(), grant_type: 'authorization_code',
        }),
      })
      if (!tokenRes.ok) return back('google_error')
      const { access_token } = (await tokenRes.json()) as { access_token: string }
      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${access_token}` } })
      if (!infoRes.ok) return back('google_error')
      const info = (await infoRes.json()) as { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }
      if (!info.email || !info.email_verified) return back('email_unverified')

      if (st.intent === 'signup') {
        const code = crypto.randomBytes(24).toString('hex')
        const profile: GoogleProfile = { sub: info.sub, email: info.email.toLowerCase(), name: (info.name || '').slice(0, 80), picture: info.picture?.startsWith('https://') ? info.picture.slice(0, 500) : null }
        await redis.set(`gsignup:${code}`, JSON.stringify(profile), 'EX', 900)
        return res.redirect(`${clientUrl()}/signup?google=${code}`)
      }

      const tenant = st.tenant ? await authRepository.findTenantBySlug(st.tenant) : null
      if (st.tenant && !tenant) return back('no_account')
      const matches = await prisma.user.findMany({
        where: {
          active: true, tenant: { active: true }, ...(tenant && { tenantId: tenant.id }),
          OR: [{ googleSub: info.sub }, { email: { equals: info.email, mode: 'insensitive' } }],
        },
        take: 2,
      })
      if (matches.length > 1) return back('org_required')
      const user = matches[0]
      if (!user || (user.googleSub && user.googleSub !== info.sub)) return back('no_account')
      if (!user.googleSub) await prisma.user.update({ where: { id: user.id }, data: { googleSub: info.sub } })

      const code = crypto.randomBytes(24).toString('hex')
      await redis.set(`sso:${code}`, JSON.stringify({ userId: user.id, tenantId: user.tenantId }), 'EX', 60)
      res.redirect(`${clientUrl()}/auth/sso?code=${code}`)
    } catch (err) {
      console.error('Google SSO callback failed:', err)
      fail(res, 'server_error')
    }
  },

  // Prefill for the sign-up form (read-only; the code is consumed by POST /auth/signup)
  signupProfile: asyncHandler(async (req: Request, res: Response) => {
    const key = signupKey(String(req.params.code))
    const raw = key ? await redis.get(key) : null
    if (!raw) throw new AppError('Your Google sign-up expired. Choose Continue with Google again.', 404)
    const p: GoogleProfile = JSON.parse(raw)
    res.json({ success: true, data: { email: p.email, fullName: p.name, avatarUrl: p.picture } })
  }),

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

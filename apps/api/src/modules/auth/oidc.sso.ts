import { Router, Request, Response } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { requireFeature } from '../../middleware/module.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { redis } from '../../infrastructure/cache/redis'
import { encryptField, decryptField } from '../../shared/utils/crypto'
import { assertPublicUrl } from '../automation/integrations.service'
import { Tenant, User, AuditLog } from '../../infrastructure/mongo/mongo'

// Single sign-on with the company's own identity provider (OpenID Connect: Microsoft Entra ID, Okta, Google Workspace, Keycloak, ...).
// Each company registers MarichiHR as an application in its provider, then enters the issuer, client id and secret in Settings > Single sign-on.
// Sign-in uses the authorization code flow with PKCE and a nonce, the ID token's signature is checked against the provider's keys, and the
// person is matched to an EXISTING active user by email: nobody is created by signing in. The browser never sees tokens in a URL: the
// callback hands the app a one-time code (60 s, Redis) that the app exchanges, the same hand-off the Google button uses.
// MongoDB mode only. ponytail: RS256/ES256/PS256 ID tokens, no SAML; SAML would need a library and per-company certificates.

const clientUrl = () => process.env.CLIENT_URL || 'http://localhost:5173'
const apiBase = (req: Request) => (process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
const redirectUri = (req: Request) => `${apiBase(req)}/api/v1/sso/callback`
const tenants = () => mongoose.connection.collection('tenants')
// Tests point at a throw-away provider on localhost; never allowed in production
const allowPrivate = () => process.env.SSO_ALLOW_PRIVATE === 'true' && process.env.NODE_ENV !== 'production'
const checkUrl = async (u: string) => { if (!allowPrivate()) await assertPublicUrl(u); return u }
const fail = (res: Response, reason: string) => res.redirect(`${clientUrl()}/login?sso_error=${encodeURIComponent(reason)}`)
const b64url = (b: Buffer) => b.toString('base64url')

type Cfg = { enabled: boolean; issuer: string; clientId: string; clientSecret?: string; allowedDomains: string[]; label: string; enforce: boolean }
const publicView = (c: Cfg | undefined, req: Request) => ({ enabled: !!c?.enabled, issuer: c?.issuer ?? '', clientId: c?.clientId ?? '', hasSecret: !!c?.clientSecret, allowedDomains: c?.allowedDomains ?? [], label: c?.label ?? 'Company single sign-on', enforce: !!c?.enforce, redirectUri: redirectUri(req) })

// Provider metadata and signing keys are cached for 10 minutes per issuer
const cache = new Map<string, { at: number; value: any }>()
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 600_000) return hit.value
  const value = await load()
  cache.set(key, { at: Date.now(), value })
  return value
}
async function getJson(url: string) {
  await checkUrl(url)
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new AppError(`The identity provider answered ${r.status}`, 502)
  return r.json() as Promise<any>
}
async function discover(issuer: string) {
  const base = issuer.replace(/\/$/, '')
  const d = await cached(`disc:${base}`, () => getJson(`${base}/.well-known/openid-configuration`))
  if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri || !d.issuer) throw new AppError('That address is not an OpenID Connect provider (the discovery document is incomplete)', 400)
  return d as { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; token_endpoint_auth_methods_supported?: string[] }
}
async function verifyIdToken(idToken: string, d: Awaited<ReturnType<typeof discover>>, clientId: string, nonce: string) {
  const header: any = jwt.decode(idToken, { complete: true })?.header
  if (!header?.kid) throw new AppError('unsigned', 401)
  // Keys are cached; one fresh fetch covers a provider that rotated its keys (even under the same key id)
  const attempt = async (fresh: boolean) => {
    if (fresh) cache.delete(`jwks:${d.jwks_uri}`)
    const jwks: any = await cached(`jwks:${d.jwks_uri}`, () => getJson(d.jwks_uri))
    const jwk = jwks.keys?.find((k: any) => k.kid === header.kid)
    if (!jwk) throw new AppError('unknown_key', 401)
    return jwt.verify(idToken, crypto.createPublicKey({ key: jwk, format: 'jwk' }), { algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256'], issuer: d.issuer, audience: clientId, clockTolerance: 30 }) as any
  }
  let claims: any
  try { claims = await attempt(false) } catch { claims = await attempt(true) }
  if (claims.nonce !== nonce) throw new AppError('nonce', 401)
  return claims
}

export const ssoRouter = Router()

// ─── Sign-in (public) ───
ssoRouter.get('/:slug/start', asyncHandler(async (req, res) => {
  const t: any = await Tenant.findOne({ slug: String(req.params.slug).toLowerCase(), active: true }).lean()
  const cfg: Cfg | undefined = (await tenants().findOne({ _id: t?._id } as any))?.sso
  if (!t || !cfg?.enabled) return fail(res, 'not_configured')
  try {
    const d = await discover(cfg.issuer)
    const state = crypto.randomBytes(24).toString('hex'), nonce = crypto.randomBytes(16).toString('hex'), verifier = b64url(crypto.randomBytes(32))
    await redis.set(`oidc:${state}`, JSON.stringify({ tenantId: t._id, nonce, verifier, redirectUri: redirectUri(req) }), 'EX', 600)
    const q = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri(req), scope: 'openid email profile', state, nonce, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' })
    res.redirect(`${d.authorization_endpoint}?${q}`)
  } catch (e: any) { console.error('SSO start failed:', e?.message); fail(res, 'provider_error') }
}))

ssoRouter.get('/callback', asyncHandler(async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>
  if (error) return fail(res, error === 'access_denied' ? 'cancelled' : 'provider_error')
  const raw = state && /^[0-9a-f]{48}$/.test(state) ? await redis.getdel(`oidc:${state}`) : null
  if (!raw || !code) return fail(res, 'expired')
  const st = JSON.parse(raw) as { tenantId: string; nonce: string; verifier: string; redirectUri: string }
  try {
    const cfg: Cfg | undefined = (await tenants().findOne({ _id: st.tenantId } as any))?.sso
    if (!cfg?.enabled) return fail(res, 'not_configured')
    const d = await discover(cfg.issuer)
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: st.redirectUri, code_verifier: st.verifier, client_id: cfg.clientId })
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
    const secret = cfg.clientSecret ? decryptField(cfg.clientSecret) : ''
    if (d.token_endpoint_auth_methods_supported && !d.token_endpoint_auth_methods_supported.includes('client_secret_post') && d.token_endpoint_auth_methods_supported.includes('client_secret_basic')) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`
    else if (secret) body.set('client_secret', secret)
    await checkUrl(d.token_endpoint)
    const tr = await fetch(d.token_endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10000) })
    const tok: any = await tr.json().catch(() => ({}))
    if (!tr.ok || !tok.id_token) return fail(res, 'provider_error')
    const claims = await verifyIdToken(tok.id_token, d, cfg.clientId, st.nonce)
    const email = String(claims.email || claims.preferred_username || claims.upn || '').trim().toLowerCase()
    if (!email.includes('@')) return fail(res, 'no_email')
    if (claims.email_verified === false) return fail(res, 'email_unverified')
    if (cfg.allowedDomains.length && !cfg.allowedDomains.includes(email.split('@')[1])) return fail(res, 'domain_not_allowed')
    const user: any = await User.findOne({ tenantId: st.tenantId, email, active: true }).collation({ locale: 'en', strength: 2 }).lean()
    if (!user) return fail(res, 'no_account') // nobody is created by signing in: HR adds the person first
    const one = crypto.randomBytes(24).toString('hex')
    await redis.set(`sso:${one}`, JSON.stringify({ userId: user._id, tenantId: st.tenantId, via: 'oidc' }), 'EX', 60)
    res.redirect(`${clientUrl()}/auth/sso?code=${one}`)
  } catch (e: any) { console.error('SSO callback failed:', e?.message); fail(res, e?.statusCode === 401 ? 'state_mismatch' : 'provider_error') }
}))

// ─── Settings (system admins) ───
const admin = [authenticate, requireRoles('system_admin'), requireFeature('sso')]
const Body = z.object({
  enabled: z.boolean(), issuer: z.string().url().max(300), clientId: z.string().trim().min(3).max(300), clientSecret: z.string().min(1).max(500).optional(),
  allowedDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(20).default([]), label: z.string().trim().min(2).max(40).default('Company single sign-on'), enforce: z.boolean().default(false),
}).strict()

ssoRouter.get('/config', ...admin, asyncHandler(async (req, res) => {
  const t: any = await tenants().findOne({ _id: req.user!.tenantId } as any)
  res.json({ success: true, data: publicView(t?.sso, req) })
}))

ssoRouter.put('/config', ...admin, validate(z.object({ body: Body })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const b = req.body as z.infer<typeof Body>
  const before: Cfg | undefined = (await tenants().findOne({ _id: tenantId } as any))?.sso
  if (b.enabled) {
    await checkUrl(b.issuer)
    await discover(b.issuer) // refuses an address that is not an OpenID Connect provider
    if (!b.clientSecret && !before?.clientSecret) throw new AppError('Enter the client secret from your identity provider', 400)
  }
  const next: Cfg = { enabled: b.enabled, issuer: b.issuer.replace(/\/$/, ''), clientId: b.clientId, allowedDomains: b.allowedDomains, label: b.label, enforce: b.enforce && b.enabled, clientSecret: b.clientSecret ? encryptField(b.clientSecret) : before?.clientSecret }
  await tenants().updateOne({ _id: tenantId } as any, { $set: { sso: next } })
  await AuditLog.create({ tenantId, userId, action: 'SSO_CONFIGURED', entityType: 'tenant', entityId: tenantId, newValue: { enabled: next.enabled, issuer: next.issuer, enforce: next.enforce, allowedDomains: next.allowedDomains, secretChanged: !!b.clientSecret } })
  res.json({ success: true, data: publicView(next, req) })
}))

// Checks the provider answers and has what sign-in needs, without signing anyone in
ssoRouter.post('/config/test', ...admin, validate(z.object({ body: z.object({ issuer: z.string().url().max(300) }).strict() })), asyncHandler(async (req, res) => {
  await checkUrl(req.body.issuer)
  cache.delete(`disc:${String(req.body.issuer).replace(/\/$/, '')}`)
  const d = await discover(req.body.issuer)
  res.json({ success: true, data: { ok: true, issuer: d.issuer, authorizationEndpoint: d.authorization_endpoint, tokenEndpoint: d.token_endpoint } })
}))

// Used by the login page and the password login: does this company have SSO, and is it required?
export async function ssoPublic(tenantId: string) {
  const c: Cfg | undefined = (await tenants().findOne({ _id: tenantId } as any))?.sso
  return c?.enabled ? { enabled: true, label: c.label, enforce: !!c.enforce } : { enabled: false, label: '', enforce: false }
}

// Sign up with Google (verified profile parked by the OAuth callback, then POST /auth/signup with googleCode) and
// long-lived sessions (30-day sliding refresh tokens, rotation with a 60 s grace, logout revokes). The Google round trip itself can't run
// here, so the test parks a profile in Redis exactly as the callback does. Creates one test company and deactivates it.
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `g${Date.now() % 1e7}`
const BASE = (process.env.API_URL || 'http://localhost:4000') + '/api/v1'
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
const DAY = 86_400_000

;(async () => {
  const keys = await redis.keys('signup:*')
  if (keys.length) await redis.del(...keys)
  let tenantId

  // ─── GOOGLE START ──────────────────────────────────────────
  let r = await api(null, 'GET', '/auth/providers')
  const google = r.body?.google
  check('providers endpoint answers', r.status === 200 && typeof google === 'boolean', r.data)
  if (google) {
    let res = await fetch(`${BASE}/auth/google?intent=signup`, { redirect: 'manual' })
    let state = jwt.decode(new URL(res.headers.get('location') || 'http://x').searchParams.get('state') || '')
    check('sign-up start goes to Google with intent=signup and no organisation', res.status === 302 && state?.intent === 'signup' && state.tenant === null, res.status)
    res = await fetch(`${BASE}/auth/google`, { redirect: 'manual' })
    state = jwt.decode(new URL(res.headers.get('location') || 'http://x').searchParams.get('state') || '')
    check('sign-in start no longer needs an organisation (intent=login)', res.status === 302 && state?.intent === 'login' && state.tenant === null, res.status)
    res = await fetch(`${BASE}/auth/google?tenant=no-such-org-${TAG}`, { redirect: 'manual' })
    check('unknown organisation is refused', res.status === 404, res.status)
  }

  // ─── GOOGLE BUTTON (ID TOKEN) ──────────────────────────────
  r = await api(null, 'GET', '/auth/providers')
  check('providers gives the public client id for the Google button when enabled', !google || (typeof r.body.googleClientId === 'string' && r.body.googleClientId.endsWith('.apps.googleusercontent.com')), r.data)
  if (google) {
    r = await api(null, 'POST', '/auth/google/id-token', { credential: 'x'.repeat(40) + '.forged.token', intent: 'login' })
    check('a forged Google ID token is refused (401)', r.status === 401, r.data)
    const fake = jwt.sign({ aud: 'someone-else', iss: 'https://accounts.google.com', email: 'a@b.c', email_verified: true, sub: '1' }, 'not-google')
    r = await api(null, 'POST', '/auth/google/id-token', { credential: fake, intent: 'signup' })
    check('a self-signed ID token cannot start a sign-up (401)', r.status === 401, r.data)
  }
  r = await api(null, 'POST', '/auth/google/id-token', { credential: 'x'.repeat(40), intent: 'admin' })
  check('ID-token body is validated (intent login|signup only)', r.status === 400, r.data)

  // ─── SIGN-UP BODY RULES ────────────────────────────────────
  const code = crypto.randomBytes(24).toString('hex')
  const email = `g.owner.${TAG}@example.com`
  r = await api(null, 'POST', '/auth/signup', { companyName: `Gee ${TAG}`, fullName: 'Gia Owner', googleCode: code, password: 'Start12345x' })
  check('googleCode cannot be mixed with a password', r.status === 400, r.data)
  r = await api(null, 'POST', '/auth/signup', { companyName: `Gee ${TAG}`, fullName: 'Gia Owner' })
  check('sign-up needs email + password or googleCode', r.status === 400, r.data)
  r = await api(null, 'POST', '/auth/signup', { companyName: `Gee ${TAG}`, fullName: 'Gia Owner', googleCode: code })
  check('an unknown/expired Google code is refused', r.status === 400 && /expired/i.test(r.data.message), r.data)
  r = await api(null, 'GET', `/auth/google/signup/${code}`)
  check('prefill for an unknown code is 404', r.status === 404, r.data)
  r = await api(null, 'GET', '/auth/google/signup/not-hex')
  check('prefill rejects malformed codes', r.status === 404, r.data)

  // ─── SIGN-UP WITH A PARKED GOOGLE PROFILE ──────────────────
  const sub = `test-sub-${TAG}`
  await redis.set(`gsignup:${code}`, JSON.stringify({ sub, email, name: 'Gia Owner', picture: 'https://lh3.googleusercontent.com/a/test' }), 'EX', 900)
  r = await api(null, 'GET', `/auth/google/signup/${code}`)
  check('prefill returns the Google name, email and photo', r.status === 200 && r.body.email === email && r.body.fullName === 'Gia Owner' && r.body.avatarUrl?.startsWith('https://'), r.data)
  check('failed sign-up attempts do not use up the sign-up limit', (await redis.keys('signup:*')).length === 0)
  r = await api(null, 'POST', '/auth/signup', { companyName: `Gee ${TAG}`, fullName: 'Gia Owner', googleCode: code })
  const sign = r.body
  check('Google sign-up creates the company and signs the owner in', r.status === 201 && sign.accessToken && sign.refreshToken && sign.user.email === email, r.data)
  tenantId = sign?.user?.tenant?.id
  check('the owner gets admin roles and lands on onboarding (not onboarded yet)', sign?.user?.roles?.some((x) => x.name === 'hr_admin') && !sign.user.tenant.onboardedAt, sign?.user)
  const u = tenantId && await prisma.user.findFirst({ where: { tenantId, email } })
  check('owner has no password, is linked to the Google account and has the Google photo', u && u.passwordHash === null && u.googleSub === sub && u.avatarUrl === 'https://lh3.googleusercontent.com/a/test', u && { pw: u.passwordHash, sub: u.googleSub })
  r = await api(null, 'POST', '/auth/signup', { companyName: `Gee again ${TAG}`, fullName: 'Gia Owner', googleCode: code })
  check('the Google code works once', r.status === 400, r.data)

  // ─── SIGN-UP LIMITS COUNT CREATED WORKSPACES ──────────────
  const ipKeys = await redis.keys('signup:ip:*')
  check('a created workspace counts once against this visitor', ipKeys.length === 1 && (await redis.get(ipKeys[0])) === '1', ipKeys)
  await redis.set(ipKeys[0], '10', 'EX', 60)
  r = await api(null, 'POST', '/auth/signup', { companyName: `Capped ${TAG}`, fullName: 'Cap Owner', email: `cap.${TAG}@example.com`, password: 'Start12345x' })
  check('the 11th workspace from one visitor within an hour is refused (429)', r.status === 429, r.data)
  await redis.del(ipKeys[0])
  await redis.set(`signup:email:cap.${TAG}@example.com`, '3', 'EX', 60)
  r = await api(null, 'POST', '/auth/signup', { companyName: `Capped ${TAG}`, fullName: 'Cap Owner', email: `cap.${TAG}@example.com`, password: 'Start12345x' })
  check('a 4th workspace for one email within an hour is refused (429)', r.status === 429 && /email/.test(r.data.message), r.data)
  await redis.del(`signup:email:cap.${TAG}@example.com`)
  r = await api(null, 'POST', '/auth/login', { email, password: 'Anything123x' })
  check('a Google-only owner cannot sign in with a password', r.status === 401, r.data)

  // ─── SESSIONS: 30-day sliding refresh, rotation, logout ────
  const t0 = await prisma.refreshToken.findUnique({ where: { token: sign.refreshToken } })
  check('refresh token lasts 30 days', t0 && Math.abs(new Date(t0.expiresAt) - Date.now() - 30 * DAY) < DAY, t0?.expiresAt)
  r = await api(null, 'POST', '/auth/refresh', { refreshToken: sign.refreshToken })
  const next = r.body
  check('refresh issues a new access + refresh token', r.status === 200 && next.accessToken && next.refreshToken && next.refreshToken !== sign.refreshToken, r.data)
  const t1 = next && await prisma.refreshToken.findUnique({ where: { token: next.refreshToken } })
  check('each refresh extends the session another 30 days', t1 && Math.abs(new Date(t1.expiresAt) - Date.now() - 30 * DAY) < DAY, t1?.expiresAt)
  const old = await prisma.refreshToken.findUnique({ where: { token: sign.refreshToken } })
  check('the rotated token is cut to a 60-second grace', old && new Date(old.expiresAt) - Date.now() <= 60_000, old?.expiresAt)
  r = await api(null, 'POST', '/auth/refresh', { refreshToken: sign.refreshToken })
  check('within the grace the rotated token still works (a page reloaded mid-refresh stays signed in)', r.status === 200 && r.body.refreshToken, r.data)
  await prisma.refreshToken.update({ where: { token: sign.refreshToken }, data: { expiresAt: new Date(Date.now() - 1000) } })
  r = await api(null, 'POST', '/auth/refresh', { refreshToken: sign.refreshToken })
  check('after the grace the rotated token is refused', r.status === 401, r.data)
  r = await api(next.accessToken, 'GET', '/auth/me')
  check('the new access token works', r.status === 200 && r.body.email === email, r.data)
  r = await api(null, 'POST', '/auth/logout', { refreshToken: next.refreshToken })
  check('logout succeeds', r.status === 200, r.data)
  r = await api(null, 'POST', '/auth/refresh', { refreshToken: next.refreshToken })
  check('after logout the refresh token is revoked', r.status === 401, r.data)

  if (tenantId) await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await redis.quit()
  await done()
})().catch(async (e) => { console.error(e); await redis.quit(); await prisma.$disconnect(); process.exit(1) })

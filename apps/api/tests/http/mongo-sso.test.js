// Single sign-on with a company identity provider (OpenID Connect) on the MongoDB API. A throw-away identity provider runs inside this
// test (discovery, authorize, token with PKCE and a client secret, signing keys), so nothing leaves the machine.
// Start the API for this test with SSO_ALLOW_PRIVATE=true (the provider is on localhost; refused in production):
//   API=http://localhost:4235 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-sso.test.js
const http = require('http')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const mongoose = require('mongoose')
const ORIGIN = process.env.API || 'http://localhost:4200'
const API = ORIGIN + '/api/v1'
const IDP_PORT = Number(process.env.IDP_PORT || 4999)
const IDP = `http://localhost:${IDP_PORT}`
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data, text }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}

// ── the throw-away identity provider
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const CLIENT_ID = 'marichihr-test', SECRET = 's3cret-value'
const idp = { email: 'nobody@example.com', badSig: false, audience: CLIENT_ID, codes: new Map() }
const idpServer = http.createServer((req, res) => {
  const u = new URL(req.url, IDP)
  const json = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/.well-known/openid-configuration') return json({ issuer: IDP, authorization_endpoint: `${IDP}/authorize`, token_endpoint: `${IDP}/token`, jwks_uri: `${IDP}/jwks`, token_endpoint_auth_methods_supported: ['client_secret_post'] })
  if (u.pathname === '/jwks') return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] })
  if (u.pathname === '/authorize') {
    const p = u.searchParams, code = crypto.randomBytes(8).toString('hex')
    if (p.get('client_id') !== CLIENT_ID || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !p.get('nonce')) return json({ error: 'bad request' }, 400)
    idp.codes.set(code, { nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirect: p.get('redirect_uri'), email: idp.email, badSig: idp.badSig, audience: idp.audience })
    res.writeHead(302, { Location: `${p.get('redirect_uri')}?code=${code}&state=${p.get('state')}` }); return res.end()
  }
  if (u.pathname === '/token' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const f = new URLSearchParams(body), c = idp.codes.get(f.get('code'))
      if (!c || f.get('client_secret') !== SECRET || f.get('client_id') !== CLIENT_ID || f.get('redirect_uri') !== c.redirect) return json({ error: 'invalid_grant' }, 400)
      if (crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') !== c.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE' }, 400)
      idp.codes.delete(f.get('code'))
      const id_token = jwt.sign({ email: c.email, email_verified: true, nonce: c.nonce, sub: 'u-' + c.email }, c.badSig ? other.privateKey : privateKey, { algorithm: 'RS256', keyid: 'k1', issuer: IDP, audience: c.audience, expiresIn: 300 })
      json({ access_token: 'x', token_type: 'Bearer', id_token })
    })
    return
  }
  json({ error: 'not found' }, 404)
})

// Follows a sign-in by hand: start -> provider -> callback, and returns where the callback finally sent the browser
async function signInThrough(slug) {
  const a = await fetch(`${API}/sso/${slug}/start`, { redirect: 'manual' })
  const loc1 = a.headers.get('location')
  if (!loc1 || !loc1.startsWith(IDP)) return { location: loc1 }
  const b = await fetch(loc1, { redirect: 'manual' })
  const loc2 = b.headers.get('location')
  const c = await fetch(loc2, { redirect: 'manual' })
  return { location: c.headers.get('location'), callback: loc2 }
}
const errOf = (loc) => new URL(loc).searchParams.get('sso_error')

;(async () => {
  await new Promise((r) => idpServer.listen(IDP_PORT, r))
  const stamp = Date.now(), email = `so${stamp}@example.com`
  let tenantId, slug
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Sso Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id; slug = su.data.workspace
    const owner = su.data.accessToken
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const maryEmail = `mary${stamp}@example.com`
    const body = { enabled: true, issuer: IDP, clientId: CLIENT_ID, clientSecret: SECRET, allowedDomains: [], label: 'Sign in with Acme', enforce: false }

    // ── settings
    check((await call('GET', '/sso/config', owner)).status === 403, 'on the Growth plan single sign-on is not included')
    await call('PUT', '/company/plan', owner, { plan: 'enterprise', addons: [] })
    check((await call('GET', '/sso/config', mary)).status === 403, 'an employee cannot see the settings')
    check((await call('PUT', '/sso/config', mary, body)).status === 403, 'or change them')
    const cfg0 = await call('GET', '/sso/config', owner)
    check(cfg0.status === 200 && cfg0.data.enabled === false && /\/api\/v1\/sso\/callback$/.test(cfg0.data.redirectUri), `the admin gets the redirect address to register (${cfg0.data?.redirectUri})`)
    check((await call('PUT', '/sso/config', owner, { ...body, issuer: `${IDP}/missing` })).status >= 400, 'an address that is not an OpenID Connect provider is refused')
    check((await call('PUT', '/sso/config', owner, { ...body, clientSecret: undefined })).status === 400, 'a secret is required the first time')
    check((await call('POST', '/sso/config/test', owner, { issuer: IDP })).data?.ok === true, 'the connection test reads the provider')
    const put = await call('PUT', '/sso/config', owner, body)
    check(put.status === 200 && put.data.enabled && put.data.hasSecret && !put.text.includes(SECRET), 'saved; the secret is never returned')
    const stored = (await db.collection('tenants').findOne({ _id: tenantId })).sso
    check(stored.clientSecret && !String(stored.clientSecret).includes(SECRET), 'the secret is stored encrypted')
    const ws = await call('GET', `/auth/workspace/${slug}`)
    check(ws.data?.sso?.enabled === true && ws.data.sso.label === 'Sign in with Acme', `the login page learns the company has single sign-on (${JSON.stringify(ws.data?.sso)})`)

    // ── a normal sign-in
    idp.email = maryEmail
    const ok = await signInThrough(slug)
    check(ok.location?.startsWith('http') && new URL(ok.location).pathname === '/auth/sso', `the callback sends the browser back with a one-time code (${ok.location})`)
    const code = new URL(ok.location).searchParams.get('code')
    const ex = await call('POST', '/auth/google/exchange', null, { code })
    check(ex.status === 200 && ex.data.accessToken && ex.data.user.email === maryEmail, `the code signs Mary in (${ex.status})`)
    check((await call('POST', '/auth/google/exchange', null, { code })).status === 401, 'the code works once')
    check((await fetch(ok.callback, { redirect: 'manual' }).then((r) => errOf(r.headers.get('location')))) === 'expired', 'replaying the callback is refused')
    const audit = await db.collection('audit_logs').findOne({ tenantId, action: 'SIGNED_IN', userId: ex.data.user.id, 'newValue.method': 'sso' })
    check(!!audit, 'the audit log records the method as sso')

    // ── refusals
    idp.email = 'nobody@example.com'
    check(errOf((await signInThrough(slug)).location) === 'no_account', 'a person HR has not added gets no account (nobody is created by signing in)')
    idp.email = maryEmail; idp.badSig = true
    check(!!errOf((await signInThrough(slug)).location), 'an ID token signed with the wrong key is refused')
    idp.badSig = false; idp.audience = 'someone-else'
    check(!!errOf((await signInThrough(slug)).location), 'an ID token for another application is refused')
    idp.audience = CLIENT_ID
    await call('PUT', '/sso/config', owner, { ...body, clientSecret: undefined, allowedDomains: ['other.com'] })
    check(errOf((await signInThrough(slug)).location) === 'domain_not_allowed', 'an email domain outside the allowed list is refused')
    await call('PUT', '/sso/config', owner, { ...body, clientSecret: undefined })
    check((await fetch(`${API}/sso/${slug}/start`, { redirect: 'manual' }).then((r) => r.headers.get('location'))).startsWith(IDP), 'saving without a new secret keeps the old one')
    check(errOf((await fetch(`${API}/sso/callback?code=abc&state=${'0'.repeat(48)}`, { redirect: 'manual' })).headers.get('location')) === 'expired', 'an unknown state is refused')
    check(errOf((await fetch(`${API}/sso/no-such-company/start`, { redirect: 'manual' })).headers.get('location')) === 'not_configured', 'an unknown company is refused')

    // ── enforce: staff must use it, admins keep their password
    await call('PUT', '/sso/config', owner, { ...body, clientSecret: undefined, enforce: true })
    const pw = await call('POST', '/auth/login', null, { email: maryEmail, password: 'Fresh-pass-77x' })
    check(pw.status === 403 && pw.body.code === 'SSO_REQUIRED', `with single sign-on required, Mary's password no longer works (${pw.status})`)
    check((await call('POST', '/auth/login', null, { email, password: 'Correct-horse-1' })).status === 200, 'but an admin can still sign in with a password')
    const again = await signInThrough(slug)
    check(new URL(again.location).pathname === '/auth/sso', 'and Mary can still sign in through the provider')

    // ── switch it off
    await call('PUT', '/sso/config', owner, { ...body, enabled: false })
    check(errOf((await signInThrough(slug)).location) === 'not_configured', 'switched off, the provider route is closed')
    check((await call('POST', '/auth/login', null, { email: maryEmail, password: 'Fresh-pass-77x' })).status === 200, 'and passwords work for everyone again')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    idpServer.close()
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

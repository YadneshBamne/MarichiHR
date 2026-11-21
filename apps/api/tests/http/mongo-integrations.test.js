// API keys, the integration API, webhooks and automation rules on the MongoDB API. HTTP part: key lifecycle and scopes, company isolation,
// webhook URL safety, and that recorded events reach webhooks and rules through the event pump. In-process part: the signature a receiver
// would verify, with the request sender replaced so nothing leaves the machine. Removes its companies at the end.
// No real request is sent: the webhook points at 192.0.2.10 (a documentation address nobody answers on).
//   API=http://localhost:4210 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-integrations.test.js
const crypto = require('crypto')
const mongoose = require('mongoose')
const API = (process.env.API || 'http://localhost:4200') + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body, raw = false) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const iso = (d) => d.toISOString().slice(0, 10)
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 40000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(1500) } }
const HOOK = 'https://192.0.2.10/hooks/marichihr'

;(async () => {
  const stamp = Date.now()
  const tenants = []
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const mkCompany = async (label) => {
      const su = await call('POST', '/auth/signup', null, { companyName: `${label} Int ${stamp}`, fullName: `${label} Owner`, email: `${label.toLowerCase()}int${stamp}@example.com`, password: 'Correct-horse-1' })
      tenants.push(su.data.user.tenant.id)
      return { owner: su.data.accessToken, tenantId: su.data.user.tenant.id, unit: (await call('GET', '/employees/org-units/tree', su.data.accessToken)).data[0].id }
    }
    const A = await mkCompany('Alpha'), B = await mkCompany('Beta')
    const mkEmp = async (c, n, w) => (await call('POST', '/employees', c.owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: c.unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mkEmp(A, 'Mary', 'Banda')
    const mary = await login(A.owner, maryId, `mary${stamp}@example.com`, ['employee'])

    // ── plan gate
    check((await call('GET', '/automation/api-keys', A.owner)).status === 403, 'API keys are not in the Growth plan: 403')
    check((await call('PUT', '/company/plan', A.owner, { plan: 'growth', addons: ['api'] })).status === 200, 'API bought as an add-on (Alpha)')
    await call('PUT', '/company/plan', B.owner, { plan: 'growth', addons: ['api'] })

    // ── keys
    check((await call('GET', '/automation/api-keys', mary)).status === 403, 'an employee cannot list keys')
    check((await call('POST', '/automation/api-keys', mary, { name: 'x1', scopes: ['employees:read'] })).status === 403, 'an employee cannot create a key')
    check((await call('POST', '/automation/api-keys', A.owner, { name: 'Bad', scopes: ['payroll:read'] })).status === 400, 'an unknown scope is refused')
    check((await call('POST', '/automation/api-keys', A.owner, { name: 'Old', scopes: ['employees:read'], expiresAt: '2020-01-01' })).status === 400, 'an expiry in the past is refused')
    const rk = await call('POST', '/automation/api-keys', A.owner, { name: 'BI tool', scopes: ['employees:read', 'org:read'] })
    check(rk.status === 201 && /^mhr_[0-9a-f]{48}$/.test(rk.data.key) && !rk.data.keyHash, `a read key is created and shown once (${short(rk).slice(0, 90)})`)
    const readKey = rk.data.key
    const listed = await call('GET', '/automation/api-keys', A.owner)
    check(listed.data.length === 1 && !JSON.stringify(listed.data).includes(readKey) && listed.data[0].prefix === readKey.slice(0, 12), 'the list never shows the key or its hash')
    const wk = await call('POST', '/automation/api-keys', A.owner, { name: 'HR feed', scopes: ['employees:read', 'employees:write'] })

    // ── integration API
    check((await call('GET', '/integration/employees')).status === 401, 'no key: 401')
    check((await call('GET', '/integration/employees', 'mhr_' + '0'.repeat(48))).status === 401, 'a wrong key: 401')
    const emps = await call('GET', '/integration/employees', readKey)
    check(emps.status === 200 && (emps.body.data ?? []).length >= 2, `the key lists the company's people (${short(emps).slice(0, 120)})`)
    check((await call('GET', '/integration/org-units', readKey)).status === 200, 'org units with the org:read scope')
    check((await call('GET', '/integration/leave?from=2026-01-01&to=2026-12-31', readKey)).status === 403, 'leave needs its own scope: 403')
    check((await call('POST', '/integration/employees', readKey, { firstName: 'X', lastName: 'Y', workEmail: `x${stamp}@e.com`, hireDate: '2026-01-01', employmentType: 'full_time' })).status === 403, 'a read-only key cannot write: 403')
    const names = JSON.stringify(emps.body.data)
    check(!names.includes('Beta Owner'), "Alpha's key does not see Beta's people")
    const bk = await call('POST', '/automation/api-keys', B.owner, { name: 'Beta key', scopes: ['employees:read'] })
    const betaEmps = JSON.stringify((await call('GET', '/integration/employees', bk.data.key)).body.data)
    check(betaEmps.includes('Beta') && !betaEmps.includes('Mary'), "Beta's key sees only Beta")
    const made = await call('POST', '/integration/employees', wk.data.key, { firstName: 'Joe', lastName: 'Lungu', workEmail: `joe${stamp}@example.com`, hireDate: iso(new Date()), employmentType: 'full_time' })
    check(made.status === 201 && made.body.data.employeeId, `a write key creates an employee (${short(made).slice(0, 140)})`)
    check((await call('PATCH', `/integration/employees/${made.body.data?.employeeId}`, wk.data.key, { mobileWork: '0977000111' })).status === 200, 'and edits it')
    check((await call('POST', `/automation/api-keys/${rk.data.id}/revoke`, A.owner)).status === 200, 'revoking a key')
    check((await call('GET', '/integration/employees', readKey)).status === 401, 'a revoked key stops working at once')
    check((await call('POST', `/automation/api-keys/${rk.data.id}/revoke`, A.owner)).status === 404, 'revoking twice: 404')
    check((await call('POST', `/automation/api-keys/${bk.data.id}/revoke`, A.owner)).status === 404, "Alpha cannot revoke Beta's key")

    // ── webhooks: URL safety, secret shown once
    const WH = { name: 'ERP', url: HOOK, events: ['employee.created'] }
    check((await call('POST', '/automation/webhooks', mary, WH)).status === 403, 'an employee cannot create a webhook')
    check((await call('POST', '/automation/webhooks', A.owner, { ...WH, url: 'http://192.0.2.10/h' })).status === 400, 'http is refused')
    check((await call('POST', '/automation/webhooks', A.owner, { ...WH, url: 'https://127.0.0.1/h' })).status === 400, 'loopback is refused')
    check((await call('POST', '/automation/webhooks', A.owner, { ...WH, url: 'https://10.0.0.5/h' })).status === 400, 'a private address is refused')
    check((await call('POST', '/automation/webhooks', A.owner, { ...WH, url: 'https://user:pw@192.0.2.10/h' })).status === 400, 'credentials in the URL are refused')
    check((await call('POST', '/automation/webhooks', A.owner, { ...WH, events: ['nope.event'] })).status === 400, 'an unknown event is refused')
    const hook = await call('POST', '/automation/webhooks', A.owner, WH)
    check(hook.status === 201 && /^whsec_/.test(hook.data.signingSecret) && !hook.data.secret, `a webhook is created, the signing secret is shown once (${short(hook).slice(0, 90)})`)
    const hl = await call('GET', '/automation/webhooks', A.owner)
    check(hl.data.length === 1 && !JSON.stringify(hl.data).includes('whsec_') && !hl.data[0].secret, 'the list hides the secret')
    check((await call('GET', '/automation/webhooks', B.owner)).data.length === 0, "Beta does not see Alpha's webhooks")
    check((await call('GET', `/automation/webhooks/${hook.data.id}/deliveries`, B.owner)).status === 404, "Beta cannot read Alpha's deliveries")

    // ── an automation rule: notify HR when someone joins
    check((await call('POST', '/automation/rules', mary, { name: 'xx', trigger: 'employee.created', actions: [{ type: 'notify', to: ['hr_admin'], title: 'Welcome' }] })).status === 403, 'an employee cannot create a rule')
    const rule = await call('POST', '/automation/rules', A.owner, { name: 'Tell HR about joiners', trigger: 'employee.created', conditions: [], actions: [{ type: 'notify', to: ['hr_admin'], title: 'New joiner: {{employee.name}}', body: 'Please prepare their first day' }] })
    check(rule.status === 201, `HR creates a rule (${short(rule)})`)
    check((await call('POST', '/automation/rules', A.owner, { name: 'Bad', trigger: 'no.such', actions: [{ type: 'notify', to: ['hr_admin'], title: 'x1' }] })).status === 400, 'an unknown trigger is refused')
    check((await call('POST', '/automation/rules/test', A.owner, { name: 'Dry', trigger: 'employee.created', conditions: [], actions: [{ type: 'notify', to: ['hr_admin'], title: 'Hello' }] })).status === 200, 'a dry run works')

    // ── events reach rules and webhooks (the pump runs every few seconds)
    const sam = await mkEmp(A, 'Sam', 'Kapaya')
    const run = await until(async () => db.collection('automation_runs').findOne({ tenantId: A.tenantId, ruleId: rule.data.id }))
    check(run && run.status === 'done', `the rule ran for the new employee (${run?.status} ${run?.detail})`)
    const note = await until(async () => db.collection('notifications').findOne({ tenantId: A.tenantId, title: /New joiner: Sam Kapaya/ }), 30000)
    check(!!note, 'HR got the notification with the name filled in')
    const del = await until(async () => db.collection('webhook_deliveries').findOne({ tenantId: A.tenantId, webhookId: hook.data.id, eventType: 'employee.created', status: { $ne: 'pending' } }), 60000)
    check(!!del && del.attempts >= 1, `the event was delivered to the webhook, one delivery row (${del?.status}, attempts ${del?.attempts})`)
    check(!!del && ['failed', 'delivered', 'dead'].includes(del.status) && (del.status !== 'failed' || del.nextAttemptAt), 'a failed attempt is scheduled for retry')
    const ev = await until(async () => { const e = await db.collection('domain_events').findOne({ _id: del?.eventId }); return e?.status === 'delivered' ? e : null }, 20000)
    check(ev && ev.status === 'delivered', 'the event itself is marked delivered')
    check((await db.collection('webhook_deliveries').countDocuments({ tenantId: B.tenantId })) === 0, "nothing was delivered for Beta's hooks (it has none)")
    const rd = await call('GET', `/automation/webhooks/${hook.data.id}/deliveries`, A.owner)
    check(rd.status === 200 && rd.data.length >= 1, 'deliveries are listed for the webhook')

    // ── the signature a receiver verifies
    require('../../dist/mongo-mode')
    const svc = require('../../dist/modules/automation/integrations.service')
    const crypt = require('../../dist/shared/utils/crypto')
    const seen = []
    svc.setWebhookFetch(async (url, init) => { seen.push({ url, init }); return { status: 200 } })
    const evId = crypto.randomUUID()
    await db.collection('domain_events').insertOne({ _id: evId, tenantId: A.tenantId, eventType: 'employee.created', type: 'employee.created', payload: { employeeId: sam, name: 'Sam' }, status: 'delivered', createdAt: new Date(), updatedAt: new Date() })
    await svc.queueWebhooks({ id: evId, tenantId: A.tenantId, eventType: 'employee.created' })
    svc.setWebhookFetch(null)
    check(seen.length === 1 && seen[0].url === HOOK, 'the stubbed sender got one request to the webhook URL')
    const hdr = seen[0]?.init.headers ?? {}
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hdr['x-marichihr-signature'] ?? '')
    const rawHook = await db.collection('webhooks').findOne({ _id: hook.data.id })
    const secret = crypt.decryptField(rawHook.secret)
    check(!!m && m[2] === crypto.createHmac('sha256', secret).update(`${m[1]}.${seen[0].init.body}`).digest('hex'), 'the signature matches HMAC-SHA256(secret, timestamp.body)')
    check(secret === hook.data.signingSecret, 'the stored secret is the one shown at creation')
    check(hdr['x-marichihr-event'] === 'employee.created' && JSON.parse(seen[0].init.body).type === 'employee.created', 'event header and body type')
    const dd = await db.collection('webhook_deliveries').findOne({ tenantId: A.tenantId, eventId: evId })
    check(dd && dd.status === 'delivered' && dd.responseCode === 200, 'a 2xx answer marks the delivery delivered')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    for (const tenantId of tenants) {
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

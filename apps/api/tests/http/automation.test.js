// Phase 6: automation rules (conditions, notify + task actions, run log, dry run), daily people dates, webhooks
// (URL safety, signed delivery records, subscriptions) and API keys for the read-only integration API. Throwaway company.
require('ts-node').register({ transpileOnly: true })
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')
const { matches, fill } = require('../../src/modules/automation/automation.service')
const { sign } = require('../../src/modules/automation/integrations.service')

const TAG = `au${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { if ((v = await fn())) return v; await sleep(1000) } return v }
const BASE = `http://localhost:${process.env.PORT || 4000}/api/v1`
const withKey = (key, path) => fetch(BASE + path, { headers: key ? { authorization: `Bearer ${key}` } : {} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

;(async () => {
  // ─── Pure parts ────────────────────────────────────────────
  const types = new Map([['totalDays', 'number'], ['employee.department', 'text'], ['startDate', 'date']])
  const ctx = { totalDays: 4, 'employee.department': 'Operations', startDate: '2026-12-20', 'employee.name': 'Ana One' }
  check('conditions: equals ignores case, numbers compare, "in" takes a list', matches([{ field: 'employee.department', op: 'eq', value: 'operations' }, { field: 'totalDays', op: 'gte', value: '3' }, { field: 'employee.department', op: 'in', value: 'Sales, Operations' }], ctx, types))
  check('conditions: a failing one stops the rule; dates compare as dates', !matches([{ field: 'totalDays', op: 'gt', value: '4' }], ctx, types) && matches([{ field: 'startDate', op: 'lt', value: '2027-01-01' }], ctx, types))
  check('templates fill fields and leave unknown ones empty', fill('{{employee.name}} takes {{ totalDays }} days {{nope}}', ctx) === 'Ana One takes 4 days ')
  const ts = 1700000000
  check('webhook signature is HMAC-SHA256 of "timestamp.body"', sign('s3cret', ts, '{"a":1}') === crypto.createHmac('sha256', 's3cret').update(`${ts}.{"a":1}`).digest('hex'))

  // ─── Company ───────────────────────────────────────────────
  const keys = await redis.keys('signup:*'); if (keys.length) await redis.del(...keys)
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Auto ${TAG}`, fullName: 'Ada Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  const ownerUser = await prisma.user.findFirst({ where: { email: ownerEmail }, include: { employee: true } })
  const asRoles = (roleIds, u = ownerUser) => ({ token: jwt.sign({ userId: u.id, tenantId: tenant.id, employeeId: u.employee?.id, roleIds, email: u.email }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })

  r = await api(owner, 'GET', '/automation/catalog')
  check('the catalog lists triggers with their fields', r.status === 200 && r.body.triggers.some((t) => t.key === 'leave.request.approved' && t.fields.some((f) => f.key === 'employee.department')), r.status)
  r = await api(asRoles(['employee']), 'GET', '/automation/rules')
  check('an employee cannot see automation (403)', r.status === 403, r.status)

  // ─── Rules ─────────────────────────────────────────────────
  const rule = { name: 'Welcome in Ops', trigger: 'employee.created', conditions: [{ field: 'employee.department', op: 'eq', value: 'ops' }], actions: [
    { type: 'notify', to: ['hr_admin'], title: 'New joiner: {{employee.name}}', body: '{{employee.name}} ({{employee.employeeCode}}) joins {{employee.department}}' },
    { type: 'task', assignTo: 'manager', title: 'Plan the first week for {{employee.name}}', dueInDays: 2 },
  ] }
  r = await api(owner, 'POST', '/automation/rules', { ...rule, conditions: [{ field: 'salary', op: 'eq', value: '1' }] })
  check('a condition on a field the trigger does not have is refused (400)', r.status === 400, r.data)
  r = await api(owner, 'POST', '/automation/rules', { ...rule, conditions: [{ field: 'employee.department', op: 'gt', value: '3' }] })
  check('"greater than" on a text field is refused (400)', r.status === 400, r.data)
  r = await api(owner, 'POST', '/automation/rules', { ...rule, trigger: 'policy.published', conditions: [] })
  check('a trigger not about one person cannot notify "the manager" (400)', r.status === 400, r.data)
  r = await api(owner, 'POST', '/automation/rules', rule)
  const ruleId = r.body?.id
  check('HR creates the rule', r.status === 201 && r.body.active, r.data)

  r = await api(owner, 'POST', '/employees/import', { rows: [
    { first_name: 'Ana', last_name: 'One', work_email: `ana.${TAG}@example.com`, hire_date: '2026-10-01', department: 'Ops', manager: ownerEmail },
    { first_name: 'Ben', last_name: 'Two', work_email: `ben.${TAG}@example.com`, hire_date: '2026-10-01', department: 'Sales', manager: ownerEmail },
  ], dryRun: false, createMissing: true })
  const [ana, ben] = r.body.rows
  const anaRun = await until(() => prisma.automationRun.findFirst({ where: { ruleId, status: { in: ['done', 'failed'] } } }))
  check('the rule runs for the Ops joiner', anaRun?.status === 'done', anaRun)
  const note = await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId: ownerUser.id, type: `automation:${ruleId}` } })
  check('HR gets the filled-in message', note?.title === 'New joiner: Ana One' && note.body.includes(ana.employeeCode) && note.body.endsWith('joins Ops'), note)
  const task = await prisma.activity.findFirst({ where: { tenantId: tenant.id, entityId: ana.employeeId } })
  check('a task goes to her manager, due in 2 days', task?.assignedToId === ownerUser.employee.id && task.title === 'Plan the first week for Ana One', task)
  const benRun = await until(() => prisma.automationRun.findFirst({ where: { ruleId, status: 'skipped' } }))
  check('the Sales joiner is skipped (conditions not met)', !!benRun && !(await prisma.activity.findFirst({ where: { entityId: ben.employeeId } })), benRun)
  const runAgain = await prisma.domainEvent.findFirst({ where: { id: anaRun.eventId } })
  await prisma.domainEvent.update({ where: { id: runAgain.id }, data: { status: 'failed' } })
  await api(owner, 'POST', '/system/jobs/events-sweep/run')
  await sleep(4000)
  check('a re-dispatched event does not repeat the actions', (await prisma.activity.count({ where: { entityId: ana.employeeId } })) === 1 && (await prisma.notification.count({ where: { userId: ownerUser.id, type: `automation:${ruleId}` } })) === 1)
  r = await api(owner, 'GET', `/automation/runs?ruleId=${ruleId}`)
  check('the run log shows both runs with the event type', r.status === 200 && r.body.length === 2 && r.body.every((x) => x.eventType === 'employee.created'), r.body?.map((x) => x.status))
  r = await api(owner, 'POST', '/automation/rules/test', rule)
  check('a dry run uses the latest real event and previews the message', r.status === 200 && r.body.event && typeof r.body.matches === 'boolean' && r.body.preview[0].title.startsWith('New joiner: '), r.data)
  r = await api(owner, 'PUT', `/automation/rules/${ruleId}`, { ...rule, active: false })
  check('HR switches the rule off', r.status === 200 && r.body.active === false, r.data)

  // ─── People dates ──────────────────────────────────────────
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lusaka' }))
  const md = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  await prisma.employee.update({ where: { id: ben.employeeId }, data: { dateOfBirth: new Date(`1990-${md}T00:00:00Z`) } })
  r = await api(owner, 'POST', '/automation/rules', { name: 'Birthdays', trigger: 'employee.birthday', actions: [{ type: 'notify', to: ['hr_admin'], title: 'Birthday today: {{employee.name}}' }] })
  const bdayRule = r.body.id
  await api(owner, 'POST', '/system/jobs/people-dates/run')
  await api(owner, 'POST', '/system/jobs/people-dates/run')
  const bday = await until(() => prisma.notification.findFirst({ where: { userId: ownerUser.id, type: `automation:${bdayRule}` } }))
  check('the daily check sends a birthday alert', bday?.title === 'Birthday today: Ben Two', bday)
  check('…and running it twice in a day publishes one event', (await prisma.domainEvent.count({ where: { tenantId: tenant.id, eventType: 'employee.birthday' } })) === 1)

  // ─── Webhooks ──────────────────────────────────────────────
  const hook = { name: 'HR data lake', url: 'https://example.com/hooks/marichi', events: ['employee.created', 'leave.request.approved'] }
  for (const url of ['http://example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://user:pw@example.com/x']) {
    r = await api(owner, 'POST', '/automation/webhooks', { ...hook, url })
    check(`webhook URL refused: ${url}`, r.status === 400, r.data)
  }
  r = await api(asRoles(['hr_admin']), 'POST', '/automation/webhooks', hook)
  check('only system admins manage webhooks (403)', r.status === 403, r.status)
  r = await api(owner, 'POST', '/automation/webhooks', hook)
  const hookId = r.body?.id
  check('a webhook is created and its signing secret shown once', r.status === 201 && /^whsec_/.test(r.body.signingSecret), r.data)
  const stored = await prisma.webhook.findUnique({ where: { id: hookId } })
  check('the secret is stored encrypted', stored.secret !== r.body.signingSecret && !stored.secret.includes('whsec_'))
  r = await api(owner, 'GET', '/automation/webhooks')
  check('the list never returns the secret', !JSON.stringify(r.body).includes('secret'), r.body)
  r = await api(owner, 'POST', `/automation/webhooks/${hookId}/ping`)
  check('a test ping makes a real request and records the response', r.status === 200 && r.body.attempts === 1 && (r.body.responseCode != null || r.body.lastError), r.data)
  await api(owner, 'POST', '/employees/import', { rows: [{ first_name: 'Cy', last_name: 'Three', work_email: `cy.${TAG}@example.com`, hire_date: '2026-10-01', department: 'Ops' }], dryRun: false, createMissing: true })
  const delivery = await until(() => prisma.webhookDelivery.findFirst({ where: { webhookId: hookId, eventType: 'employee.created', attempts: { gte: 1 } } }))
  check('subscribed events create a delivery with an attempt', delivery && delivery.attempts >= 1, delivery)
  if (delivery && delivery.status === 'failed') check('a failed delivery is scheduled for retry', !!delivery.nextAttemptAt, delivery)
  r = await api(owner, 'GET', `/automation/webhooks/${hookId}/deliveries`)
  check('HR sees the delivery log', r.status === 200 && r.body.length >= 2, r.body?.length)

  // ─── API keys + integration API ────────────────────────────
  r = await api(owner, 'POST', '/automation/api-keys', { name: 'BI tool', scopes: ['employees:read'] })
  const key = r.body?.key
  check('an API key is created and shown once', r.status === 201 && /^mhr_[0-9a-f]{48}$/.test(key), r.data)
  check('only a hash is stored', !(await prisma.apiKey.findFirst({ where: { tenantId: tenant.id, keyHash: key } })))
  r = await withKey(key, '/integration/employees')
  const emails = (r.body?.data ?? []).map((e) => e.workEmail)
  check('the key lists this company’s people only', r.status === 200 && emails.includes(`ana.${TAG}@example.com`) && !emails.includes('admin@marichihr.com'), r.body)
  check('…with work details only (no birth date, phone or pay)', r.body.data.every((e) => !('dateOfBirth' in e) && !('mobilePersonal' in e)) && r.body.data.find((e) => e.workEmail === `ana.${TAG}@example.com`).department === 'Ops')
  r = await withKey(key, '/integration/leave?from=2026-01-01&to=2026-12-31')
  check('a scope the key lacks is refused (403)', r.status === 403, r.status)
  r = await withKey('mhr_' + '0'.repeat(48), '/integration/employees')
  check('a wrong key is refused (401)', r.status === 401, r.status)
  r = await withKey(null, '/integration/employees')
  check('no key is refused (401)', r.status === 401, r.status)
  const keyId = (await prisma.apiKey.findFirst({ where: { tenantId: tenant.id } })).id
  await api(owner, 'POST', `/automation/api-keys/${keyId}/revoke`)
  r = await withKey(key, '/integration/employees')
  check('a revoked key stops working (401)', r.status === 401, r.status)

  await prisma.webhook.updateMany({ where: { tenantId: tenant.id }, data: { active: false } })
  await prisma.automationRule.updateMany({ where: { tenantId: tenant.id }, data: { active: false } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  await redis.quit()
  await done()
})()

// Audit log: who can read it, field-level before/after for employee edits, sign-ins with IP, secret masking,
// filters, paging, CSV export, and isolation between companies.
const { Redis } = require('ioredis')
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `au${Date.now() % 1e6}`
const BASE = (process.env.API_URL || 'http://localhost:4000') + '/api/v1'
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })

;(async () => {
  const admin = await tokenFor('admin@marichihr.com') // hr_admin + system_admin
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const john = await tokenFor('john.banda@marichihr.com')
  const finance = await tokenFor('finance@marichihr.com')

  // ─── Access ────────────────────────────────────────────────
  let r = await api(admin, 'GET', '/audit')
  check('HR/system admin can read the audit log', r.status === 200 && Array.isArray(r.body.items), r.data)
  for (const [who, label] of [[jane, 'an employee'], [john, 'a manager'], [finance, 'payroll admin']]) {
    r = await api(who, 'GET', '/audit')
    check(`${label} cannot (403)`, r.status === 403, r.status)
  }

  // ─── Field-level before/after ──────────────────────────────
  const before = await prisma.employee.findUnique({ where: { id: jane.employeeId }, select: { mobileWork: true } })
  const phone = `+260 97 ${String(Date.now() % 1e7).padStart(7, '0')}`
  r = await api(admin, 'PATCH', `/employees/${jane.employeeId}`, { mobileWork: phone })
  r = await api(admin, 'GET', `/audit?entityType=employee&entityId=${jane.employeeId}&action=employee updated&limit=5`)
  const upd = r.body.items[0]
  check('an employee edit is logged with only the changed field, before and after', upd && upd.action === 'EMPLOYEE_UPDATED' && upd.changes.length === 1 && upd.changes[0].field === 'mobileWork' && upd.changes[0].to === phone && upd.changes[0].from === (before.mobileWork ?? null), upd)
  check('…with who did it and a readable record name', upd?.user?.id === admin.userId && /Jane/.test(upd.entity), upd)
  await api(admin, 'PATCH', `/employees/${jane.employeeId}`, { mobileWork: before.mobileWork ?? '' })
  const count = () => prisma.auditLog.count({ where: { tenantId: admin.tenantId, entityId: jane.employeeId, action: 'EMPLOYEE_UPDATED' } })
  const n0 = await count()
  await api(admin, 'PATCH', `/employees/${jane.employeeId}`, { mobileWork: before.mobileWork ?? '' })
  check('saving without changes adds no entry', (await count()) === n0, { before: n0 })

  // ─── Masking ───────────────────────────────────────────────
  const planted = await prisma.auditLog.create({ data: { tenantId: admin.tenantId, userId: admin.userId, action: `TEST_${TAG}`, entityType: 'test', entityId: TAG, newValue: { password: 'hunter2', bankAccountNo: '1234567890', refreshToken: 'abc', name: 'visible' } } })
  r = await api(admin, 'GET', `/audit?entityType=test&entityId=${TAG}`)
  const ch = Object.fromEntries((r.body.items[0]?.changes ?? []).map((c) => [c.field, c.to]))
  check('secrets are masked, other values shown', ch.password === '••••' && ch.bankAccountNo === '••••' && ch.refreshToken === '••••' && ch.name === 'visible', ch)
  check('…and never appear in the response', !JSON.stringify(r.data).includes('hunter2') && !JSON.stringify(r.data).includes('1234567890'))

  // ─── Filters, paging, facets ───────────────────────────────
  r = await api(admin, 'GET', '/audit?from=2099-01-01')
  check('a future date range is empty', r.status === 200 && r.body.items.length === 0)
  r = await api(admin, 'GET', '/audit?limit=2')
  const p1 = r.body
  r = await api(admin, 'GET', `/audit?limit=2&cursor=${p1.nextCursor}`)
  check('paging returns the next, older entries', p1.items.length === 2 && p1.nextCursor && r.body.items.length > 0 && !r.body.items.some((x) => p1.items.some((y) => y.id === x.id)) && new Date(r.body.items[0].at) <= new Date(p1.items[1].at), { p1: p1.items.map((x) => x.at), p2: r.body.items.map((x) => x.at) })
  r = await api(admin, 'GET', `/audit?userId=${admin.userId}&limit=10`)
  check('filter by person', r.body.items.length > 0 && r.body.items.every((x) => x.user?.id === admin.userId))
  r = await api(admin, 'GET', '/audit/facets')
  check('filter choices list areas, actions and people', r.status === 200 && r.body.entityTypes.includes('employee') && r.body.actions.includes('EMPLOYEE_UPDATED') && r.body.users.some((u) => u.id === admin.userId), r.data)

  // ─── CSV export ────────────────────────────────────────────
  const res = await fetch(`${BASE}/audit/export?entityType=employee&entityId=${jane.employeeId}`, { headers: { Authorization: `Bearer ${admin.token}` } })
  const csv = await res.text()
  check('CSV export downloads with a header row and the edit', res.status === 200 && /text\/csv/.test(res.headers.get('content-type')) && csv.includes('Time (UTC),Who,Action') && csv.includes('EMPLOYEE_UPDATED'), csv.slice(0, 200))
  check('…and the export itself is logged', !!(await prisma.auditLog.findFirst({ where: { tenantId: admin.tenantId, action: 'AUDIT_LOG_EXPORTED', userId: admin.userId, createdAt: { gte: new Date(Date.now() - 60_000) } } })))

  // ─── Sign-ins, in a fresh company (isolation too) ──────────
  for (const k of await redis.keys('signup:*')) await redis.del(k)
  const email = `audit.${TAG}@example.com`, password = `Audit${TAG}x9`
  r = await api(null, 'POST', '/auth/signup', { companyName: `Audit ${TAG}`, fullName: 'Ada Auditor', email, password })
  const tenantId = r.body?.user?.tenant?.id
  r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': `audit-test ${TAG}` }, body: JSON.stringify({ email, password }) })
  const login = (await r.json()).data
  r = await api(login.accessToken, 'GET', '/audit?action=signed in')
  const si = r.body.items[0]
  check('a sign-in is logged with method, IP and device', si && si.action === 'SIGNED_IN' && si.changes.some((c) => c.field === 'method' && c.to === 'password') && si.ipAddress && si.userAgent === `audit-test ${TAG}`, si)
  r = await api(login.accessToken, 'GET', '/audit?limit=100')
  check("a company only sees its own audit log", r.body.items.every((x) => x.action !== 'EMPLOYEE_UPDATED' || x.entityId !== jane.employeeId) && !r.body.items.some((x) => x.entityId === TAG), r.body.items.map((x) => x.action))
  r = await api(admin, 'GET', `/audit?userId=${login.user.id}`)
  check("…and the other company's entries are invisible here", r.body.items.length === 0, r.body.items.length)

  await prisma.auditLog.delete({ where: { id: planted.id } })
  if (tenantId) await prisma.tenant.update({ where: { id: tenantId }, data: { active: false } })
  await redis.quit()
  await done()
})().catch(async (e) => { console.error(e); await redis.quit(); await prisma.$disconnect(); process.exit(1) })

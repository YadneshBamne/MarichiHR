// Platform: personal-data export and erasure, write API (employees, leave), push subscriptions, legal entities with
// per-entity payroll runs.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `pf${Date.now() % 1e7}`
const BASE = (process.env.API_URL || 'http://localhost:4000') + '/api/v1'
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
const keyCall = async (key, method, path, body) => { const r = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json().catch(() => null) } }

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `PlatG ${TAG}`, fullName: 'Pat Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { primaryCountry: 'ZM', modules: { set: [...new Set([...(tenant.modules ?? []), 'payroll', 'leave'])] } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first) => {
    const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time' })
    const id = (x.body.employee ?? x.body).id
    await api(owner, 'PUT', `/employees/${id}/access`, { roles: ['employee'], password: 'generate', loginEnabled: true })
    return prisma.employee.findUnique({ where: { id } })
  }
  const hr2 = await add('Hope'), pay = await add('Paul'), e1 = await add('Ivy'), e2 = await add('Jack')
  const asHR2 = as(hr2, ['employee', 'hr_admin']), asPay = as(pay, ['employee', 'payroll_admin']), asE1 = as(e1, ['employee']), asE2 = as(e2, ['employee'])

  // ─── Personal data ──────────────────────────────────────
  r = await api(asE1, 'GET', `/privacy/export/${e1.id}`)
  check('Ivy downloads her own data', r.status === 200 && r.body.profile.firstName === 'Ivy' && 'leave' in r.body, r.status)
  r = await api(asE2, 'GET', `/privacy/export/${e1.id}`)
  check('Jack cannot download Ivy’s data (404)', r.status === 404, r.status)
  r = await api(owner, 'GET', `/privacy/export/${e1.id}`)
  check('HR can (for her), without pay', r.status === 200 && !('payslips' in r.body), Object.keys(r.body ?? {}))
  r = await api(owner, 'POST', '/privacy/erasure', { employeeId: e1.id, reason: 'Asked by email after leaving' })
  const req = r.body
  check('HR records an erasure request', r.status === 201 && req.status === 'pending', r.data)
  r = await api(owner, 'POST', `/privacy/requests/${req.id}/decide`, { approve: true })
  check('the HR admin who recorded it cannot decide it (403)', r.status === 403, r.status)
  r = await api(asHR2, 'POST', `/privacy/requests/${req.id}/decide`, { approve: true })
  check('erasure waits until the person has left (400)', r.status === 400 && /left/.test(r.data.message), r.data)
  await api(owner, 'POST', `/employees/${e1.id}/archive`, { reason: 'Left the company' })
  r = await api(asHR2, 'POST', `/privacy/requests/${req.id}/decide`, { approve: true })
  const gone = await prisma.employee.findUnique({ where: { id: e1.id } })
  const goneUser = await prisma.user.findUnique({ where: { id: e1.userId } })
  check('after she left, a second HR admin erases it: name, contact and login gone; the code stays', r.status === 200 && gone.firstName === 'Former employee' && gone.workEmail === null && goneUser.email.endsWith('@erased.invalid') && !goneUser.active && gone.employeeCode === e1.employeeCode, { gone: gone.firstName, email: goneUser.email })
  r = await api(null, 'POST', '/auth/login', { email: `ivy.${TAG}@example.com`, password: 'anything-123' })
  check('her old email no longer signs in (401)', r.status === 401, r.status)

  // ─── Write API ──────────────────────────────────────────
  r = await api(owner, 'POST', '/automation/api-keys', { name: 'HR feed', scopes: ['employees:read', 'employees:write', 'leave:write'] })
  const key = r.body.key
  const readOnly = (await api(owner, 'POST', '/automation/api-keys', { name: 'BI', scopes: ['employees:read'] })).body.key
  r = await keyCall(readOnly, 'POST', '/integration/employees', { firstName: 'Wanda', lastName: TAG, workEmail: `wanda.${TAG}@example.com`, hireDate: '2026-02-02' })
  check('a key without employees:write cannot create people (403)', r.status === 403, r.status)
  r = await keyCall(key, 'POST', '/integration/employees', { firstName: 'Wanda', lastName: TAG, workEmail: `wanda.${TAG}@example.com`, hireDate: '2026-02-02', department: 'No such dept' })
  check('an unknown department is refused by name (400)', r.status === 400 && /No such dept/.test(r.body.message), r.body)
  r = await keyCall(key, 'POST', '/integration/employees', { firstName: 'Wanda', lastName: TAG, workEmail: `wanda.${TAG}@example.com`, hireDate: '2026-02-02', managerEmployeeId: e2.employeeCode })
  const wanda = r.body?.data
  check('another system creates Wanda (one department: chosen for it), reporting to Jack', r.status === 201 && !!wanda?.employeeId, r.body)
  r = await keyCall(key, 'PATCH', `/integration/employees/${wanda?.employeeId}`, { mobileWork: '+260 97 0000000' })
  const w = await prisma.employee.findFirst({ where: { tenantId: tenant.id, employeeCode: wanda?.employeeId } })
  check('…and updates her work phone', r.status === 200 && w.mobileWork === '+260 97 0000000' && w.managerId === e2.id, r.body)
  r = await keyCall(key, 'POST', '/integration/leave', { employeeId: wanda?.employeeId, leaveType: 'Casual Leave', startDate: '2026-12-02', endDate: '2026-12-02', reason: 'From the kiosk' })
  check('…and applies leave for her, which waits for approval', r.status === 201 && r.body.data.status === 'pending', r.body)

  // ─── Push ───────────────────────────────────────────────
  r = await api(asE2, 'GET', '/notifications/push/key')
  check('the server hands out its push key', r.status === 200 && typeof r.body.key === 'string' && r.body.key.length > 40, r.body)
  r = await api(asE2, 'POST', '/notifications/push/subscribe', { endpoint: 'http://insecure.example.com/x', keys: { p256dh: 'BOr8vVd6l1lEoS2cS1Z9w6mkb1o0xS1X', auth: 'a1b2c3d4e5f6' } })
  check('only https push endpoints are accepted (400)', r.status === 400, r.status)
  const endpoint = `https://fcm.googleapis.com/fcm/send/test-${TAG}`
  r = await api(asE2, 'POST', '/notifications/push/subscribe', { endpoint, keys: { p256dh: 'BOr8vVd6l1lEoS2cS1Z9w6mkb1o0xS1XyZ', auth: 'a1b2c3d4e5f6' } })
  r = await api(asE2, 'GET', '/notifications/preferences')
  check('Jack turns push on for a device', r.status === 200 && r.body.channels.push === true && r.body.devices === 1, r.body)
  await api(asE2, 'POST', '/notifications/push/unsubscribe', { endpoint })
  check('…and off again', (await prisma.pushSubscription.count({ where: { userId: e2.userId } })) === 0, null)

  // ─── Legal entities ─────────────────────────────────────
  r = await api(asE2, 'POST', '/company/entities', { name: 'Zed Co', country: 'ZM', currency: 'ZMW' })
  check('employees cannot create entities (403)', r.status === 403, r.status)
  const zm = (await api(owner, 'POST', '/company/entities', { name: 'Zed Co', country: 'ZM', currency: 'ZMW', taxId: '1000000001' })).body
  const ke = (await api(owner, 'POST', '/company/entities', { name: 'Kenya Co', country: 'KE', currency: 'KES' })).body
  r = await api(owner, 'PATCH', `/employees/${e2.id}`, { legalEntityId: zm.id })
  r = await api(owner, 'PATCH', `/employees/${pay.id}`, { legalEntityId: ke.id })
  r = await api(owner, 'GET', '/company/entities')
  check('two entities, one person each', r.body.length === 2 && r.body.every((x) => x.people === 1), r.body)
  const structure = (await api(asPay, 'POST', '/salary/structures/starter')).body
  for (const e of [e2, pay]) {
    const k = await api(asPay, 'POST', '/leave/contracts', { employeeId: e.id, ctcAnnual: 120000, wageMonthly: 10000, currency: 'ZMW', effectiveFrom: '2025-01-06', salaryStructureId: structure.id })
    for (const s of ['draft', 'confirm', 'activate']) await api(asPay, 'POST', `/leave/contracts/${k.body.id}/${s}`, {})
  }
  r = await api(asPay, 'POST', '/payroll/cycles', { payPeriodStart: '2026-03-01', payPeriodEnd: '2026-03-31', legalEntityId: zm.id })
  const zmRun = r.body
  check('Payroll opens a March run for Zed Co only', r.status === 201 && zmRun.legalEntityId === zm.id, r.data)
  r = await api(asPay, 'POST', '/payroll/cycles', { payPeriodStart: '2026-03-01', payPeriodEnd: '2026-03-31' })
  check('a March run for everyone now overlaps it (409)', r.status === 409, r.status)
  r = await api(asPay, 'POST', '/payroll/cycles', { payPeriodStart: '2026-03-01', payPeriodEnd: '2026-03-31', legalEntityId: ke.id })
  check('Kenya Co can have its own March run', r.status === 201, r.data)
  await api(asPay, 'POST', `/payroll/cycles/${zmRun.id}/lock-attendance`)
  r = await api(asPay, 'POST', `/payroll/cycles/${zmRun.id}/run`)
  const slips = await prisma.payslip.findMany({ where: { payrollCycleId: zmRun.id }, select: { employeeId: true } })
  check('the Zed Co run pays only Zed Co’s person', r.status === 200 && slips.length === 1 && slips[0].employeeId === e2.id, slips)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

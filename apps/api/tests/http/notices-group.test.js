// Notifications and KPIs: attendance locked, payroll paid, the tax declaration window (open / closing soon, submit
// refused outside it), certificates released, returns recorded as filed, success KPIs by role.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `nt${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ymd = (d) => d.toISOString().slice(0, 10)

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `NotG ${TAG}`, fullName: 'Nia Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const hr = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { primaryCountry: 'ZM', modules: { set: [...new Set([...(tenant.modules ?? []), 'payroll'])] } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, roles = []) => {
    const x = await api(hr, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time' })
    const id = (x.body.employee ?? x.body).id
    await api(hr, 'PUT', `/employees/${id}/access`, { roles: ['employee', ...roles], password: 'generate', loginEnabled: true })
    return prisma.employee.findUnique({ where: { id } })
  }
  const p1 = await add('Pemba', ['payroll_admin']), p2 = await add('Pule', ['payroll_admin']), emp = await add('Esther')
  const asP1 = as(p1, ['employee', 'payroll_admin']), asP2 = as(p2, ['employee', 'payroll_admin']), asE = as(emp, ['employee'])
  const note = async (userId, type, tries = 20) => { for (let i = 0; i < tries; i++) { const n = await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId, type }, orderBy: { createdAt: 'desc' } }); if (n) return n; await sleep(500) } return null }

  // A paid January 2026 payroll
  const structure = (await api(asP1, 'POST', '/salary/structures/starter')).body
  const k = await api(asP1, 'POST', '/leave/contracts', { employeeId: emp.id, ctcAnnual: 120000, wageMonthly: 10000, currency: 'ZMW', effectiveFrom: '2025-01-06', salaryStructureId: structure.id })
  for (const s of ['draft', 'confirm', 'activate']) await api(asP1, 'POST', `/leave/contracts/${k.body.id}/${s}`, {})
  const cycle = (await api(asP1, 'POST', '/payroll/cycles', { payPeriodStart: '2026-01-01', payPeriodEnd: '2026-01-31' })).body
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
  const locked = await note(p2.userId, 'payroll.locked')
  check('the other Payroll admin hears attendance is locked', !!locked && /January 2026/.test(locked.title), locked?.title)
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/run`)
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/approve`)
  await api(asP2, 'POST', `/payroll/cycles/${cycle.id}/finance-approve`)
  r = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/disburse`)
  const paid = await note(p1.userId, 'payroll.disbursed')
  check('payment is confirmed to the Payroll admins', r.status === 200 && !!paid && /paid/.test(paid.title), paid?.title)

  // ─── Declaration window ─────────────────────────────────
  const y = new Date().getUTCFullYear()
  r = await api(asE, 'PUT', '/tax/declarations/window', { year: y, opensOn: ymd(new Date(Date.now() - 86_400_000)), closesOn: ymd(new Date(Date.now() + 2 * 86_400_000)) })
  check('only Payroll sets the window (403)', r.status === 403, r.status)
  r = await api(asP1, 'PUT', '/tax/declarations/window', { year: y, opensOn: ymd(new Date(Date.now() - 86_400_000)), closesOn: ymd(new Date(Date.now() + 2 * 86_400_000)) })
  const opened = await prisma.notification.findMany({ where: { tenantId: tenant.id, userId: emp.userId, type: 'tax.declaration_window' } })
  check('it is open: Esther is told it opened and, closing in 2 days, reminded', r.status === 200 && r.body.open && opened.some((n) => /are open/.test(n.title)) && opened.some((n) => /close on/.test(n.title)), opened.map((n) => n.title))
  await api(asP1, 'PUT', '/tax/declarations/window', { year: y, opensOn: ymd(new Date(Date.now() - 86_400_000)), closesOn: ymd(new Date(Date.now() + 2 * 86_400_000)) })
  const again = await prisma.notification.count({ where: { tenantId: tenant.id, userId: emp.userId, type: 'tax.declaration_window', title: { contains: 'are open' } } })
  check('saving it again does not repeat the opening notice', again === 1, again)
  await api(asE, 'PUT', `/tax/declarations/mine?year=${y + 1}`, { items: [{ section: '80C', description: 'PPF', amount: 1000 }] })
  await api(asP1, 'PUT', '/tax/declarations/window', { year: y + 1, opensOn: `${y + 1}-04-01`, closesOn: `${y + 1}-05-31` })
  r = await api(asE, 'POST', `/tax/declarations/mine/submit?year=${y + 1}`)
  check('submitting before the window opens is refused, saying when (400)', r.status === 400 && new RegExp(`open on ${y + 1}-04-01`).test(r.data.message), r.data)

  // ─── Certificates ───────────────────────────────────────
  r = await api(asP1, 'POST', '/tax/certificates/release', { year: y, basis: 'calendar' })
  check('certificates for a year still running cannot be released (400)', r.status === 400, r.data)
  r = await api(asP1, 'POST', '/tax/certificates/release', { year: 2025, basis: 'april' })
  const cert = await note(emp.userId, 'tax.certificate', 4)
  check('releasing 2025-26 (April to March) tells Esther (paid in January 2026) her certificate is ready', r.status === 201 && r.body.notified === 1 && !!cert, r.data)
  r = await api(asP1, 'POST', '/tax/certificates/release', { year: 2025, basis: 'april' })
  check('…once (409)', r.status === 409, r.status)

  // ─── Filings ────────────────────────────────────────────
  r = await api(asP1, 'GET', '/tax/filings')
  check('the paid run shows nothing filed yet', r.body.find((c) => c.id === cycle.id)?.filings.length === 0, r.body)
  r = await api(asP1, 'POST', '/tax/filings', { cycleId: cycle.id, authority: 'ZRA', reference: 'ACK-123', filedOn: ymd(new Date(Date.now() + 86_400_000)) })
  check('a filing date in the future is refused (400)', r.status === 400, r.status)
  r = await api(asP1, 'POST', '/tax/filings', { cycleId: cycle.id, authority: 'ZRA', reference: 'ACK-123', filedOn: ymd(new Date()) })
  const filed = await note(p2.userId, 'tax.filed', 4)
  check('recording the ZRA filing tells the other Payroll admin', r.status === 201 && !!filed && /ZRA/.test(filed.title) && /ACK-123/.test(filed.body), filed)
  r = await api(asE, 'GET', '/tax/filings')
  check('employees cannot see filings (403)', r.status === 403, r.status)

  // ─── KPIs ───────────────────────────────────────────────
  r = await api(hr, 'GET', '/reports/kpis')
  check('the owner (HR and System admin) sees people KPIs and, as System admin, pay ones', r.status === 200 && 'adoption' in r.body && 'leave' in r.body && 'payroll' in r.body, r.body)
  r = await api(asP1, 'GET', '/reports/kpis?days=30')
  check('Payroll sees the paid run in the payroll KPIs', r.status === 200 && r.body.payroll.runs === 1 && r.body.payroll.avgDaysOpenToPaid != null && !('adoption' in r.body), r.body)
  r = await api(asE, 'GET', '/reports/kpis')
  check('employees do not see KPIs (403)', r.status === 403, r.status)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

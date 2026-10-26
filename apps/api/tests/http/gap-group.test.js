// Gap pass: readiness check, filing dashboard with sandbox adapters, bank file layouts, pay groups, payroll cost
// across currencies, HR Business Partner limited to departments.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `gp${Date.now() % 1e7}`
const BASE = (process.env.API_URL || 'http://localhost:4000')
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  let r0 = await fetch(`${BASE}/health/ready`)
  const ready = await r0.json()
  check('the readiness check reports database and Redis', r0.status === 200 && ready.database.ok && ready.redis.ok, ready)

  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `GapG ${TAG}`, fullName: 'Gail Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { primaryCountry: 'ZM', baseCurrency: 'ZMW', modules: { set: [...new Set([...(tenant.modules ?? []), 'payroll', 'leave'])] } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const sales = (await api(owner, 'POST', '/employees/org-units', { name: 'Sales', type: 'department', parentId: root.id })).body
  const ops = (await api(owner, 'POST', '/employees/org-units', { name: 'Operations', type: 'department', parentId: root.id })).body
  const add = async (first, unit, roles = []) => {
    const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: unit.id, hireDate: '2025-01-06', employmentType: 'full_time' })
    const id = (x.body.employee ?? x.body).id
    await api(owner, 'PUT', `/employees/${id}/access`, { roles: ['employee', ...roles], password: 'generate', loginEnabled: true })
    return prisma.employee.findUnique({ where: { id } })
  }
  const p1 = await add('Pemba', root, ['payroll_admin']), p2 = await add('Pule', root, ['payroll_admin']), hrbp = await add('Hilda', root, ['hr_admin'])
  const sam = await add('Sam', sales), olu = await add('Olu', ops)
  const asP1 = as(p1, ['employee', 'payroll_admin']), asP2 = as(p2, ['employee', 'payroll_admin']), asHRBP = as(hrbp, ['employee', 'hr_admin']), asSam = as(sam, ['employee'])

  // A paid January 2026 payroll for Sam and Olu
  const structure = (await api(asP1, 'POST', '/salary/structures/starter')).body
  for (const e of [sam, olu]) {
    const k = await api(asP1, 'POST', '/leave/contracts', { employeeId: e.id, ctcAnnual: 120000, wageMonthly: 10000, currency: 'ZMW', effectiveFrom: '2025-01-06', salaryStructureId: structure.id })
    for (const s of ['draft', 'confirm', 'activate']) await api(asP1, 'POST', `/leave/contracts/${k.body.id}/${s}`, {})
    await api(owner, 'PATCH', `/employees/${e.id}/bank`, { bankName: 'zanaco', bankAccountNo: '0123456789', bankIfscSwift: 'ZNCOZMLU' })
    await api(asP1, 'POST', `/employees/${e.id}/bank/verify`)
  }
  const cycle = (await api(asP1, 'POST', '/payroll/cycles', { payPeriodStart: '2026-01-01', payPeriodEnd: '2026-01-31' })).body
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/run`)
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/approve`)
  await api(asP2, 'POST', `/payroll/cycles/${cycle.id}/finance-approve`)
  r = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/disburse`)
  check('a January payroll is paid', r.status === 200, r.data)

  // ─── Filing dashboard ───────────────────────────────────
  r = await api(asP1, 'GET', '/tax/filing-dashboard')
  const run = r.body?.cycles.find((c) => c.id === cycle.id)
  const authorities = run?.returns.map((x) => x.authority) ?? []
  check('the dashboard lists the run’s returns: ZRA, NAPSA, NHIMA (sandbox mode)', r.body?.mode === 'sandbox' && ['ZRA', 'NAPSA', 'NHIMA'].every((a) => authorities.includes(a)) && run.returns.every((x) => x.amount > 0 && !x.filing), run)
  r = await api(asP1, 'POST', '/tax/filings/submit', { cycleId: cycle.id, authority: 'ZRA' })
  check('ZRA needs the employer tax number first (400)', r.status === 400 && /tax number/.test(r.data.message), r.data)
  await api(owner, 'POST', '/company/entities', { name: 'GapG Zambia', country: 'ZM', currency: 'ZMW', taxId: '1002003004' })
  r = await api(asP1, 'POST', '/tax/filings/submit', { cycleId: cycle.id, authority: 'ZRA' })
  check('with it, the ZRA return goes through the sandbox adapter and gets an acknowledgement', r.status === 201 && r.body.reference.startsWith('SANDBOX-ZRA-') && r.body.status === 'accepted' && r.body.rows === 2, r.data)
  r = await api(asP1, 'GET', '/tax/filing-dashboard')
  check('…and shows as filed on the dashboard', r.body.cycles.find((c) => c.id === cycle.id).returns.find((x) => x.authority === 'ZRA').filing?.mode === 'sandbox', null)
  r = await api(asSam, 'GET', '/tax/filing-dashboard')
  check('employees do not see it (403)', r.status === 403, r.status)

  // ─── Bank file layouts ──────────────────────────────────
  const fmts = (await api(asP1, 'GET', '/payroll/bank-formats')).body
  const { status: _s, source: _src, notes: _n, needs: _nd, ...fixedPreset } = fmts.presets.find((p) => p.kind === 'fixed')
  r = await api(asP1, 'POST', '/payroll/bank-formats', { ...fixedPreset, name: 'Zanaco fixed' })
  const fixed = r.body
  check('Payroll saves a fixed-width layout from a starting point', r.status === 201 && fixed.kind === 'fixed', r.data)
  const res = await fetch(`${BASE}/api/v1/payroll/cycles/${cycle.id}/bank-file?formatId=${fixed.id}&paymentDate=2026-01-30`, { headers: { authorization: `Bearer ${asP1.token}` } })
  const text = await res.text()
  const line = text.split('\r\n')[0]
  check('the bank file comes out fixed-width: 112 characters a line, amount in cents, date YYYYMMDD', res.status === 200 && line.length === 112 && line.startsWith('SAL0123456789') && line.includes('20260130'), line)

  // ─── Pay groups ─────────────────────────────────────────
  const weekly = (await api(asP1, 'POST', '/payroll/pay-groups', { name: 'Weekly casuals', frequency: 'weekly' })).body
  r = await api(owner, 'PATCH', `/employees/${olu.id}`, { payGroupId: weekly.id })
  r = await api(asP1, 'GET', '/payroll/pay-groups')
  check('a pay group with Olu in it', r.body.find((g) => g.id === weekly.id)?.people === 1, r.body)
  const g = (await api(asP1, 'POST', '/payroll/cycles', { payPeriodStart: '2026-02-01', payPeriodEnd: '2026-02-28', payGroupId: weekly.id })).body
  await api(asP1, 'POST', `/payroll/cycles/${g.id}/lock-attendance`)
  await api(asP1, 'POST', `/payroll/cycles/${g.id}/run`)
  const slips = await prisma.payslip.findMany({ where: { payrollCycleId: g.id }, select: { employeeId: true } })
  check('a run for the pay group pays only Olu', slips.length === 1 && slips[0].employeeId === olu.id, slips)

  // ─── Payroll cost across currencies ─────────────────────
  r = await api(asP1, 'GET', '/reports/payroll_consolidated?from=2026-01-01&to=2026-12-31')
  check('the consolidated payroll report converts to the company currency', r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].currency === 'ZMW' && r.body.rows[0].netBase > 0, r.body?.rows)

  // ─── HR Business Partner ────────────────────────────────
  r = await api(asHRBP, 'PUT', `/employees/${hrbp.id}/access`, { hrScopeUnitIds: [sales.id] })
  check('only a System admin sets an HR admin’s departments (403)', r.status === 403, r.status)
  r = await api(owner, 'PUT', `/employees/${hrbp.id}/access`, { hrScopeUnitIds: [sales.id] })
  check('the owner limits Hilda to Sales', r.status === 200 && r.body.hrScopeUnitIds[0] === sales.id, r.data)
  r = await api(asHRBP, 'GET', '/employees?limit=100')
  const seen = (Array.isArray(r.body) ? r.body : r.body?.data ?? []).map((e) => e.id)
  check('Hilda’s directory shows Sales (and herself), not Operations', seen.includes(sam.id) && seen.includes(hrbp.id) && !seen.includes(olu.id), seen.length)
  r = await api(asHRBP, 'GET', `/employees/${olu.id}`)
  check('she cannot open Olu’s profile (404)', r.status === 404, r.status)
  r = await api(asHRBP, 'GET', `/employees/${sam.id}`)
  check('she can open Sam’s', r.status === 200, r.status)
  const types = await prisma.leaveType.findFirst({ where: { tenantId: tenant.id, code: 'SICK' } })
  r = await api(as(olu, ['employee']), 'POST', '/leave/requests', { leaveTypeId: types.id, startDate: '2026-12-07', endDate: '2026-12-07', reason: 'Doctor' })
  const req = r.body
  r = await api(asHRBP, 'POST', `/leave/requests/${req.id}/approve`, {})
  check('she cannot approve leave for someone in Operations (403)', r.status === 403, r.data)

  r = await api(asHRBP, 'GET', '/reports/headcount')
  check('company-wide reports are not for her (403)', r.status === 403, r.status)
  r = await api(asHRBP, 'GET', '/dashboard')
  check('her dashboard has no company-wide section', r.status === 200 && !r.body.company, Object.keys(r.body ?? {}))

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

// Tax: a company's own table versions (Compliance officer), the version recorded per payslip line, manual tax
// overrides signed off by a different Compliance officer.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `tx${Date.now() % 1e7}`
const MONTH = process.env.TAX_MONTH || '2032-05'
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const company = async (name) => {
    const email = `owner.${name.toLowerCase()}.${TAG}@example.com`
    const r = await api(null, 'POST', '/auth/signup', { companyName: `${name} ${TAG}`, fullName: 'Owner', email, password: 'Owner-pass-123' })
    const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email } } } })
    await prisma.tenant.update({ where: { id: tenant.id }, data: { primaryCountry: 'ZM', modules: { set: [...new Set([...(tenant.modules ?? []), 'payroll'])] } } })
    return { owner: { token: r.body.accessToken }, tenant }
  }
  const { owner, tenant } = await company('TaxA')
  const other = await company('TaxB')
  const as = (emp, roleIds, t = tenant) => ({ token: jwt.sign({ userId: emp.userId, tenantId: t.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first) => { const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time' }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }
  const p1 = await add('Payone'), c1 = await add('Comply'), c2 = await add('Complytwo'), emp = await add('Mwila')
  for (const c of [c1, c2]) await api(owner, 'PUT', `/employees/${c.id}/access`, { roles: ['employee', 'compliance_officer'], password: 'generate', loginEnabled: true })
  for (const c of [c1, c2]) Object.assign(c, await prisma.employee.findUnique({ where: { id: c.id } }))
  const asP1 = as(p1, ['employee', 'payroll_admin']), asC1 = as(c1, ['employee', 'compliance_officer']), asC2 = as(c2, ['employee', 'compliance_officer'])
  const structure = (await api(asP1, 'POST', '/salary/structures/starter')).body
  const k = await api(asP1, 'POST', '/leave/contracts', { employeeId: emp.id, ctcAnnual: 240000, wageMonthly: 20000, currency: 'ZMW', effectiveFrom: '2025-01-06', salaryStructureId: structure.id })
  for (const s of ['draft', 'confirm', 'activate']) await api(asP1, 'POST', `/leave/contracts/${k.body.id}/${s}`, {})

  // ─── Company table versions ─────────────────────────────
  const shared = await prisma.statutoryTable.findFirst({ where: { code: 'ZM_PAYE', tenantId: null }, orderBy: { effectiveFrom: 'desc' } })
  const bands = shared.params.bands.map((b, i, all) => (i === all.length - 1 ? { ...b, rate: 0.5 } : b))
  let r = await api(asP1, 'POST', '/tax/tables', { code: 'ZM_PAYE', effectiveFrom: '2026-06-01', params: { ...shared.params, bands }, sourceNote: 'Test change' })
  check('a Payroll admin cannot change tax tables (403)', r.status === 403, r.status)
  r = await api(asC1, 'POST', '/tax/tables', { code: 'ZM_PAYE', effectiveFrom: '2026-06-01', params: { ...shared.params, bands: [{ upTo: null, rate: 30 }] }, sourceNote: 'Test change' })
  check('a rate of 30 (not 0.3) is refused with a clear message (400)', r.status === 400 && /fraction/.test(r.data.message), r.data)
  r = await api(asC1, 'POST', '/tax/tables', { code: 'ZM_PAYE', effectiveFrom: '2026-06-01', params: { ...shared.params, bands, extra: 1 }, sourceNote: 'Test change' })
  check('the figures must keep the shared shape (400)', r.status === 400, r.data)
  r = await api(asC1, 'POST', '/tax/tables', { code: 'ZM_PAYE', effectiveFrom: '2026-06-01', params: { ...shared.params, bands }, sourceNote: 'Budget circular (test)' })
  const version = r.body
  check('the Compliance officer saves the company version (top rate 50%)', r.status === 201 && version.tenantId === tenant.id, r.data)
  r = await api(asP1, 'GET', '/tax/tables')
  check('Payroll sees it as the company version in force', r.body.some((t) => t.id === version.id && t.company && t.inForce), r.body?.filter((t) => t.code === 'ZM_PAYE'))
  const otherP = await prisma.employee.findFirst({ where: { tenantId: other.tenant.id } })
  r = await api(as(otherP, ['employee', 'payroll_admin'], other.tenant), 'GET', '/tax/tables')
  check('another company never sees it', r.status === 200 && !r.body.some((t) => t.id === version.id), r.status)

  // ─── Payroll uses it and records the version ───────────
  const last = new Date(Date.UTC(+MONTH.slice(0, 4), +MONTH.slice(5), 0)).toISOString().slice(0, 10)
  const cycle = (await api(asP1, 'POST', '/payroll/cycles', { payPeriodStart: `${MONTH}-01`, payPeriodEnd: last })).body
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/run`)
  const slip = async () => prisma.payslip.findFirst({ where: { payrollCycleId: cycle.id, employeeId: emp.id }, include: { lines: true } })
  let s = await slip()
  const paye = s.lines.find((l) => l.category === 'TAX')
  check('the PAYE line records the company version it used', !!paye && /ZM_PAYE 2026-06-01 \(company\)/.test(paye.statutoryRef ?? ''), paye?.statutoryRef)
  r = await api(asC1, 'DELETE', `/tax/tables/${version.id}`)
  check('a version payroll has used cannot be removed (400)', r.status === 400, r.data)

  // ─── Overrides ──────────────────────────────────────────
  r = await api(asP1, 'POST', '/tax/overrides', { cycleId: cycle.id, employeeId: emp.id, lineCode: paye.code, amount: 100, reason: 'short' })
  check('an override needs a real reason (400)', r.status === 400, r.status)
  r = await api(asP1, 'POST', '/tax/overrides', { cycleId: cycle.id, employeeId: emp.id, lineCode: paye.code, amount: 100, reason: 'Relief certificate from ZRA received late' })
  const ov = r.body
  check('Payroll asks for a tax override; both Compliance officers are told', r.status === 201 && ov.status === 'pending' && ov.complianceOfficers === 2, r.data)
  r = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/approve`)
  check('the run cannot be approved while an override waits (400)', r.status === 400 && /Compliance/.test(r.data.message), r.data)
  r = await api(asP1, 'POST', `/tax/overrides/${ov.id}/decide`, { approve: true })
  check('Payroll cannot sign off its own override (403)', r.status === 403, r.status)
  const before = Number(s.netPay)
  r = await api(asC2, 'POST', `/tax/overrides/${ov.id}/decide`, { approve: true })
  s = await slip()
  const line = s.lines.find((l) => l.code === paye.code)
  check('a Compliance officer signs it off: PAYE becomes 100 and net pay moves by the difference', r.status === 200 && Number(line.amount) === 100 && Math.abs(Number(s.netPay) - (before + Number(paye.amount) - 100)) < 0.01, { amount: Number(line.amount), net: Number(s.netPay), before })
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/run`)
  s = await slip()
  check('a re-run keeps the signed-off override', Number(s.lines.find((l) => l.code === paye.code).amount) === 100, s.lines.map((l) => [l.code, Number(l.amount)]))
  r = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/approve`)
  check('with nothing waiting, the run can be approved', r.status === 200, r.data)

  for (const t of [tenant, other.tenant]) await prisma.tenant.update({ where: { id: t.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

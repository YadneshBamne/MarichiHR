// Kenya and Nigeria payroll from the statutory tables (marked to confirm), checked against worked examples.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `kn${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

async function company(country, currency, people) {
  const ownerEmail = `owner.${country.toLowerCase()}.${TAG}@example.com`
  const r = await api(null, 'POST', '/auth/signup', { companyName: `${country} ${TAG}`, fullName: 'Ola Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { primaryCountry: country, baseCurrency: currency, modules: { set: [...new Set([...(tenant.modules ?? []), 'payroll'])] } } })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first) => { const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${country}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time' }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }
  const p1 = await add('Pay')
  const asP1 = { token: jwt.sign({ userId: p1.userId, tenantId: tenant.id, employeeId: p1.id, roleIds: ['employee', 'payroll_admin'], email: 'x' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) }
  const structure = (await api(asP1, 'POST', '/salary/structures/starter')).body
  const emps = {}
  for (const [first, wage] of people) {
    const e = await add(first)
    const k = await api(asP1, 'POST', '/leave/contracts', { employeeId: e.id, ctcAnnual: wage * 12, wageMonthly: wage, currency, effectiveFrom: '2025-01-06', salaryStructureId: structure.id })
    for (const s of ['draft', 'confirm', 'activate']) await api(asP1, 'POST', `/leave/contracts/${k.body.id}/${s}`, {})
    emps[first] = e
  }
  const month = new Date().toISOString().slice(0, 7)
  const last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).toISOString().slice(0, 10)
  const cycle = (await api(asP1, 'POST', '/payroll/cycles', { payPeriodStart: `${month}-01`, payPeriodEnd: last })).body
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
  const run = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/run`)
  const slip = async (first) => { const s = await prisma.payslip.findFirst({ where: { payrollCycleId: cycle.id, employeeId: emps[first].id }, include: { lines: true } }); return { net: Number(s?.netPay), line: (c) => Number(s?.lines.find((l) => l.code === c)?.amount ?? NaN) } }
  return { tenant, structure, run, slip, asP1, cycle }
}

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})

  // ─── Kenya ────────────────────────────────────────────────
  const ke = await company('KE', 'KES', [['Wanjiru', 100000]])
  check('Kenya: the starter structure uses NSSF, SHIF, the housing levy and PAYE', ke.structure.code === 'KE-MONTHLY-STARTER' && ke.run.status === 200, ke.run.data)
  const w = await ke.slip('Wanjiru')
  check('Kenya 100,000: NSSF 6,000, SHIF 2,750, housing levy 1,500', w.line('NSSF_EMP') === 6000 && w.line('SHIF') === 2750 && w.line('AHL_EMP') === 1500, [w.line('NSSF_EMP'), w.line('SHIF'), w.line('AHL_EMP')])
  check('Kenya 100,000: PAYE 19,308.35 after the 2,400 personal relief', w.line('PAYE_KE') === 19308.35, w.line('PAYE_KE'))
  check('Kenya: net = 100,000 − 6,000 − 2,750 − 1,500 − 19,308.35', w.net === 70441.65, w.net)
  const r = await api(ke.asP1, 'GET', `/tax/filing?cycleId=${ke.cycle.id}`)
  check('Kenya: the statutory return lists NSSF, SHIF, levy and PAYE', ['NSSF_EMP', 'SHIF', 'AHL_EMP', 'PAYE_KE'].every((c) => r.body?.columns.some((x) => x.code === c)), r.body?.columns)

  // ─── Nigeria ──────────────────────────────────────────────
  const ng = await company('NG', 'NGN', [['Adaeze', 500000], ['Musa', 70000]])
  const a = await ng.slip('Adaeze'), m = await ng.slip('Musa')
  check('Nigeria 500,000: pension 8% = 40,000', a.line('PENSION_EMP') === 40000, a.line('PENSION_EMP'))
  // (500,000 − 40,000) × 12 = 5,520,000: 2,200,000 × 15% + 2,520,000 × 18% = 783,600 a year = 65,300 a month
  check('Nigeria 500,000: PAYE 65,300 a month under the 2025 Act bands', a.line('PAYE_NG') === 65300, a.line('PAYE_NG'))
  check('Nigeria: someone on the minimum wage (70,000) pays no PAYE', m.line('PAYE_NG') === 0, m.line('PAYE_NG'))

  const rows = await prisma.statutoryTable.findMany({ where: { country: { in: ['KE', 'NG'] } } })
  check('every Kenya and Nigeria rate is marked to confirm, with a source', rows.length >= 6 && rows.every((x) => x.verified === false && x.sourceUrl), rows.map((x) => x.code))

  for (const c of [ke, ng]) await prisma.tenant.update({ where: { id: c.tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

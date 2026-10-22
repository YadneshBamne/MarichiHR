// Payroll sign-off above a threshold (System admin, not one of the two approvers) and contractor withholding tax.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `sw${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Signoff ${TAG}`, fullName: 'Sam Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken } // hr_admin + system_admin
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { primaryCountry: 'ZM', baseCurrency: 'ZMW', modules: { set: [...new Set([...(tenant.modules ?? []), 'payroll'])] } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, employmentType = 'full_time') => { const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }
  const p1 = await add('Payone'), p2 = await add('Paytwo'), staff = await add('Stan'), contractor = await add('Cora', 'contractor')
  const asP1 = as(p1, ['employee', 'payroll_admin']), asP2 = as(p2, ['employee', 'payroll_admin'])

  // ─── Contractor structure and withholding ─────────────────
  const employeeStructure = (await api(asP1, 'POST', '/salary/structures/starter')).body
  r = await api(asP1, 'POST', '/salary/structures/starter', { kind: 'contractor' })
  const contractorStructure = r.body
  check('a Payroll admin creates the contractor structure in one click', r.status === 201 && contractorStructure.code === 'ZM-CONTRACTOR-STARTER', r.data)
  const contract = async (empId, wage, structureId) => {
    const k = await api(asP1, 'POST', '/leave/contracts', { employeeId: empId, ctcAnnual: wage * 12, wageMonthly: wage, currency: 'ZMW', effectiveFrom: '2025-01-06', salaryStructureId: structureId })
    for (const s of ['draft', 'confirm', 'activate']) await api(asP1, 'POST', `/leave/contracts/${k.body.id}/${s}`, {})
  }
  await contract(staff.id, 15000, employeeStructure.id)
  await contract(contractor.id, 10000, contractorStructure.id)

  // ─── Threshold ────────────────────────────────────────────
  r = await api(asP1, 'PUT', '/payroll/signoff-threshold', { amount: 1000 })
  check('only a System admin sets the sign-off amount (403)', r.status === 403, r.status)
  r = await api(owner, 'PUT', '/payroll/signoff-threshold', { amount: 1000 })
  check('the System admin sets it', r.status === 200 && r.body.amount === 1000, r.data)

  const month = new Date().toISOString().slice(0, 7)
  const last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).toISOString().slice(0, 10)
  const cycle = (await api(asP1, 'POST', '/payroll/cycles', { payPeriodStart: `${month}-01`, payPeriodEnd: last })).body
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
  r = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/run`)
  check('payroll runs', r.status === 200, r.data)
  const slip = await prisma.payslip.findFirst({ where: { payrollCycleId: cycle.id, employeeId: contractor.id }, include: { lines: true } })
  const line = (code) => Number(slip?.lines.find((l) => l.code === code)?.amount ?? NaN)
  check('the contractor has 15% withheld and no PAYE, NAPSA or NHIMA', line('WHT_ZM') === 1500 && Number(slip.netPay) === 8500 && !slip.lines.some((l) => /PAYE|NAPSA|NHIMA/.test(l.code)), slip?.lines.map((l) => [l.code, Number(l.amount)]))
  r = await api(asP1, 'GET', `/tax/filing?cycleId=${cycle.id}`)
  check('withholding appears in the statutory return', r.status === 200 && r.body.columns.some((c) => c.code === 'WHT_ZM'), r.body?.columns)

  // ─── Sign-off ─────────────────────────────────────────────
  r = await api(asP1, 'GET', `/payroll/cycles/${cycle.id}`)
  check('the cycle says it needs a sign-off', r.body.signoffRequired === true && r.body.signoffThreshold === 1000, r.body)
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/approve`)
  r = await api(asP2, 'POST', `/payroll/cycles/${cycle.id}/finance-approve`)
  check('two Payroll admins approve', r.status === 200, r.data)
  const ownerUser = await prisma.user.findFirst({ where: { tenantId: tenant.id, email: ownerEmail } })
  check('the System admin is asked to sign off', !!(await prisma.notification.findFirst({ where: { userId: ownerUser.id, type: 'payroll.signoff', entityId: cycle.id } })))
  r = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/disburse`)
  check('it cannot be paid before the sign-off (400)', r.status === 400 && /sign/.test(r.data.message), r.data)
  r = await api(owner, 'GET', '/payroll/signoffs')
  const waiting = r.body.cycles.find((c) => c.id === cycle.id)
  check('the System admin sees it waiting, with totals only', !!waiting && waiting.people === 2 && waiting.net > 1000 && !('lines' in waiting), r.body)
  r = await api(asP2, 'POST', `/payroll/cycles/${cycle.id}/signoff`)
  check('a Payroll admin cannot sign off (403)', r.status === 403, r.status)
  r = await api(owner, 'POST', `/payroll/cycles/${cycle.id}/signoff`)
  check('the System admin signs off', r.status === 200, r.data)
  r = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/disburse`)
  check('now it can be paid', r.status === 200, r.data)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

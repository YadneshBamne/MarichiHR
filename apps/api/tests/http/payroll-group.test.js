// Payroll: minimum wage on contracts, off-cycle runs (and corrections to a paid run), flexi-basket, payslip email.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `pg${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `PayG ${TAG}`, fullName: 'Pam Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { primaryCountry: 'NG', baseCurrency: 'NGN', modules: { set: [...new Set([...(tenant.modules ?? []), 'payroll'])] } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first) => { const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time' }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }
  const p1 = await add('Payone'), p2 = await add('Paytwo'), emp = await add('Ngozi')
  const asP1 = as(p1, ['employee', 'payroll_admin']), asP2 = as(p2, ['employee', 'payroll_admin']), asEmp = as(emp, ['employee'])
  const structure = (await api(asP1, 'POST', '/salary/structures/starter')).body

  // ─── Minimum wage ─────────────────────────────────────────
  r = await api(asP1, 'POST', '/leave/contracts', { employeeId: emp.id, ctcAnnual: 600000, wageMonthly: 50000, currency: 'NGN', effectiveFrom: '2025-01-06', salaryStructureId: structure.id })
  check("a contract below Nigeria's minimum wage (70,000) is refused (400)", r.status === 400 && /minimum wage/.test(r.data.message), r.data)
  r = await api(asP1, 'POST', '/leave/contracts', { employeeId: emp.id, ctcAnnual: 6000000, wageMonthly: 500000, currency: 'NGN', effectiveFrom: '2025-01-06', salaryStructureId: structure.id })
  for (const s of ['draft', 'confirm', 'activate']) await api(asP1, 'POST', `/leave/contracts/${r.body.id}/${s}`, {})
  check('a contract at 500,000 is fine', r.status === 201, r.data)

  // ─── Flexi-basket ─────────────────────────────────────────
  r = await api(asP1, 'PUT', `/salary/structures/${structure.id}/flexi`, { potCode: 'NOPE', components: [] })
  check('the flexi pot must be a rule of the structure (400)', r.status === 400, r.data)
  r = await api(asP1, 'PUT', `/salary/structures/${structure.id}/flexi`, { potCode: 'TRANSPORT', components: [{ code: 'FUEL', name: 'Fuel', max: 30000 }, { code: 'MEAL', name: 'Meal cards', max: 20000 }] })
  check('Payroll makes transport a flexi pot with fuel and meal cards', r.status === 200, r.data)
  r = await api(asEmp, 'PUT', '/salary/flexi/mine', { choices: { FUEL: 40000 } })
  check('a component cannot go over its limit (400)', r.status === 400, r.data)
  r = await api(asEmp, 'PUT', '/salary/flexi/mine', { choices: { FUEL: 30000, MEAL: 20000 } })
  const choice = r.body
  check('Ngozi chooses 30,000 fuel and 20,000 meal cards', r.status === 200 && choice.status === 'submitted', r.data)
  r = await api(asP2, 'POST', `/salary/flexi/${choice.id}/decide`, { approve: true })
  check('a Payroll admin approves it', r.status === 200, r.data)

  const month = new Date().toISOString().slice(0, 7)
  const last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).toISOString().slice(0, 10)
  const cycle = (await api(asP1, 'POST', '/payroll/cycles', { payPeriodStart: `${month}-01`, payPeriodEnd: last })).body
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
  r = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/run`)
  const slip = await prisma.payslip.findFirst({ where: { payrollCycleId: cycle.id, employeeId: emp.id }, include: { lines: true } })
  const amt = (c) => Number(slip?.lines.find((l) => l.code === c)?.amount ?? NaN)
  check('the payslip splits transport (100,000) into fuel 30,000 + meal 20,000 + 50,000 unallocated, same gross', amt('FLEXI_FUEL') === 30000 && amt('FLEXI_MEAL') === 20000 && amt('TRANSPORT') === 50000 && Number(slip.grossEarnings) === 500000, slip?.lines.map((l) => [l.code, Number(l.amount)]))

  // Pay the run, then correct it with an off-cycle run
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/approve`)
  await api(asP2, 'POST', `/payroll/cycles/${cycle.id}/finance-approve`)
  r = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/disburse`)
  check('the regular run is paid', r.status === 200, r.data)
  const released = await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId: emp.userId, type: 'payslip.released' } })
  check('Ngozi gets her payslip notification with the PDF for email', !!released && released.entityType === 'payslip' && (released.deliveries ?? []).some((d) => d.channel === 'email' && d.status === 'sent'), released?.deliveries)

  // ─── Off-cycle ────────────────────────────────────────────
  r = await api(asP1, 'POST', '/payroll/cycles', { payPeriodStart: `${month}-01`, payPeriodEnd: last, offCycle: true })
  check('an off-cycle run needs a reason (400)', r.status === 400, r.data)
  r = await api(asP1, 'POST', '/payroll/cycles', { payPeriodStart: `${month}-01`, payPeriodEnd: last, offCycle: true, reason: 'Missed overtime correction', correctsCycleId: cycle.id })
  const off = r.body
  check('Payroll opens an off-cycle correction for the paid run (same dates are fine)', r.status === 201 && off.offCycle === true && off.correctsCycleId === cycle.id, r.data)
  const type = await prisma.payrollInputType.findFirst({ where: { tenantId: tenant.id, category: 'earnings' } })
  r = await api(asP1, 'POST', `/payroll/cycles/${off.id}/inputs`, { employeeId: emp.id, inputTypeId: type.id, amount: 15000, description: 'Overtime missed in the run' })
  const input = r.body
  await api(asP2, 'POST', `/payroll/inputs/${input.id}/approve`)
  r = await api(asP1, 'POST', `/payroll/cycles/${off.id}/run`)
  const offSlip = await prisma.payslip.findFirst({ where: { payrollCycleId: off.id }, include: { lines: true } })
  check('it runs without an attendance lock and pays only the input (15,000)', r.status === 200 && r.body.processed === 1 && Number(offSlip.netPay) === 15000 && Number(offSlip.grossEarnings) === 15000, { run: r.body?.processed, net: offSlip && Number(offSlip.netPay) })
  check('…with a warning that tax was not computed', JSON.stringify(r.body.warnings).includes('tax is not computed'), r.body.warnings)
  r = await api(asP1, 'POST', `/payroll/cycles/${off.id}/approve`)
  r = await api(asP1, 'POST', `/payroll/cycles/${off.id}/finance-approve`)
  check('the same two-admin approval applies to off-cycle runs (403 for the same person)', r.status === 403, r.status)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

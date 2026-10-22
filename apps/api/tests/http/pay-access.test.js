// Pay belongs to Payroll admins: HR admins never see salaries or run payroll. Every payroll needs approvals from two
// different Payroll admins; with only one, the second approval is refused with a clear message.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `px${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `PayAccess ${TAG}`, fullName: 'Hana Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const hrOwner = { token: r.body.accessToken } // hr_admin + system_admin
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { primaryCountry: 'ZM', baseCurrency: 'ZMW', modules: { set: [...new Set([...(tenant.modules ?? []), 'payroll', 'exits'])] } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first) => { const x = await api(hrOwner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time' }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }
  const p1 = await add('Pay'), p2 = await add('Paytwo'), worker = await add('Worker')
  for (const e of [p1, p2, worker]) if (!e.userId) { const u = await prisma.user.create({ data: { tenantId: tenant.id, email: `${e.id}@x.test` } }); await prisma.employee.update({ where: { id: e.id }, data: { userId: u.id } }); e.userId = u.id }
  const role = await prisma.role.findFirst({ where: { tenantId: tenant.id, name: 'payroll_admin' } })
  await prisma.userRole.create({ data: { userId: p1.userId, roleId: role.id } })
  const asP1 = as(p1, ['employee', 'payroll_admin']), asP2 = as(p2, ['employee', 'payroll_admin'])

  // ─── HR does not touch pay ─────────────────────────────────
  r = await api(hrOwner, 'POST', '/salary/structures/starter')
  check('HR cannot create salary structures (403)', r.status === 403, r.status)
  r = await api(asP1, 'POST', '/salary/structures/starter')
  const structure = r.body
  check('a Payroll admin creates the starter structure', r.status === 201, r.data)
  r = await api(hrOwner, 'POST', '/leave/contracts', { employeeId: worker.id, ctcAnnual: 180000, wageMonthly: 15000, currency: 'ZMW', effectiveFrom: '2025-01-06', salaryStructureId: structure.id })
  check('HR cannot create contracts (403)', r.status === 403, r.status)
  r = await api(asP1, 'POST', '/leave/contracts', { employeeId: worker.id, ctcAnnual: 180000, wageMonthly: 15000, currency: 'ZMW', effectiveFrom: '2025-01-06', salaryStructureId: structure.id })
  const contractId = r.body?.id
  check('a Payroll admin creates the contract', r.status === 201, r.data)
  for (const step of ['draft', 'confirm', 'activate']) await api(asP1, 'POST', `/leave/contracts/${contractId}/${step}`, {})
  r = await api(hrOwner, 'GET', `/employees/${worker.id}`)
  check('HR opens the profile without any pay', r.status === 200 && !r.body.contracts, Object.keys(r.body))
  r = await api(asP1, 'GET', `/employees/${worker.id}`)
  check('the Payroll admin sees the contract on the profile', r.body.contracts?.length === 1 && r.body.contracts[0].wageMonthly === 15000, r.body.contracts)
  r = await api(hrOwner, 'GET', `/leave/contracts/employee/${worker.id}`)
  check('HR cannot read contracts (404)', r.status === 404, r.status)
  r = await api(as(worker, ['employee']), 'GET', `/leave/contracts/employee/${worker.id}`)
  check('the employee reads their own contract', r.status === 200, r.status)
  r = await api(hrOwner, 'GET', '/salary/structures')
  check('HR cannot list salary structures (403)', r.status === 403, r.status)
  r = await api(hrOwner, 'GET', `/employees/${worker.id}/360`)
  check('the 360 view hides pay from HR', r.status !== 200 || r.body.can?.seePay === false, r.body?.can)

  // ─── Payroll: two different Payroll admins ────────────────
  const month = '2029-07'
  r = await api(hrOwner, 'POST', '/payroll/cycles', { payPeriodStart: `${month}-01`, payPeriodEnd: `${month}-31` })
  check('HR cannot start a payroll (403)', r.status === 403, r.status)
  r = await api(asP1, 'POST', '/payroll/cycles', { payPeriodStart: `${month}-01`, payPeriodEnd: `${month}-31` })
  const cycle = r.body
  check('a Payroll admin starts the payroll', r.status === 201, r.data)
  r = await api(hrOwner, 'GET', '/payroll/cycles')
  check('HR cannot see payroll cycles (403)', r.status === 403, r.status)
  await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
  r = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/run`)
  check('…runs it', r.status === 200, r.data)
  r = await api(asP1, 'GET', `/payroll/cycles/${cycle.id}`)
  check('the cycle says how many Payroll admins there are (1)', r.body.payrollAdmins === 1, r.body?.payrollAdmins)
  r = await api(hrOwner, 'POST', `/payroll/cycles/${cycle.id}/approve`)
  check('HR cannot approve payroll (403)', r.status === 403, r.status)
  r = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/approve`)
  check('the Payroll admin gives the first approval', r.status === 200, r.data)
  r = await api(asP1, 'POST', `/payroll/cycles/${cycle.id}/finance-approve`)
  check('…but not the second; the message says a second Payroll admin is needed (403)', r.status === 403 && /different Payroll admin/.test(r.data.message), r.data)
  r = await api(hrOwner, 'GET', '/company/setup-status')
  check('Next steps asks for two Payroll admins', r.body.steps.find((s) => s.key === 'payrollAdmin')?.done === false && /Only one/.test(r.body.steps.find((s) => s.key === 'payrollAdmin').detail), r.body?.steps?.find((s) => s.key === 'payrollAdmin'))
  await prisma.userRole.create({ data: { userId: p2.userId, roleId: role.id } })
  r = await api(asP2, 'POST', `/payroll/cycles/${cycle.id}/finance-approve`)
  check('a second Payroll admin gives the second approval', r.status === 200, r.data)
  r = await api(hrOwner, 'GET', '/reports/run/payroll')
  check('HR cannot run the payroll report', r.status === 403 || r.status === 404, r.status)
  r = await api(hrOwner, 'GET', '/dashboard')
  check('the HR dashboard has no payroll section', r.status === 200 && !r.body.payroll, Object.keys(r.body ?? {}))

  // ─── Exits: HR runs it, Payroll sees and settles the money ─
  const ownerUser = await prisma.user.findFirst({ where: { tenantId: tenant.id, email: ownerEmail } })
  const facil = await add('Facil'); const fu = { id: facil.userId }
  const founder = await prisma.employee.findFirst({ where: { tenantId: tenant.id, userId: ownerUser.id } })
  await prisma.employee.update({ where: { id: worker.id }, data: { managerId: founder.id } })
  r = await api(hrOwner, 'POST', '/exits', { employeeId: worker.id, exitType: 'resignation', noticeDate: '2029-07-01', lastWorkingDate: '2029-07-31', reason: 'Moving', clearance: { IT: fu.id, FINANCE: p1.userId, ADMIN: p2.userId } })
  const exit = r.body
  check('HR starts an exit', r.status === 201, r.data)
  if (exit?.id) {
    r = await api(hrOwner, 'POST', `/exits/${exit.id}/compute`, {})
    check('HR cannot compute the settlement (403)', r.status === 403, r.status)
    await prisma.employeeExit.update({ where: { id: exit.id }, data: { netPayable: 1234, totalEarnings: 1234, totalDeductions: 0 } })
    r = await api(hrOwner, 'GET', `/exits/${exit.id}`)
    check('HR sees the exit without the settlement amounts', r.status === 200 && r.body.netPayable === null && r.body.lines === null, r.body?.netPayable)
    r = await api(asP1, 'GET', `/exits/${exit.id}`)
    check('the Payroll admin sees the amounts', r.body.netPayable === 1234, r.body?.netPayable)
  }

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

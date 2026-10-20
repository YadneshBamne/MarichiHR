// Fresh-company usability fixes: founder leave on sign-up, the Next steps checklist, the starter salary structure that
// pays correctly, payroll's HR admin + Payroll admin steps, System admins opening profiles, skip-level approvals and the
// first-year guard on leave year end.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `us${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Usable ${TAG}`, fullName: 'Una Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  const founder = await prisma.employee.findFirst({ where: { tenantId: tenant.id } })
  const sick = await prisma.leaveType.findFirst({ where: { tenantId: tenant.id, code: 'SICK' } })
  let fb = null
  for (let i = 0; i < 30 && !(fb?.balanceDays > 0); i++) { fb = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId: { employeeId: founder.id, leaveTypeId: sick.id } } }); if (!(fb?.balanceDays > 0)) await sleep(500) }
  check('the founder has Sick leave right after sign-up', fb?.balanceDays > 0, fb)

  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, managerId) => { const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time', ...(managerId && { managerId }) }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }

  // ─── Next steps ────────────────────────────────────────────
  r = await api(owner, 'GET', '/company/setup-status')
  const step = (k) => r.body.steps.find((s) => s.key === k)
  check('Next steps lists what payroll still needs', r.status === 200 && step('structure') && !step('structure').done && !step('payrollAdmin').done && step('contracts').to.includes('contracts'), r.body?.steps?.map((s) => s.key))
  check('…and counts only required steps', r.body.total === r.body.steps.filter((s) => !s.optional).length && r.body.done < r.body.total)

  // ─── Starter structure that pays ───────────────────────────
  await api(owner, 'PATCH', '/company', { primaryCountry: 'ZM', baseCurrency: 'ZMW' })
  r = await api(owner, 'GET', '/salary/structures/starter')
  check('the starter for Zambia uses NAPSA, NHIMA and PAYE', r.status === 200 && r.body.country === 'ZM' && ['NAPSA_EMP', 'NHIMA_EMP', 'PAYE_ZM', 'NET'].every((c) => r.body.rules.some((x) => x.code === c)), r.body)
  r = await api(owner, 'POST', '/salary/structures/starter')
  const structure = r.body
  check('HR creates it in one click', r.status === 201 && structure.code === 'ZM-MONTHLY-STARTER', r.data)
  r = await api(owner, 'POST', '/salary/structures/starter')
  check('…once (409)', r.status === 409, r.status)

  const boss = await add('Boss'), lead = await add('Lead'), member = await add('Member')
  await prisma.employee.update({ where: { id: lead.id }, data: { managerId: boss.id } })
  await prisma.employee.update({ where: { id: member.id }, data: { managerId: lead.id } })
  const c = await api(owner, 'POST', '/leave/contracts', { employeeId: member.id, ctcAnnual: 180000, wageMonthly: 15000, currency: 'ZMW', effectiveFrom: '2025-01-06', salaryStructureId: structure.id })
  for (const step of ['draft', 'confirm', 'activate']) await api(owner, 'POST', `/leave/contracts/${c.body.id}/${step}`, {})
  const month = new Date().toISOString().slice(0, 7)
  const last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).toISOString().slice(0, 10)
  r = await api(owner, 'POST', '/payroll/cycles', { payPeriodStart: `${month}-01`, payPeriodEnd: last })
  const cycle = r.body
  await api(owner, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
  r = await api(owner, 'POST', `/payroll/cycles/${cycle.id}/run`)
  const slip = await prisma.payslip.findFirst({ where: { payrollCycleId: cycle.id, employeeId: member.id }, include: { lines: true } })
  const line = (code) => Number(slip?.lines.find((l) => l.code === code)?.amount ?? NaN)
  check('the starter structure pays: gross = wage, tax and contributions deducted, net below gross', slip && Math.abs(line('GROSS') - 15000) < 1 && line('PAYE_ZM') > 0 && line('NAPSA_EMP') > 0 && Number(slip.netPay) > 0 && Number(slip.netPay) < 15000, slip && { gross: line('GROSS'), paye: line('PAYE_ZM'), napsa: line('NAPSA_EMP'), net: Number(slip.netPay) })

  // ─── Payroll needs an HR admin and a Payroll admin ─────────
  const payrollPerson = await add('Pay')
  const asPayroll = as(payrollPerson, ['employee', 'payroll_admin'])
  r = await api(asPayroll, 'POST', `/payroll/cycles/${cycle.id}/approve`)
  check('a Payroll admin cannot give the HR approval (403)', r.status === 403 && /HR admin/.test(r.data.message), r.data)
  r = await api(owner, 'POST', `/payroll/cycles/${cycle.id}/approve`)
  check('the HR admin approves', r.status === 200, r.data)
  r = await api(owner, 'POST', `/payroll/cycles/${cycle.id}/finance-approve`)
  check('an HR admin cannot give the finance approval; the message says who can (403)', r.status === 403 && /Payroll admin/.test(r.data.message), r.data)
  r = await api(asPayroll, 'POST', `/payroll/cycles/${cycle.id}/finance-approve`)
  check('the Payroll admin gives the finance approval', r.status === 200, r.data)

  // ─── System admin opens profiles to manage logins ──────────
  const sys = await add('Sys')
  const asSys = as(sys, ['employee', 'system_admin'])
  r = await api(asSys, 'GET', `/employees/${member.id}`)
  check('a System admin (without HR) opens a profile', r.status === 200 && r.body.id === member.id, r.status)
  check('…without pay or bank details', !('contracts' in r.body && r.body.contracts?.length) && !('bankAccountLast4' in r.body), Object.keys(r.body))
  r = await api(asSys, 'GET', `/employees/${member.id}/access`)
  check('…and reaches Login & access', r.status === 200, r.status)

  // ─── Skip-level approval ───────────────────────────────────
  await api(owner, 'POST', '/system/jobs/leave-accrual/run')
  const day = new Date(Date.now() + 14 * 86_400_000); while ([0, 6].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() + 1)
  const ymd = day.toISOString().slice(0, 10)
  r = await api(as(member, ['employee']), 'POST', '/leave/requests', { leaveTypeId: sick.id, startDate: ymd, endDate: ymd, reason: 'Check-up' })
  const leaveId = r.body?.id
  check('the member applies for a sick day', r.status === 201, r.data)
  const stranger = await add('Stranger')
  r = await api(as(stranger, ['employee', 'manager']), 'POST', `/leave/requests/${leaveId}/approve`, { comments: 'no' })
  check('a manager from another line cannot approve (403)', r.status === 403, r.status)
  r = await api(as(boss, ['employee', 'manager']), 'POST', `/leave/requests/${leaveId}/approve`, { comments: 'Skip-level OK' })
  check('the manager two levels up can approve (skip-level)', r.status === 200, r.data)

  // ─── Year end in the first year ────────────────────────────
  r = await api(owner, 'GET', '/leave/year-end')
  check('a first-year company sees "nothing to close yet"', r.status === 200 && r.body.firstYear === true && !!r.body.nextYearEnd, r.body?.firstYear)
  r = await api(owner, 'POST', '/leave/year-end/run')
  check('…and cannot close a year it never had (400)', r.status === 400, r.data)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

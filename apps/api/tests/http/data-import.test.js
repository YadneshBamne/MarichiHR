// Imports for people already in the company: leave balances, bank details (encrypted, unverified) and contracts
// (running or confirmed by start date). Dry run lists every problem; real runs are all or nothing. Throwaway company.
const { Redis } = require('ioredis')
const { api, check, done, prisma, withRoles } = require('./lib')

const TAG = `di${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })

;(async () => {
  const keys = await redis.keys('signup:*'); if (keys.length) await redis.del(...keys)
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `DataImp ${TAG}`, fullName: 'Dee Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  r = await api(owner, 'POST', '/employees/import', { rows: [
    { first_name: 'Ana', last_name: 'One', work_email: `ana.${TAG}@example.com`, hire_date: '2025-01-01', department: 'Ops' },
    { first_name: 'Ben', last_name: 'Two', work_email: `ben.${TAG}@example.com`, hire_date: '2025-01-01', department: 'Ops' },
  ], dryRun: false, createMissing: true })
  const [ana, ben] = r.body.rows
  check('two people to import data for', r.body.created === 2, r.data)
  const annual = await prisma.leaveType.findFirst({ where: { tenantId: tenant.id, active: true }, orderBy: { name: 'asc' } })
  // New people get their leave credited in the background (employee.created); let that land before importing over it
  for (let i = 0; i < 40 && !(await prisma.leaveAllocation.count({ where: { employeeId: { in: [ana.employeeId, ben.employeeId] }, approvedBy: 'system' } })); i++) await new Promise((res) => setTimeout(res, 500))

  // ─── Leave balances ────────────────────────────────────────
  r = await api(owner, 'POST', '/employees/import/leave_balances', { rows: [
    { employee_id: ana.employeeCode, leave_type: annual.name.toUpperCase(), balance_days: '12', used_days: '2' },
    { employee_id: 'NOBODY', leave_type: 'Nope', balance_days: 'x' },
    { employee_id: ana.employeeCode, leave_type: annual.code, balance_days: '5' },
  ], dryRun: true })
  const lb = r.body?.rows ?? []
  check('dry run: unknown person, leave type and bad number are listed', lb[1]?.errors.length >= 3, r.data)
  check('dry run: the same person + leave type twice is caught', lb[2]?.errors.some((e) => /row 2/.test(e)), lb[2]?.errors)
  r = await api(owner, 'POST', '/employees/import/leave_balances', { rows: [{ employee_id: ana.employeeCode, leave_type: annual.name, balance_days: '12', used_days: '2' }, { employee_id: 'NOBODY', leave_type: 'x', balance_days: '1' }], dryRun: false })
  check('a file with an error writes nothing', r.body.created === 0 && !(await prisma.leaveBalance.findFirst({ where: { employeeId: ana.employeeId, leaveTypeId: annual.id, balanceDays: 12 } })))
  r = await api(owner, 'POST', '/employees/import/leave_balances', { rows: [{ employee_id: `ana.${TAG}@example.com`, leave_type: annual.name, balance_days: '12', used_days: '2' }], dryRun: false })
  const bal = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId: { employeeId: ana.employeeId, leaveTypeId: annual.id } } })
  check('balances import by work email (12 given, 2 used)', r.body.created === 1 && bal.balanceDays === 12 && bal.usedDays === 2, bal)

  // ─── Bank details ──────────────────────────────────────────
  r = await api(owner, 'POST', '/employees/import/bank_details', { rows: [{ employee_id: ana.employeeCode, bank: 'zanaco', account_number: '12-3456-7890' }, { employee_id: ben.employeeCode, bank: 'Imaginary Bank', account_number: '12' }], dryRun: true })
  check('bank: unknown bank and short account number are errors', r.body.rows[1].errors.length === 2 && r.body.rows[0].status === 'ok', r.body.rows)
  r = await api(owner, 'POST', '/employees/import/bank_details', { rows: [{ employee_id: ana.employeeCode, bank: 'Zanaco', account_number: '1234567890', ifsc_swift: 'ZNCOZMLU' }], dryRun: false })
  const anaRow = await prisma.employee.findUnique({ where: { id: ana.employeeId }, select: { bankName: true, bankAccountNo: true, bankVerified: true } })
  check('bank details are stored encrypted and unverified', r.body.created === 1 && anaRow.bankName === 'zanaco' && anaRow.bankAccountNo && !anaRow.bankAccountNo.includes('1234567890') && !anaRow.bankVerified, { ...anaRow, bankAccountNo: '…' })
  r = await api(owner, 'GET', `/employees/${ana.employeeId}`)
  check('the API shows only the last 4 digits', r.body.bankAccountLast4 === '7890' && !JSON.stringify(r.body).includes('1234567890'))

  // ─── Contracts ─────────────────────────────────────────────
  const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 2, 1)
  // Contracts are pay: only Payroll admins import them
  r = await api(owner, 'POST', '/employees/import/contracts', { rows: [{ employee_id: 'X', wage_monthly: '1', currency: 'ZMW', effective_from: '2025-01-01' }], dryRun: true })
  check('an HR admin cannot import contracts (403)', r.status === 403, r.status)
  const payroll = withRoles(owner, 'payroll_admin')
  r = await api(payroll, 'POST', '/employees/import/contracts', { rows: [
    { employee_id: ana.employeeCode, wage_monthly: '10,000', currency: 'zmw', effective_from: '01/01/2025' },
    { employee_id: ben.employeeCode, wage_monthly: '9000', ctc_annual: '100', currency: 'ZM', effective_from: '2025-13-01', salary_structure: 'Nope' },
  ], dryRun: true })
  check('contracts: CTC, currency, date and structure problems are listed', r.body.rows[1].errors.length >= 4 && r.body.rows[0].status === 'ok', r.body.rows)
  r = await api(payroll, 'POST', '/employees/import/contracts', { rows: [
    { employee_id: ana.employeeCode, wage_monthly: '10,000', currency: 'zmw', effective_from: '01/01/2025' },
    { employee_id: ben.employeeCode, wage_monthly: '9000', currency: 'ZMW', effective_from: next.toISOString().slice(0, 10), notice_days: '60' },
  ], dryRun: false })
  const cs = await prisma.employeeContract.findMany({ where: { employeeId: { in: [ana.employeeId, ben.employeeId] } } })
  const ca = cs.find((c) => c.employeeId === ana.employeeId), cb = cs.find((c) => c.employeeId === ben.employeeId)
  check('a past start is running, a future one confirmed; CTC defaults to 12 × wage', r.body.created === 2 && ca?.status === 'running' && Number(ca.ctcAnnual) === 120000 && cb?.status === 'confirmed' && cb.noticePeriodDays === 60, r.data)
  r = await api(payroll, 'POST', '/employees/import/contracts', { rows: [{ employee_id: ana.employeeCode, wage_monthly: '11000', currency: 'ZMW', effective_from: '2026-01-01' }], dryRun: true })
  check('someone with an open contract is sent to revisions instead', r.body.rows[0].errors.some((e) => /open contract/.test(e)), r.body.rows[0].errors)

  // ─── Access ────────────────────────────────────────────────
  r = await api(owner, 'POST', '/employees/import/payslips', { rows: [{ employee_id: 'x' }], dryRun: true })
  check('unknown import type (400)', r.status === 400, r.status)
  await api(owner, 'PUT', `/employees/${ben.employeeId}/access`, { roles: ['employee'], password: 'Ben-pass-12345', loginEnabled: true })
  const benLogin = await api(null, 'POST', '/auth/login', { email: `ben.${TAG}@example.com`, password: 'Ben-pass-12345' })
  r = await api({ token: benLogin.body.accessToken }, 'POST', '/employees/import/contracts', { rows: [{ employee_id: 'x' }], dryRun: true })
  check('an employee cannot import (403)', r.status === 403, r.status)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  await redis.quit()
  await done()
})()

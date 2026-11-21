// Exits and full & final settlement on the MongoDB API: initiate, clearances, compute (salary, reimbursement, leave encashment, notice,
// gratuity), maker-checker approval, payment that closes the claim, contract and login. Also that payroll pays an approved claim.
// Removes its company at the end.
//   API=http://localhost:4210 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-exits.test.js
const mongoose = require('mongoose')
const API = (process.env.API || 'http://localhost:4200') + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const iso = (d) => d.toISOString().slice(0, 10)
const daysAgo = (n) => new Date(Date.now() - n * 86400000)
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const stamp = Date.now(), email = `xt${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Exit Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken // hr_admin + system_admin
    await call('PUT', '/company/plan', owner, { plan: 'growth', addons: ['expenses'] })
    await call('PUT', '/company/modules', owner, { modules: ['payroll', 'leave', 'exits', 'expenses'] })
    await call('PATCH', '/company', owner, { primaryCountry: 'ZM', baseCurrency: 'ZMW' })
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2024-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), danielId = await mk('Daniel', 'Zulu'), fionaId = await mk('Fiona', 'Phiri'), ginaId = await mk('Gina', 'Tembo'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const daniel = await login(owner, danielId, `daniel${stamp}@example.com`, ['manager'])
    const fiona = await login(owner, fionaId, `fiona${stamp}@example.com`, ['payroll_admin'])
    const gina = await login(owner, ginaId, `gina${stamp}@example.com`, ['payroll_admin'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danielId } })
    await sleep(1500) // leave credits

    // salary and Mary's contract
    const starter = await call('POST', '/salary/structures/starter', fiona)
    const structureId = starter.data.id || starter.data.structure?.id
    const ct = await call('POST', '/leave/contracts', fiona, { employeeId: maryId, ctcAnnual: 120000, wageMonthly: 10000, currency: 'ZMW', effectiveFrom: '2024-01-01', salaryStructureId: structureId })
    for (const step of ['draft', 'confirm', 'activate']) await call('POST', `/leave/contracts/${ct.data.id}/${step}`, fiona, {})
    // an approved claim that the settlement should pay
    const cats = (await call('GET', '/expenses/categories', mary)).data
    const cl = await call('POST', '/expenses/claims', mary, { claimType: 'actual', categoryId: cats.find((c) => c.code === 'TRAVEL').id, expenseDate: iso(daysAgo(2)), description: 'Taxi', receiptNumber: 'R-9', expenseCurrency: 'ZMW', expenseAmount: 150 })
    await call('POST', `/expenses/claims/${cl.data.id}/approve`, daniel, {})
    await call('POST', `/expenses/claims/${cl.data.id}/finance-approve`, fiona, {})

    const uid = {}
    for (const [k, v] of Object.entries({ gina: ginaId, fiona: fionaId, paul: paulId })) uid[k] = (await db.collection('employees').findOne({ _id: v })).userId
    // ── initiate
    const lwd = iso(new Date(Date.now() + 10 * 86400000))
    const body = { employeeId: maryId, exitType: 'resignation', reason: 'Moving abroad', noticeDate: iso(daysAgo(40)), lastWorkingDate: lwd, clearance: { IT: uid.gina, FINANCE: uid.fiona, ADMIN: uid.paul } }
    check((await call('POST', '/exits', mary, body)).status === 403, 'an employee cannot start an exit')
    check((await call('POST', '/exits', fiona, body)).status === 403, 'payroll admins do not start exits: HR does')
    const ex = await call('POST', '/exits', owner, body)
    check(ex.status === 201, `HR initiates Mary's exit (${short(ex)})`)
    const id = ex.data.id
    check((await call('POST', '/exits', owner, body)).status >= 400, 'a second open exit for the same person is refused')
    check((await call('GET', '/exits', mary)).status === 403, 'employees cannot list exits')
    const ls = await call('GET', '/exits', owner)
    check(ls.status === 200 && ls.data.length === 1, 'HR lists exits')
    const noPay = await call('GET', `/exits/${id}`, owner)
    check(noPay.status === 200 && noPay.data.netPayable == null, 'HR sees the exit but not the settlement amounts')
    check((await call('GET', '/exits/assignable-users', owner)).status === 200, 'assignable users for sign-offs')

    // ── clearances, F&F blocked until they are signed
    check((await call('POST', `/exits/${id}/compute`, fiona, {})).status === 400, 'F&F is blocked while clearances are pending')
    const mine = await call('GET', '/exits/clearances/mine', gina)
    check(mine.status === 200 && mine.data.length >= 1, 'Gina sees her clearance task')
    check((await call('POST', `/exits/${id}/clearances/IT/sign`, paul, {})).status >= 400, 'Paul cannot sign the IT clearance')
    check((await call('POST', `/exits/${id}/clearances/IT/sign`, gina, { note: 'Laptop returned' })).status === 200, 'Gina signs IT')
    check((await call('POST', `/exits/${id}/clearances/FINANCE/sign`, fiona, {})).status === 200, 'Fiona signs Finance')
    check((await call('POST', `/exits/${id}/clearances/ADMIN/sign`, paul, {})).status === 200, 'Paul signs Admin')
    check((await call('POST', `/exits/${id}/clearances/MANAGER/sign`, daniel, {})).status === 200, "Daniel signs as Mary's manager")

    // ── compute (payroll admin), approve (a different one), pay
    check((await call('POST', `/exits/${id}/compute`, owner, {})).status === 403, 'HR cannot compute the settlement')
    const cp = await call('POST', `/exits/${id}/compute`, fiona, { recoveries: [{ description: 'Phone loan', amount: 200 }] })
    check(cp.status === 200 && cp.data.status === 'computed', `Fiona computes (${short(cp)})`)
    const lines = cp.data.lines ?? []
    check(lines.some((l) => l.section === 'reimbursement' && l.amount === 150), 'the approved 150 ZMW claim is in the settlement')
    check(lines.some((l) => l.section === 'salary'), 'prorated final salary lines are in')
    check(lines.some((l) => l.section === 'encashment'), 'leave encashment is in')
    check(lines.some((l) => l.section === 'recovery' && l.amount === 200), 'the recovery is a deduction')
    check(cp.data.netPayable > 0 && cp.data.netPayable === Math.round((cp.data.totalEarnings - cp.data.totalDeductions) * 100) / 100, `net payable ${cp.data.netPayable} = earnings - deductions`)
    check((await call('POST', `/exits/${id}/approve`, fiona, {})).status === 403, 'the person who computed cannot approve')
    check((await call('POST', `/exits/${id}/pay`, gina, {})).status >= 400, 'it cannot be paid before approval')
    check((await call('POST', `/exits/${id}/approve`, gina, {})).status === 200, 'Gina approves')
    const pay = await call('POST', `/exits/${id}/pay`, gina, {})
    check(pay.status === 200 && pay.data.status === 'paid', `Gina pays (${short(pay)})`)
    const claim = await db.collection('reimbursement_claims').findOne({ _id: cl.data.id })
    check(claim.status === 'paid', 'the claim is marked paid')
    const emp = await db.collection('employees').findOne({ _id: maryId })
    check(emp.active === false || emp.employmentStatus === 'terminated', `Mary is archived (${emp.employmentStatus}, active=${emp.active})`)
    check((await call('POST', `/exits/${id}/pay`, gina, {})).status >= 400, 'a paid settlement is immutable')
    const pdf = await fetch(`${API}/exits/${id}/settlement.pdf`, { headers: { Authorization: `Bearer ${gina}` } })
    check([200, 503].includes(pdf.status), `the settlement PDF answers (${pdf.status})`)
    check((await call('POST', '/auth/login', null, { email: `mary${stamp}@example.com`, password: 'Fresh-pass-77x' })).status >= 400, "Mary's login no longer works")
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      const ids = emps.map((e) => e._id)
      for (const c of ['leave_balances', 'leave_requests', 'leave_allocations']) await db.collection(c).deleteMany({ employeeId: { $in: ids } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

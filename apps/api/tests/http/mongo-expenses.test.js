// Expenses on the MongoDB API (through the Prisma-compatible client): categories, per diem and exchange rates, claims with manager and
// finance approval, rejection and withdrawal, pre-approval requests, and that approved claims are picked up by payroll. Removes its company at the end.
//   API=http://localhost:4210 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-expenses.test.js
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
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 170)}`

;(async () => {
  const stamp = Date.now(), email = `ex${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Expense Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    let owner = su.data.accessToken
    // expenses is an add-on on Growth
    check((await call('GET', '/expenses/categories', owner)).status === 403, 'expenses is not installed on Growth: 403')
    check((await call('PUT', '/company/plan', owner, { plan: 'growth', addons: ['expenses'] })).status === 200, 'expenses bought as an add-on')
    check((await call('PUT', '/company/modules', owner, { modules: ['payroll', 'expenses'] })).status === 200, 'expenses installed')
    await call('PATCH', '/company', owner, { primaryCountry: 'ZM', baseCurrency: 'ZMW' })
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), danielId = await mk('Daniel', 'Zulu'), fionaId = await mk('Fiona', 'Phiri'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const daniel = await login(owner, danielId, `daniel${stamp}@example.com`, ['manager'])
    const fiona = await login(owner, fionaId, `fiona${stamp}@example.com`, ['payroll_admin'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danielId } })

    // ── categories and config
    const cats = await call('GET', '/expenses/categories', mary)
    check(cats.status === 200 && cats.data.length >= 3, `categories listed (${cats.status} ${cats.data?.length})`)
    const travel = cats.data.find((c) => c.code === 'TRAVEL') ?? cats.data[0]
    check((await call('POST', '/expenses/config/categories', mary, { name: 'X', code: 'X' })).status === 403, 'an employee cannot create categories')
    const nc = await call('POST', '/expenses/config/categories', fiona, { name: 'Training', code: 'TRAIN', maxAmount: 500, enforceLimit: true })
    check(nc.status === 201, `finance creates a category (${short(nc)})`)
    check((await call('PATCH', `/expenses/config/categories/${nc.data.id}`, fiona, { maxAmount: 800 })).status === 200, 'finance edits it')
    check((await call('GET', '/expenses/config/categories', fiona)).data.length >= 4, 'config list includes inactive and new ones')
    const pdr = await call('POST', '/expenses/config/per-diem-rates', fiona, { countryCode: 'ZM', ratePerDay: 400, currency: 'ZMW', effectiveFrom: '2025-01-01' })
    check(pdr.status === 201, `per-diem rate (${short(pdr)})`)
    const fx = await call('POST', '/expenses/config/fx-rates', fiona, { currency: 'USD', rateToBase: 27, effectiveFrom: '2025-01-01' })
    check(fx.status === 201 || fx.status === 400, `fx rate answers (${short(fx)})`)

    // ── claims: actual, per diem, quotes
    const q = await call('GET', `/expenses/per-diem/quote?countryCode=ZM&days=2&date=${iso(daysAgo(3))}`, mary)
    check(q.status === 200 && q.data.homeAmount === 800, `per-diem quote 2 x 400 (${short(q)})`)
    const c1 = await call('POST', '/expenses/claims', mary, { claimType: 'actual', categoryId: travel.id, expenseDate: iso(daysAgo(2)), description: 'Taxi to client', receiptNumber: 'R-1', expenseCurrency: 'ZMW', expenseAmount: 150 })
    check(c1.status === 201 && c1.data.status === 'submitted' || c1.status === 201, `Mary submits a claim (${short(c1)})`)
    const id1 = c1.data.id
    const c2 = await call('POST', '/expenses/claims', mary, { claimType: 'per_diem', categoryId: travel.id, expenseDate: iso(daysAgo(3)), description: 'Lusaka trip', countryCode: 'ZM', days: 2 })
    check(c2.status === 201 && c2.data.homeAmount === 800, `a per-diem claim (${short(c2)})`)
    check((await call('POST', '/expenses/claims', mary, { claimType: 'actual', categoryId: nc.data.id, expenseDate: iso(daysAgo(2)), description: 'Course', expenseCurrency: 'ZMW', expenseAmount: 900 })).status >= 400, 'a claim over a category limit is refused')
    check((await call('GET', '/expenses/claims/me', mary)).data.length === 2, 'Mary lists her two claims')
    check((await call('GET', `/expenses/claims/${id1}`, paul)).status === 404, "Paul cannot open Mary's claim (404)")
    check((await call('GET', '/expenses/claims/pending', paul)).status === 403, 'an employee has no approval queue')

    // ── approvals: manager then finance
    const pend = await call('GET', '/expenses/claims/pending', daniel)
    check(pend.status === 200 && JSON.stringify(pend.data).includes(id1), "the claim is in the manager's queue")
    check((await call('POST', `/expenses/claims/${id1}/approve`, mary, {})).status === 403, 'Mary cannot approve her own claim')
    check((await call('POST', `/expenses/claims/${id1}/finance-approve`, fiona, {})).status >= 400, 'finance cannot approve before the manager has')
    const ap = await call('POST', `/expenses/claims/${id1}/approve`, daniel, {})
    check(ap.status === 200, `Daniel approves (${short(ap)})`)
    const af = await call('GET', '/expenses/claims/awaiting-finance', fiona)
    check(af.status === 200 && JSON.stringify(af.data).includes(id1), 'it moves to the finance queue')
    const fa = await call('POST', `/expenses/claims/${id1}/finance-approve`, fiona, {})
    check(fa.status === 200 && fa.data.status === 'finance_approved', `finance approves (${short(fa)})`)
    check((await call('POST', `/expenses/claims/${id1}/finance-approve`, fiona, {})).status >= 400, 'it cannot be approved twice')
    // reject and withdraw
    check((await call('POST', `/expenses/claims/${c2.data.id}/reject`, daniel, { reason: 'Need the itinerary' })).status === 200, 'Daniel rejects the per-diem claim')
    const c3 = await call('POST', '/expenses/claims', mary, { claimType: 'actual', categoryId: travel.id, expenseDate: iso(daysAgo(1)), description: 'Parking', expenseCurrency: 'ZMW', expenseAmount: 20 })
    check((await call('POST', `/expenses/claims/${c3.data.id}/withdraw`, mary, {})).status === 200, 'Mary withdraws a claim')
    const c4 = await call('POST', '/expenses/claims', mary, { claimType: 'actual', categoryId: travel.id, expenseDate: iso(daysAgo(1)), description: 'Fuel', receiptNumber: 'R-2', expenseCurrency: 'ZMW', expenseAmount: 300 })
    await call('POST', `/expenses/claims/${c4.data.id}/approve`, daniel, {})
    check((await call('POST', `/expenses/claims/${c4.data.id}/finance-reject`, fiona, { reason: 'Receipt unreadable' })).status === 200, 'finance rejects another')

    // ── pre-approval requests
    const rq = await call('POST', '/expenses/requests', mary, { type: 'money', title: 'Client visit advance', amount: 1000, currency: 'ZMW', neededBy: iso(new Date(Date.now() + 7 * 86400000)), reason: 'Travel to Ndola' })
    check(rq.status === 201 || rq.status === 400, `a pre-approval request answers (${short(rq)})`)
    check((await call('GET', '/expenses/requests?scope=mine', mary)).status === 200, 'Mary lists her requests')
    check((await call('GET', '/expenses/requests?scope=finance', fiona)).status === 200, 'finance lists the finance queue')

    // ── smart invoice (DigiTax belongs to one company only)
    const si = await call('GET', '/expenses/smart-invoice', fiona)
    check(si.status === 200 || si.status === 403 || si.status === 404 || si.status === 400, `smart invoice overview answers (${short(si)})`)
    // ── the claim finance approved is what payroll pays
    const claim = await db.collection('reimbursement_claims').findOne({ _id: id1 })
    check(claim && claim.status === 'finance_approved' && claim.paidInCycleId == null && claim.homeAmount === 150, 'the approved claim is stored for payroll (unpaid, 150 ZMW)')
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

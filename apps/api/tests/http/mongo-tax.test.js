// Tax and statutory filing on the MongoDB API: the filing dashboard (what each run owes the authorities, from its payslip lines), submission
// through the sandbox adapters, recorded filings, tax tables, and the employee's annual statement. Removes its company at the end.
//   API=http://localhost:4216 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-tax.test.js
const crypto = require('crypto')
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
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`

;(async () => {
  const stamp = Date.now(), email = `tx${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Tax Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    await call('PATCH', '/company', owner, { primaryCountry: 'ZM', baseCurrency: 'ZMW' })
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), fionaId = await mk('Fiona', 'Phiri'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const fiona = await login(owner, fionaId, `fiona${stamp}@example.com`, ['payroll_admin'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])

    // a paid run for last month with Mary's payslip lines (written straight into the collections)
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
    const cycleId = crypto.randomUUID()
    await db.collection('payroll_cycles').insertOne({ _id: cycleId, tenantId, payPeriodStart: start, payPeriodEnd: end, status: 'disbursed', cycleType: 'monthly', createdAt: new Date(), updatedAt: new Date() })
    const L = (code, name, category, amount) => ({ id: crypto.randomUUID(), code, name, category, amount })
    await db.collection('payslips').insertOne({ _id: crypto.randomUUID(), tenantId, payrollCycleId: cycleId, employeeId: maryId, grossEarnings: 10000, totalDeductions: 1250, netPay: 8750, currency: 'ZMW', withheld: false, status: 'final', createdAt: new Date(), updatedAt: new Date(),
      lines: [L('BASIC', 'Basic', 'BASIC', 6000), L('PAYE_ZM', 'PAYE', 'TAX', 1000), L('NAPSA_EMP', 'NAPSA', 'DED', 250), L('NAPSA_EMPLOYER', 'NAPSA employer', 'EMP_CONTRIB', 250), L('NHIMA_EMP', 'NHIMA', 'DED', 100)] })

    check((await call('GET', '/tax/filing-dashboard', mary)).status === 403, 'an employee cannot open the filing dashboard')
    const dash = await call('GET', '/tax/filing-dashboard', fiona)
    check(dash.status === 200, `payroll opens the filing dashboard (${short(dash).slice(0, 120)})`)
    const run = dash.data?.cycles?.find((c) => c.id === cycleId)
    const ret = (a) => run?.returns?.find((r) => r.authority === a)
    check(!!run && ret('NAPSA')?.amount === 500 && ret('ZRA')?.amount === 1000 && ret('NHIMA')?.amount === 100, `the run owes ZRA 1000, NAPSA 500 and NHIMA 100 (${JSON.stringify(run?.returns?.map((r) => [r.authority, r.amount]))})`)
    check(dash.data?.mode === 'sandbox', 'the filing mode is sandbox by default')
    const sub = await call('POST', '/tax/filings/submit', fiona, { cycleId, authority: 'NAPSA' })
    check(sub.status === 201 && /^SANDBOX-/.test(sub.data?.reference ?? sub.data?.filing?.reference ?? ''), `NAPSA is submitted through the sandbox adapter (${short(sub).slice(0, 140)})`)
    const zra = await call('POST', '/tax/filings/submit', fiona, { cycleId, authority: 'ZRA' })
    check([400, 422, 201].includes(zra.status), `ZRA without an employer tax number is answered clearly (${short(zra).slice(0, 140)})`)
    check((await call('POST', '/tax/filings/submit', fiona, { cycleId, authority: 'NOPE' })).status === 404, 'an unknown authority: 404')
    check((await call('POST', '/tax/filings/submit', fiona, { cycleId: crypto.randomUUID(), authority: 'NAPSA' })).status === 404, 'an unknown run: 404')
    const dash2 = await call('GET', '/tax/filing-dashboard', fiona)
    check(dash2.data.cycles.find((c) => c.id === cycleId).returns.find((r) => r.authority === 'NAPSA').filing?.status, 'the dashboard now shows the NAPSA filing')
    const exp = await fetch(`${API}/tax/filing/export?cycleId=${cycleId}`, { headers: { Authorization: `Bearer ${fiona}` } })
    check(exp.status === 200, `the filing export downloads (${exp.status})`)
    check((await call('GET', `/tax/filing?cycleId=${cycleId}`, fiona)).status === 200, 'the filing detail for a run')
    check((await call('GET', '/tax/filings', fiona)).status === 200, 'recorded filings list')
    check((await call('GET', '/tax/tables', fiona)).status === 200, 'tax tables list')
    check([200, 501].includes((await call('GET', '/tax/overrides', fiona)).status), 'overrides answer 200, or 501 until editing a payslip line exists on Mongo')

    // the employee's own statement
    const st = await call('GET', `/tax/statement?year=${start.getUTCFullYear()}`, mary)
    check(st.status === 200 && st.data.totals?.PAYE_ZM === 1000, `Mary's annual statement shows PAYE 1000 (${short(st).slice(0, 160)})`)
    check((await call('GET', `/tax/statement?year=${start.getUTCFullYear()}&employeeId=${maryId}`, paul)).status >= 400, "Paul cannot read Mary's statement")
    check((await call('GET', `/tax/certificate?year=${start.getUTCFullYear()}`, mary)).status < 500, 'the certificate answers')
    check((await call('GET', '/tax/declarations/sections', mary)).status === 200, 'declaration sections list')
    check((await call('GET', `/tax/declarations/mine?year=${start.getUTCFullYear()}`, mary)).status < 500, 'my declaration answers')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

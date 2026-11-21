// Drives the MongoDB API over HTTP like the web app does: sign up a company, set it up, add people, give a second Payroll admin
// a login, run a Zambia payroll with two approvals, and confirm unported features answer 501. Needs the API running in MongoDB
// mode (npm run dev:mongo) and the reference data copy done. Removes its company from Atlas at the end.
//   API=http://localhost:4100 node -r dotenv/config tests/http/mongo-flow.test.js     (DOTENV_CONFIG_PATH=.env)
const mongoose = require('mongoose')
const API = (process.env.API || 'http://localhost:4000') + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }

async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data }
}

;(async () => {
  const stamp = Date.now()
  const email = `owner${stamp}@example.com`, pw = 'Correct-horse-1'
  let tenantId
  try {
    // ── sign up, sign in, profile
    const su = await call('POST', '/auth/signup', null, { companyName: `Bimbe Test ${stamp}`, fullName: 'Grace Owner', email, password: pw })
    check(su.status === 201 && su.data.accessToken, `signup 201 (got ${su.status} ${JSON.stringify(su.body).slice(0, 120)})`)
    tenantId = su.data.user.tenant.id
    let owner = su.data.accessToken
    const me = await call('GET', '/auth/me', owner)
    check(me.status === 200 && me.data.employee.code === 'EMP0001' && me.data.roles.length === 3, 'GET /auth/me returns the owner with three roles')
    check((await call('POST', '/auth/login', null, { email, password: 'wrong-password-9' })).status === 401, 'wrong password is 401')
    check((await call('GET', `/auth/workspace/${su.data.workspace}`)).status === 200, 'workspace branding is public')
    check((await call('GET', '/employees')).status === 401, 'no token is 401')

    // ── company setup: country, installed apps
    check((await call('PATCH', '/company', owner, { primaryCountry: 'ZM', baseCurrency: 'ZMW' })).status === 200, 'company profile saved')
    const mods = await call('PUT', '/company/modules', owner, { modules: ['payroll'] })
    check(mods.status === 200 && mods.data.modules.join() === 'payroll', 'payroll app installed')
    // plans: new workspaces start on Growth; apps and features outside the plan are refused until the plan or add-ons change
    check(mods.data.plan === 'growth' && mods.data.entitlements.apps.join() === 'leave,attendance,payroll,exits', 'new workspace is on the Growth plan')
    const noExp = await call('PUT', '/company/modules', owner, { modules: ['payroll', 'expenses'] })
    check(noExp.status === 403 && noExp.body.code === 'NOT_IN_PLAN', 'expenses is not in Growth: 403 NOT_IN_PLAN')
    check((await call('GET', '/automation/api-keys', owner)).status === 403, 'API keys are not in Growth: 403')
    check((await call('PUT', '/company/plan', owner, { plan: 'gold', addons: [] })).status === 400, 'unknown plan is 400')
    const addon = await call('PUT', '/company/plan', owner, { plan: 'growth', addons: ['expenses', 'api'] })
    check(addon.status === 200 && addon.data.entitlements.apps.includes('expenses'), 'add-ons unlock expenses and api')
    check((await call('PUT', '/company/modules', owner, { modules: ['payroll', 'expenses'] })).status === 200, 'expenses can now be installed')
    check((await call('GET', '/automation/api-keys', owner)).status !== 403, 'API keys now open')
    const st = await call('PUT', '/company/plan', owner, { plan: 'starter', addons: [] })
    check(st.status === 200 && st.data.modules.join() === 'payroll', 'moving to Starter switches expenses off and keeps payroll')
    check((await call('PUT', '/company/plan', owner, { plan: 'growth', addons: [] })).status === 200, 'back on Growth')
    check((await call('GET', '/attendance/policies', owner)).status === 403, 'attendance app is not installed: 403')
    check((await call('POST', '/company/onboarding/complete', owner)).status === 200, 'onboarding completed')

    // ── org + people
    const tree = await call('GET', '/employees/org-units/tree', owner)
    check(tree.status === 200 && tree.data.length === 1, 'org tree has the root unit')
    const unit = tree.data[0].id
    check((await call('POST', '/employees/job-positions', owner, { orgUnitId: unit, title: 'Accountant' })).status === 201, 'job position created')
    const mary = await call('POST', '/employees', owner, { firstName: 'Mary', lastName: 'Banda', workEmail: `mary${stamp}@example.com`, orgUnitId: unit, hireDate: '2026-10-01', employmentType: 'full_time' })
    check(mary.status === 201 && mary.data.employee.employeeCode === 'EMP0002', `employee created (${mary.status})`)
    const maryId = mary.data.employee.id
    const daniel = await call('POST', '/employees', owner, { firstName: 'Daniel', lastName: 'Zulu', workEmail: `daniel${stamp}@example.com`, orgUnitId: unit, hireDate: '2026-10-01', employmentType: 'full_time' })
    const danielId = daniel.data.employee.id
    const dir = await call('GET', '/employees?search=banda', owner)
    check(dir.status === 200 && dir.data.length === 1 && dir.data[0].orgUnit.name, 'directory search works')

    // ── login access: the owner takes payroll_admin, Daniel is given a login as the second Payroll admin
    const own = await call('PUT', `/employees/${me.data.employee.id}/access`, owner, { roles: ['hr_admin', 'system_admin', 'payroll_admin'] })
    check(own.status === 200 && own.data.roles.includes('payroll_admin'), 'the owner added payroll_admin to themselves')
    const relogin = (await call('POST', '/auth/login', null, { email, password: pw })).data
    owner = relogin.accessToken // changing your own roles ends your old sessions, so use the new one
    check((await call('POST', '/auth/refresh', null, { refreshToken: su.data.refreshToken })).status === 401, 'the sign-up session ended when the owner changed their own roles')
    const grant = await call('PUT', `/employees/${danielId}/access`, owner, { roles: ['payroll_admin'], password: 'generate', loginEnabled: true })
    check(grant.status === 200 && grant.data.temporaryPassword, 'Daniel got a temporary password')
    const dl = await call('POST', '/auth/login', null, { email: `daniel${stamp}@example.com`, password: grant.data.temporaryPassword })
    check(dl.status === 200 && dl.data.user.mustChangePassword, 'Daniel signs in and must change his password')
    check((await call('GET', '/payroll/cycles', dl.data.accessToken)).status === 403, 'until he changes it, other APIs are 403 PASSWORD_CHANGE_REQUIRED')
    const dc = await call('POST', '/auth/change-password', dl.data.accessToken, { currentPassword: grant.data.temporaryPassword, newPassword: 'Daniel-new-pass-7' })
    check(dc.status === 200, 'Daniel changed his password')
    const daniel2 = dc.data.accessToken

    // ── salary: Zambia starter, contracts for Mary and Daniel
    const starter = await call('POST', '/salary/structures/starter', owner)
    check(starter.status === 201 || starter.status === 200, `Zambia starter created (${starter.status} ${JSON.stringify(starter.body).slice(0, 100)})`)
    const structureId = (starter.data.id) || (starter.data.structure && starter.data.structure.id)
    const full = await call('GET', `/salary/structures/${structureId}`, owner)
    check(full.status === 200 && full.data.rules.length === 10, 'starter has 10 rules')
    for (const [empId, wage] of [[maryId, 10000], [danielId, 20000]]) {
      const c = await call('POST', '/leave/contracts', owner, { employeeId: empId, ctcAnnual: wage * 12, wageMonthly: wage, currency: 'ZMW', effectiveFrom: '2026-10-01', salaryStructureId: structureId })
      check(c.status === 201, `contract created (${c.status} ${JSON.stringify(c.body).slice(0, 100)})`)
      for (const step of ['draft', 'confirm', 'activate']) check((await call('POST', `/leave/contracts/${c.data.id}/${step}`, owner, {})).status === 200, `contract ${step}`)
    }
    check((await call('GET', `/leave/contracts/employee/${maryId}`, owner)).data.length === 1, 'Mary has one contract')
    // HR cannot see pay
    const hrOnly = await call('PUT', `/employees/${danielId}/access`, owner, { roles: ['hr_admin'] })
    check(hrOnly.status === 200, 'Daniel temporarily HR only (to prove HR cannot see pay)')
    const daniel3 = (await call('POST', '/auth/login', null, { email: `daniel${stamp}@example.com`, password: 'Daniel-new-pass-7' })).data.accessToken
    check((await call('GET', `/leave/contracts/employee/${maryId}`, daniel3)).status === 404 || (await call('GET', `/leave/contracts/employee/${maryId}`, daniel3)).status === 403, 'an HR admin cannot open pay contracts')
    await call('PUT', `/employees/${danielId}/access`, owner, { roles: ['payroll_admin'] })
    const daniel4 = (await call('POST', '/auth/login', null, { email: `daniel${stamp}@example.com`, password: 'Daniel-new-pass-7' })).data.accessToken

    // ── payroll: run, two approvals, disburse
    const cycle = await call('POST', '/payroll/cycles', owner, { payPeriodStart: '2026-11-01', payPeriodEnd: '2026-11-30' })
    check(cycle.status === 201, `cycle created (${cycle.status} ${JSON.stringify(cycle.body).slice(0, 100)})`)
    const cid = cycle.data.id
    check((await call('POST', `/payroll/cycles/${cid}/lock-attendance`, owner)).status === 200, 'attendance locked')
    const run = await call('POST', `/payroll/cycles/${cid}/run`, owner)
    check(run.status === 200 && run.data.processed === 2, `payroll run: 2 people paid (${run.status} ${JSON.stringify(run.body).slice(0, 160)})`)
    const slips = await call('GET', `/payroll/cycles/${cid}/payslips`, owner)
    check(slips.status === 200 && slips.data.find((s) => s.employeeId === maryId).netPay === 8114, 'Mary K10,000 -> net 8,114 over HTTP')
    check((await call('POST', `/payroll/cycles/${cid}/approve`, owner)).status === 200, 'first approval')
    check((await call('POST', `/payroll/cycles/${cid}/finance-approve`, owner)).status === 403, 'the same admin cannot give the second approval')
    check((await call('POST', `/payroll/cycles/${cid}/finance-approve`, daniel4)).status === 200, 'Daniel gives the second approval')
    check((await call('GET', `/payroll/cycles/${cid}/gl-export`, owner)).status === 200, 'GL export works')
    const disb = await call('POST', `/payroll/cycles/${cid}/disburse`, daniel4)
    check(disb.status === 200 && disb.data.status === 'disbursed', 'disbursed')
    check((await call('POST', `/payroll/cycles/${cid}/run`, owner)).status === 400, 'a disbursed run is locked')

    // ── pay groups, legal entities and the sidebar/bell shell
    check((await call('POST', '/payroll/pay-groups', owner, { name: 'Weekly casuals', frequency: 'weekly' })).status === 201, 'pay group created')
    check((await call('POST', '/payroll/pay-groups', owner, { name: 'Weekly casuals', frequency: 'weekly' })).status === 409, 'duplicate pay group name is 409')
    const pgs = await call('GET', '/payroll/pay-groups', owner)
    check(pgs.status === 200 && pgs.data.length === 1 && pgs.data[0].people === 0, 'pay groups list with headcount')
    check((await call('POST', '/company/entities', owner, { name: 'Bimbe Zambia', country: 'ZM', currency: 'ZMW' })).status === 201, 'legal entity created')
    check((await call('GET', '/company/entities', owner)).data.length === 1, 'legal entities list')
    const dash2 = await call('GET', '/dashboard', owner)
    check(dash2.status === 200 && dash2.data.company.headcount === 3 && dash2.data.payroll.lastPaid.payslips === 2, 'dashboard shows headcount 3 and the paid run')
    check((await call('GET', '/dashboard/counts', owner)).status === 200, 'sidebar counts')
    const bell = await call('GET', '/notifications', owner)
    check(bell.status === 200 && Array.isArray(bell.data.items), 'notification bell lists')

    // ── things not ported answer 501, not a crash
    const unported = await call('GET', '/attendance/policies', owner)
    check(unported.status === 403, 'an app that is off stays 403')
    const lv = await call('GET', '/payroll/accounting/settings', owner)
    check(lv.status === 501 && lv.body.code === 'NOT_AVAILABLE_ON_MONGO', `unported module answers 501 (got ${lv.status})`)
    const rt = await call('POST', '/auth/refresh', null, { refreshToken: relogin.refreshToken })
    check(rt.status === 200 && rt.data.refreshToken !== relogin.refreshToken, 'refresh rotates over HTTP')
    check((await call('POST', '/auth/logout', null, { refreshToken: rt.data.refreshToken })).status === 200, 'logout')
  } finally {
    await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
    const db = mongoose.connection.db
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
})().catch((e) => { console.error(e); process.exit(1) })

// Recruitment and performance on the MongoDB API (through the Prisma-compatible client). Recruitment: opening requests and approval,
// candidates and referrals, interviews and feedback, offer, hire (creates the employee). Performance: cycles, goals with KPIs, send,
// accept or return, manager review, acknowledge, team scope. Removes its company at the end.
//   API=http://localhost:4210 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-recruitment.test.js
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
const inDays = (n) => new Date(Date.now() + n * 86400000)
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`

;(async () => {
  const stamp = Date.now(), email = `rc${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Recruit Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    check((await call('GET', '/recruitment/openings', owner)).status === 403, 'recruitment is not in the Growth plan: 403')
    check((await call('GET', '/performance/cycles', owner)).status === 403, 'performance is not in the Growth plan: 403')
    check((await call('PUT', '/company/plan', owner, { plan: 'growth', addons: ['recruitment', 'pms'] })).status === 200, 'both bought as add-ons')
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), danielId = await mk('Daniel', 'Zulu'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const daniel = await login(owner, danielId, `daniel${stamp}@example.com`, ['manager'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danielId } })
    const danielUser = (await db.collection('employees').findOne({ _id: danielId })).userId

    // ───────────── recruitment
    check((await call('POST', '/recruitment/openings', mary, { title: 'Intern', orgUnitId: unit, employmentType: 'full_time', openings: 1, reason: 'new_post', hiringManagerId: danielId })).status === 403, 'an employee cannot open a position')
    const op = await call('POST', '/recruitment/openings', daniel, { title: 'Accountant', orgUnitId: unit, employmentType: 'full_time', openings: 1, reason: 'new_post', hiringManagerId: danielId, description: 'Month end close', salaryMin: 8000, salaryMax: 12000 })
    check(op.status === 201 && op.data.status === 'pending_approval', `a manager requests an opening (${short(op)})`)
    const opId = op.data.id
    check((await call('POST', `/recruitment/openings/${opId}/approve`, daniel, {})).status === 403, 'the requester cannot approve their own request')
    const apv = await call('POST', `/recruitment/openings/${opId}/approve`, owner, { note: 'Budgeted' })
    check(apv.status === 200, `HR approves (${short(apv)})`)
    check((await call('GET', `/recruitment/openings/${opId}`, mary)).data.status === 'open', 'the opening is open and visible to employees')
    check((await call('POST', `/recruitment/openings/${opId}/candidates`, mary, { firstName: 'A', lastName: 'B', email: 'a@b.com' })).status === 403, 'an employee cannot add candidates directly')
    const c1 = await call('POST', `/recruitment/openings/${opId}/candidates`, owner, { firstName: 'Chola', lastName: 'Mumba', email: `chola${stamp}@example.com`, phone: '0977000001' })
    check(c1.status === 201, `HR adds a candidate (${short(c1)})`)
    check((await call('POST', `/recruitment/openings/${opId}/candidates`, owner, { firstName: 'Chola', lastName: 'Mumba', email: `chola${stamp}@example.com` })).status === 409, 'the same email twice is refused')
    const ref = await call('POST', `/recruitment/openings/${opId}/refer`, mary, { firstName: 'Bwalya', lastName: 'Chanda', email: `bwalya${stamp}@example.com` })
    check(ref.status === 201, `Mary refers someone (${short(ref)})`)
    check((await call('GET', '/recruitment/referrals/mine', mary)).data.length === 1, 'it shows in her referrals')
    const cid = c1.data.id
    check((await call('PATCH', `/recruitment/candidates/${cid}`, owner, { stage: 'screening', rating: 4 })).status === 200, 'HR moves the candidate to screening')
    check((await call('PATCH', `/recruitment/candidates/${cid}`, owner, { stage: 'rejected' })).status === 400, 'rejecting needs a reason')
    const iv = await call('POST', `/recruitment/candidates/${cid}/interviews`, owner, { interviewerUserId: danielUser, scheduledAt: inDays(2).toISOString(), mode: 'video' })
    check(iv.status === 201, `HR schedules an interview with Daniel (${short(iv)})`)
    const mine = await call('GET', '/recruitment/interviews/mine', daniel)
    check(mine.status === 200 && mine.data.length === 1, 'Daniel sees it in his interviews')
    check((await call('POST', `/recruitment/interviews/${iv.data.id}/feedback`, paul, { rating: 4, recommendation: 'hire', feedback: 'Not my interview to review' })).status === 404, 'only the interviewer can give feedback (404 for others)')
    const fb = await call('POST', `/recruitment/interviews/${iv.data.id}/feedback`, daniel, { rating: 5, recommendation: 'strong_hire', feedback: 'Excellent grasp of month end' })
    check(fb.status === 200, `Daniel gives feedback (${short(fb)})`)
    check((await call('POST', `/recruitment/candidates/${cid}/offer`, daniel, { ctcAnnual: 120000, joiningDate: iso(inDays(30)) })).status === 403, 'only HR makes offers')
    check((await call('POST', `/recruitment/candidates/${cid}/hire`, owner, { workEmail: `chola${stamp}@work.com` })).status === 400, 'cannot hire before an accepted offer')
    check((await call('POST', `/recruitment/candidates/${cid}/offer`, owner, { ctcAnnual: 120000, joiningDate: iso(inDays(30)) })).status === 409, 'an offer far outside the pay range needs a confirmation')
    const off = await call('POST', `/recruitment/candidates/${cid}/offer`, owner, { ctcAnnual: 10000, joiningDate: iso(inDays(30)) })
    check(off.status === 200, `HR makes an offer (${short(off).slice(0, 200)})`)
    check((await call('POST', `/recruitment/candidates/${cid}/offer-response`, owner, { accepted: true })).status === 200, 'the offer is accepted')
    const hire = await call('POST', `/recruitment/candidates/${cid}/hire`, owner, { workEmail: `chola${stamp}@work.com` })
    check(hire.status === 201 && hire.data.employee.employeeCode, `HR hires: an employee record is created (${short(hire)})`)
    check(hire.data.openingFilled === true, 'the only seat is filled so the opening closes')
    check((await db.collection('employees').countDocuments({ tenantId, workEmail: `chola${stamp}@work.com` })) === 1, 'the new employee exists in the company')
    check((await call('POST', `/recruitment/candidates/${cid}/hire`, owner, { workEmail: `chola2${stamp}@work.com` })).status >= 400, 'a candidate cannot be hired twice')
    check((await call('GET', `/recruitment/candidates/${cid}`, owner)).status === 200, 'HR opens the candidate')
    check((await call('GET', `/recruitment/candidates/${cid}`, paul)).status >= 400, 'an employee cannot open a candidate')

    // ───────────── performance
    check((await call('POST', '/performance/cycles', mary, { name: 'FY', period: 'yearly', startDate: '2026-01-01', endDate: '2026-12-31' })).status === 403, 'an employee cannot set up a cycle')
    const cy = await call('POST', '/performance/cycles', owner, { name: 'FY2026', period: 'yearly', startDate: '2026-01-01', endDate: '2026-12-31' })
    check(cy.status === 201, `HR creates a cycle (${short(cy)})`)
    check((await call('POST', '/performance/cycles', owner, { name: 'FY2026', period: 'yearly', startDate: '2026-01-01', endDate: '2026-12-31' })).status === 409, 'a duplicate cycle name is refused')
    check((await call('GET', '/performance/cycles', mary)).data.length === 1, 'everyone sees cycles')
    const kpis = [{ name: 'Invoices processed', target: 100, unit: 'invoices', weight: 60 }, { name: 'Close days', target: 5, unit: 'days', weight: 40 }]
    check((await call('POST', '/performance/goals', mary, { cycleId: cy.data.id, employeeId: maryId, title: 'My own goal', kpis })).status === 403, 'Mary cannot set her own goal')
    check((await call('POST', '/performance/goals', daniel, { cycleId: cy.data.id, employeeId: paulId, title: 'Not my team', kpis })).status === 403, "a manager cannot set a goal for someone who isn't in their team")
    check((await call('POST', '/performance/goals', daniel, { cycleId: cy.data.id, employeeId: maryId, title: 'Bad weights', kpis: [{ ...kpis[0], weight: 50 }, kpis[1]] })).status === 400, 'KPI weights must add up to 100')
    const g = await call('POST', '/performance/goals', daniel, { cycleId: cy.data.id, employeeId: maryId, title: 'Faster month end', description: 'Close faster', kpis })
    check(g.status === 201, `Daniel sets a goal for Mary (${short(g)})`)
    const gid = g.data.id
    check((await call('POST', `/performance/goals/${gid}/send`, daniel)).status === 200, 'Daniel sends it')
    const ml = await call('GET', '/performance/goals?scope=mine', mary)
    check(ml.data.length === 1 && ml.data[0].kpis.length === 2, `Mary sees it with 2 KPIs (${ml.data?.length})`)
    check((await call('GET', '/performance/goals?scope=team', daniel)).data.length === 1, "Daniel's team scope has it")
    check((await call('GET', '/performance/goals?scope=all', daniel)).status === 403, 'only HR sees all goals')
    check((await call('GET', '/performance/goals?scope=all', owner)).data.length === 1, 'HR sees all goals')
    check((await call('POST', `/performance/goals/${gid}/accept`, paul)).status >= 400, "Paul cannot accept Mary's goal")
    check((await call('POST', `/performance/goals/${gid}/return`, mary, { note: 'Target 100 is too high' })).status === 200, 'Mary sends it back')
    const rvs = await call('PUT', `/performance/goals/${gid}`, daniel, { title: 'Faster month end', kpis: [{ name: 'Invoices processed', target: 80, unit: 'invoices', weight: 60 }, kpis[1]] }); check(rvs.status === 200, 'Daniel revises it ' + short(rvs))
    await call('POST', `/performance/goals/${gid}/send`, daniel)
    check((await call('POST', `/performance/goals/${gid}/accept`, mary)).status === 200, 'Mary accepts')
    const full = (await call('GET', '/performance/goals?scope=mine', mary)).data[0]
    const achieved = Object.fromEntries(full.kpis.map((k) => [k.id, k.target]))
    check((await call('POST', `/performance/goals/${gid}/review`, mary, { achieved })).status === 403, 'Mary cannot review her own goal')
    const rv = await call('POST', `/performance/goals/${gid}/review`, daniel, { achieved, comment: 'Met every target' })
    check(rv.status === 200 && rv.data.score === 100, `Daniel reviews: 100% (${short(rv)})`)
    check((await call('POST', `/performance/goals/${gid}/acknowledge`, mary, { comment: 'Thanks' })).status === 200, 'Mary acknowledges')
    check((await call('POST', `/performance/goals/${gid}/acknowledge`, mary, {})).status === 400, 'acknowledging twice is refused')
    check((await call('POST', `/performance/cycles/${cy.data.id}/status`, owner, { status: 'closed' })).status === 200, 'HR closes the cycle')
    check((await call('POST', '/performance/goals', daniel, { cycleId: cy.data.id, employeeId: maryId, title: 'Late goal', kpis })).status === 400, 'no goals in a closed cycle')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      const ids = emps.map((e) => e._id)
      for (const c of ['leave_balances', 'leave_requests', 'leave_allocations']) await db.collection(c).deleteMany({ employeeId: { $in: ids } })
      const goals = await db.collection('performance_goals').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('performance_kpis').deleteMany({ goalId: { $in: goals.map((g) => g._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

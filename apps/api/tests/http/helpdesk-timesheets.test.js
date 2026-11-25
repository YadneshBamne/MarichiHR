// Helpdesk and Timesheets on the MongoDB API: plan gating, ticket visibility and internal notes, owner rules, weekly timesheet
// flow with manager approval. Needs the API running in MongoDB mode. Removes its company from Atlas at the end.
//   API=http://localhost:4200 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/helpdesk-timesheets.test.js
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
  const c = await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })
  return c.data.accessToken
}

;(async () => {
  const stamp = Date.now(), email = `hd${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `HD Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const tree = await call('GET', '/employees/org-units/tree', owner)
    const unit = tree.data[0].id
    const mk = async (n, who) => (await call('POST', '/employees', owner, { firstName: n, lastName: who, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2026-10-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), danielId = await mk('Daniel', 'Zulu'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const daniel = await login(owner, danielId, `daniel${stamp}@example.com`, ['manager'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danielId } })

    // ── helpdesk (in every plan)
    const cats = await call('GET', '/helpdesk/categories', mary)
    check(cats.status === 200 && cats.data.length >= 5, 'default helpdesk categories are created')
    const payrollCat = cats.data.find((c) => c.name.startsWith('Payroll')).id
    const t = await call('POST', '/helpdesk/tickets', mary, { categoryId: payrollCat, subject: 'Payslip missing', description: 'October payslip is not showing', priority: 'high' })
    check(t.status === 201 && t.data.number === 'HD-0001' && t.data.status === 'open', 'Mary raises a ticket HD-0001')
    const tid = t.data.id
    check((await call('GET', `/helpdesk/tickets/${tid}`, paul)).status === 404, 'Paul cannot see Mary\'s ticket (404)')
    check((await call('GET', '/helpdesk/tickets?scope=all', mary)).data.items.length === 1, 'an employee asking for scope=all still sees only their own')
    const all = await call('GET', '/helpdesk/tickets?scope=all', owner)
    check(all.data.items.length === 1 && all.data.items[0].requesterName === 'Mary Banda', 'HR sees all tickets with the requester name')
    check((await call('POST', `/helpdesk/tickets/${tid}/comments`, mary, { body: 'secret', internal: true })).status === 403, 'an employee cannot write an internal note')
    check((await call('POST', `/helpdesk/tickets/${tid}/comments`, owner, { body: 'Checking with payroll', internal: true })).status === 201, 'HR adds an internal note')
    const rep = await call('POST', `/helpdesk/tickets/${tid}/comments`, owner, { body: 'Looking into it now' })
    check(rep.status === 201 && rep.data.status === 'in_progress', 'an HR reply moves the ticket to in progress')
    const mine = await call('GET', `/helpdesk/tickets/${tid}`, mary)
    check(mine.data.comments.length === 1 && mine.data.comments[0].body === 'Looking into it now', 'the requester never sees internal notes')
    check((await call('PATCH', `/helpdesk/tickets/${tid}`, mary, { priority: 'low' })).status === 403, 'an employee cannot change priority')
    check((await call('PATCH', `/helpdesk/tickets/${tid}`, mary, { status: 'resolved' })).status === 403, 'an employee cannot mark it resolved')
    check((await call('PATCH', `/helpdesk/tickets/${tid}`, owner, { assigneeUserId: su.data.user.id })).status === 200, 'HR assigns it to themselves')
    check((await call('PATCH', `/helpdesk/tickets/${tid}`, owner, { assigneeUserId: (await call('GET', '/auth/me', paul)).data.user?.id ?? '00000000-0000-4000-8000-000000000000' })).status === 400, 'it cannot be assigned to a non-HR person')
    check((await call('PATCH', `/helpdesk/tickets/${tid}`, owner, { status: 'resolved' })).data.resolvedAt, 'HR resolves it')
    check((await call('PATCH', `/helpdesk/tickets/${tid}`, mary, { status: 'closed' })).status === 200, 'Mary closes it')
    check((await call('POST', `/helpdesk/tickets/${tid}/comments`, mary, { body: 'thanks' })).status === 409, 'a closed ticket takes no comments')

    // ── timesheets: not in Growth until bought as an add-on
    check((await call('GET', '/timesheets/projects', mary)).status === 403, 'Timesheets is not in the Growth plan: 403')
    check((await call('PUT', '/company/plan', owner, { plan: 'growth', addons: ['timesheets'] })).status === 200, 'Timesheets bought as an add-on')
    check((await call('POST', '/timesheets/projects', mary, { code: 'X1', name: 'Nope' })).status === 403, 'an employee cannot create projects')
    const proj = await call('POST', '/timesheets/projects', owner, { code: 'bimbe-1', name: 'Bimbe rollout' })
    check(proj.status === 201 && proj.data.code === 'BIMBE-1', 'HR creates a project (code upper-cased)')
    check((await call('POST', '/timesheets/projects', owner, { code: 'BIMBE-1', name: 'Dup' })).status === 409, 'a duplicate code is 409')
    const pid = proj.data.id
    const wk = '2026-11-16' // a Monday
    check((await call('GET', '/timesheets/week?start=2026-11-17', mary)).status === 400, 'a week must start on Monday')
    const empty = await call('GET', `/timesheets/week?start=${wk}`, mary)
    check(empty.status === 200 && empty.data.status === 'draft' && empty.data.total === 0, 'an empty draft week')
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: [{ date: '2026-11-23', projectId: pid, hours: 4 }] })).status === 400, 'an entry outside the week is 400')
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: [{ date: wk, projectId: pid, hours: 3.3 }] })).status === 400, 'hours go in quarters')
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: [{ date: wk, projectId: '00000000-0000-4000-8000-000000000000', hours: 2 }] })).status === 400, 'an unknown project is 400')
    check((await call('POST', '/timesheets/week/submit', mary, { weekStart: wk })).status === 409, 'an empty week cannot be submitted')
    const saved = await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: [{ date: wk, projectId: pid, task: 'Setup', hours: 8 }, { date: '2026-11-17', projectId: pid, task: 'Training', hours: 7.5 }] })
    check(saved.status === 200 && saved.data.total === 15.5, 'Mary saves 15.5 hours')
    check((await call('POST', '/timesheets/week/submit', mary, { weekStart: wk })).data.status === 'submitted', 'Mary submits the week')
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: [] })).status === 409, 'a submitted week is read-only')
    check((await call('GET', '/timesheets/approvals', paul)).data.weeks.length === 0, 'Paul (not her manager) sees nothing to approve')
    const appr = await call('GET', '/timesheets/approvals', daniel)
    check(appr.data.weeks.length === 1 && appr.data.weeks[0].employeeName === 'Mary Banda', 'her manager Daniel sees it')
    const wid = appr.data.weeks[0].id
    check((await call('POST', `/timesheets/weeks/${wid}/decide`, paul, { approve: true })).status === 404, 'Paul cannot decide it (404)')
    check((await call('POST', `/timesheets/weeks/${wid}/decide`, daniel, { approve: false })).status === 400, 'a rejection needs a reason')
    const rej = await call('POST', `/timesheets/weeks/${wid}/decide`, daniel, { approve: false, note: 'Friday is missing' })
    check(rej.data.status === 'rejected' && rej.data.note === 'Friday is missing', 'Daniel sends it back with a reason')
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: [{ date: wk, projectId: pid, hours: 8 }, { date: '2026-11-20', projectId: pid, hours: 8 }] })).status === 200, 'a rejected week can be edited')
    await call('POST', '/timesheets/week/submit', mary, { weekStart: wk })
    const again = (await call('GET', '/timesheets/approvals', daniel)).data.weeks[0].id
    check((await call('POST', `/timesheets/weeks/${again}/decide`, daniel, { approve: true })).data.status === 'approved', 'Daniel approves')
    check((await call('POST', `/timesheets/weeks/${again}/decide`, daniel, { approve: true })).status === 409, 'a decided week cannot be decided twice')
    // owner's own week: HR cannot approve their own
    await call('PUT', '/timesheets/week', owner, { weekStart: wk, entries: [{ date: wk, projectId: pid, hours: 1 }] })
    await call('POST', '/timesheets/week/submit', owner, { weekStart: wk })
    check((await call('GET', '/timesheets/approvals', owner)).data.weeks.length === 0, 'HR does not see their own week in approvals')
    const rep2 = await call('GET', `/timesheets/report?from=${wk}&to=2026-11-22`, owner)
    check(rep2.status === 200 && rep2.data.length === 1 && rep2.data[0].hours === 16 && rep2.data[0].employee === 'Mary Banda', 'the report counts approved hours only')
    check((await call('GET', `/timesheets/report?from=${wk}&to=2026-11-22`, mary)).status === 403, 'employees cannot run the report')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      await db.collection('counters').deleteMany({ _id: `helpdesk:${tenantId}` })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

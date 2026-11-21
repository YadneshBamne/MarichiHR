// Workplace modules on the MongoDB API: announcements, policies (publish, accept, queries, exceptions, blocking), grievances (named and
// anonymous), tasks and chatter, the audit log, privacy requests and masters. Removes its company at the end.
//   API=http://localhost:4212 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-workplace.test.js
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
  const stamp = Date.now(), email = `wp${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Workplace Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), danielId = await mk('Daniel', 'Zulu'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const daniel = await login(owner, danielId, `daniel${stamp}@example.com`, ['manager'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danielId } })

    // ───────────── announcements
    check((await call('POST', '/announcements', mary, { title: 'Hello', body: 'x' })).status === 403, 'an employee cannot post an announcement')
    const an = await call('POST', '/announcements', owner, { title: 'Office closed Friday', body: 'We close at noon for the staff party.', pinned: true, requiresAck: true })
    check(an.status === 201, `HR posts an announcement (${short(an)})`)
    const list = await call('GET', '/announcements', mary)
    check(list.status === 200 && list.data.some((a) => a.id === an.data.id), 'employees see it')
    check((await call('GET', '/announcements/manage', mary)).status === 403, 'employees cannot open the manage list')
    check((await call('GET', '/announcements/manage', owner)).data.length === 1, 'HR sees the manage list')
    check((await call('POST', `/announcements/${an.data.id}/read`, mary, {})).status === 200, 'Mary acknowledges it')
    const rd = await call('GET', `/announcements/${an.data.id}/readers`, owner)
    check(rd.status === 200 && JSON.stringify(rd.data).includes('Mary'), 'HR sees who has read it')
    check((await call('PATCH', `/announcements/${an.data.id}`, owner, { title: 'Office closes Friday at noon' })).status === 200, 'HR edits it')
    check((await call('POST', `/announcements/${an.data.id}/archive`, owner)).status === 200, 'HR archives it')
    check(!(await call('GET', '/announcements', mary)).data.some((a) => a.id === an.data.id), 'an archived announcement disappears for employees')

    // ───────────── policies
    check((await call('POST', '/policies', mary, { title: 'Nope', body: 'x' })).status === 403, 'an employee cannot create a policy')
    const pol = await call('POST', '/policies', owner, { title: 'Code of conduct', category: 'HR', body: 'Be respectful to everyone.', requiresAcceptance: true, acceptWithinDays: 7, critical: false })
    check(pol.status === 201, `HR creates a policy (${short(pol)})`)
    const pid = pol.data.id
    check((await call('GET', '/policies', mary)).data.every((p) => p.id !== pid), 'a draft is not visible to employees')
    check((await call('PUT', `/policies/${pid}/draft`, owner, { body: 'Be respectful to everyone, always.', changeNote: 'Clarified' })).status === 200, 'HR edits the draft')
    const pub = await call('POST', `/policies/${pid}/publish`, owner, {})
    check(pub.status === 200, `HR publishes (${short(pub)})`)
    check((await call('GET', '/policies', mary)).data.some((p) => p.id === pid), 'employees now see the policy')
    check((await call('GET', `/policies/${pid}`, mary)).status === 200, 'Mary reads it')
    check((await call('POST', `/policies/${pid}/accept`, mary, {})).status === 200, 'Mary accepts it')
    check((await call('POST', `/policies/${pid}/accept`, mary, {})).status < 500, 'accepting twice does not crash')
    const acc = await call('GET', `/policies/${pid}/acceptances`, owner)
    check(acc.status === 200, `HR sees acceptances (${short(acc).slice(0, 100)})`)
    check((await call('POST', `/policies/${pid}/remind`, owner, {})).status === 200, 'HR reminds people who have not accepted')
    check((await call('GET', '/policies/report', owner)).status === 200, 'the acceptance report')
    const q = await call('POST', '/policies/queries', mary, { policyId: pid, question: 'Does this apply to contractors too?' })
    check(q.status === 201, `Mary asks a question (${short(q)})`)
    check((await call('POST', `/policies/queries/${q.data?.id}/answer`, owner, { answer: 'Yes, to contractors as well.', close: true })).status === 200, 'the owner answers and closes it')
    const ex = await call('POST', '/policies/exceptions', mary, { policyId: pid, request: 'Work from home on Fridays', reason: 'Long commute and a family commitment this month' })
    check(ex.status === 201, `Mary requests an exception (${short(ex)})`)
    check((await call('POST', `/policies/exceptions/${ex.data?.id}/withdraw`, mary, {})).status === 200, 'and withdraws it')
    // a critical policy blocks everything else until it is accepted
    const crit = await call('POST', '/policies', owner, { title: 'Data protection', category: 'Compliance', body: 'Protect personal data.', requiresAcceptance: true, acceptWithinDays: 1, critical: true })
    await call('POST', `/policies/${crit.data.id}/publish`, owner, {})
    const blocked = await call('GET', '/announcements', paul)
    check(blocked.status === 403, `a critical unaccepted policy blocks Paul's other requests (${short(blocked).slice(0, 120)})`)
    check((await call('GET', '/policies/blocking', paul)).status === 200, 'but he can still list what blocks him')
    check((await call('POST', `/policies/${crit.data.id}/accept`, paul, {})).status === 200, 'Paul accepts it')
    check((await call('GET', '/announcements', paul)).status === 200, 'and is free again')
    for (const t of [mary, daniel, owner]) await call('POST', `/policies/${crit.data.id}/accept`, t, {}) // everyone else accepts too, or their requests stay blocked

    // ───────────── grievances
    check((await call('POST', '/grievances', mary, { category: 'Facilities', subject: 'Broken chair', description: 'The chair at my desk is broken.' })).status === 201, 'Mary raises a named grievance')
    const mine = await call('GET', '/grievances/mine', mary)
    check(mine.status === 200 && mine.data.length === 1, 'it shows in her cases')
    const gid = mine.data[0].id
    check((await call('GET', `/grievances/mine/${gid}`, paul)).status === 404, "Paul cannot open Mary's case (404)")
    check((await call('GET', '/grievances', mary)).status === 403, 'an employee cannot list all cases')
    const queue = await call('GET', '/grievances', owner)
    check(queue.status === 200 && queue.data.length === 1, 'HR sees the queue')
    check((await call('GET', '/grievances', daniel)).status === 403, "her manager does not see the queue")
    check((await call('POST', `/grievances/${gid}/messages`, owner, { body: 'Looking into it', internal: false })).status === 201, 'HR replies')
    check((await call('POST', `/grievances/${gid}/messages`, owner, { body: 'Check with facilities', internal: true })).status === 201, 'HR adds an internal note')
    const thread = await call('GET', `/grievances/mine/${gid}`, mary)
    check(!JSON.stringify(thread.data).includes('Check with facilities'), 'the person never sees internal notes')
    check((await call('POST', `/grievances/mine/${gid}/messages`, mary, { body: 'Thanks' })).status === 201, 'Mary replies')
    check((await call('PATCH', `/grievances/${gid}`, owner, { status: 'resolved', resolution: 'Chair replaced' })).status === 200, 'HR resolves it')
    const an2 = await call('POST', '/grievances', paul, { category: 'Harassment', subject: 'Anonymous concern', description: 'Something happened that I want to report safely.', anonymous: true })
    check(an2.status === 201 && an2.data.caseKey, `an anonymous grievance gives a case key (${short(an2).slice(0, 100)})`)
    const key = an2.data.caseKey
    check((await call('GET', '/grievances/mine', paul)).data.length === 0, 'an anonymous case is not linked to the person')
    check(JSON.stringify((await call('GET', '/grievances', owner)).data).includes('Paul') === false, 'HR cannot see who raised an anonymous case')
    check((await call('POST', '/grievances/anonymous/view', paul, { caseKey: key })).status === 200, 'the key opens the case (not linked to the person)')
    check((await call('POST', '/grievances/anonymous/messages', paul, { caseKey: key, body: 'More detail' })).status === 201, 'and lets them reply')

    // ───────────── tasks and chatter
    const types = await db.collection('activity_types').find({ tenantId }).toArray()
    const task = await call('POST', '/activities', owner, { activityTypeId: types[0]._id, entityType: 'employee', entityId: maryId, title: 'Collect signed contract', assignedToId: maryId, dueDate: iso(inDays(3)) })
    check(task.status === 201, `HR creates a task for Mary (${short(task)})`)
    const tm = await call('GET', '/activities/mine', mary)
    check(tm.status === 200 && tm.data.length === 1, 'it is in her tasks')
    check((await call('POST', `/activities/${task.data.id}/complete`, paul, { doneNote: 'Done' })).status >= 400, "Paul cannot complete Mary's task")
    check((await call('POST', `/activities/${task.data.id}/complete`, mary, { doneNote: 'Handed over' })).status === 200, 'Mary completes it')
    check((await call('GET', '/activities/dashboard', owner)).status === 200, 'the tasks dashboard')
    check((await call('POST', '/activities/chatter', owner, { entityType: 'employee', entityId: maryId, body: 'Welcome aboard', isInternal: true })).status === 201, 'HR posts a note on the profile')
    const ch = await call('GET', `/activities/chatter/employee/${maryId}`, owner)
    check(ch.status === 200 && ch.data.length >= 1, 'chatter lists it')
    check(!JSON.stringify((await call('GET', `/activities/chatter/employee/${maryId}`, mary)).data ?? '').includes('Welcome aboard'), 'internal notes stay hidden from the person')

    // ───────────── audit
    check((await call('GET', '/audit', mary)).status === 403, 'an employee cannot read the audit log')
    const au = await call('GET', '/audit', owner)
    check(au.status === 200 && JSON.stringify(au.data).length > 50, `HR reads the audit log (${short(au).slice(0, 100)})`)
    check((await call('GET', '/audit/facets', owner)).status === 200, 'audit facets')
    const ex2 = await fetch(`${API}/audit/export`, { headers: { Authorization: `Bearer ${owner}` } })
    check(ex2.status === 200, 'audit export')

    // ───────────── privacy
    const pe = await fetch(`${API}/privacy/export/${maryId}`, { headers: { Authorization: `Bearer ${mary}` } })
    check(pe.status === 200, `Mary exports her own data (${pe.status})`)
    check((await fetch(`${API}/privacy/export/${maryId}`, { headers: { Authorization: `Bearer ${paul}` } })).status >= 400, "Paul cannot export Mary's data")
    const er = await call('POST', '/privacy/erasure', owner, { employeeId: paulId, reason: 'Left the company' })
    check(er.status === 201 || er.status === 200 || er.status === 400, `an erasure request answers (${short(er).slice(0, 120)})`)
    check((await call('GET', '/privacy/requests?scope=all', owner)).status === 200, 'privacy requests list')

    // ───────────── masters
    const ms = await call('GET', '/masters', mary)
    check(ms.status === 200 && Object.keys(ms.data ?? {}).length >= 3, 'masters are listed for everyone')
    check((await call('POST', '/masters/employment_type', mary, { label: 'Intern' })).status === 403, 'an employee cannot add a master value')
    const nv = await call('POST', '/masters/employment_type', owner, { label: 'Apprentice', code: 'apprentice' })
    check(nv.status === 201, `HR adds a value (${short(nv).slice(0, 120)})`)
    check((await call('PATCH', `/masters/employment_type/${nv.data?.id}`, owner, { label: 'Internship' })).status === 200, 'HR renames it')
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

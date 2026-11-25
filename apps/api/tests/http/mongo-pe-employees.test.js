// People fixes on the MongoDB API: input rules on Add person / edit / resume / import, archive with reassigning reports, reinstate, the Business Partner
// scope on writes, bank verification by payroll, who may grant payroll_admin, the directory (sort, status, full-name and phone search, sub-departments, CSV),
// skills and resume for oneself, the org chart's missing-manager and head flags, and onboarding/update requests. One signup; the company is removed at the end.
//   API=http://localhost:4271 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-pe-employees.test.js
process.env.STORAGE_PROVIDER = 'memory'
const mongoose = require('mongoose')
const API = (process.env.API || 'http://localhost:4200') + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body, raw) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data, text, headers: res.headers }
}
const iso = (d) => d.toISOString().slice(0, 10)
const addDays = (n) => iso(new Date(Date.now() + n * 86400000))

;(async () => {
  const stamp = Date.now()
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `PE People ${stamp}`, fullName: 'Hana Owner', email: `pe${stamp}@example.com`, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    await call('PUT', '/company/plan', owner, { plan: 'enterprise' })
    await call('PUT', '/company/modules', owner, { modules: ['attendance', 'leave', 'payroll', 'exits'] })
    const root = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const unit = async (name, parentId = root) => (await call('POST', '/employees/org-units', owner, { name, type: 'department', parentId })).data?.id
    const sales = await unit('Sales'), ops = await unit('Operations'), emea = await unit('EMEA Sales', sales)

    // ── A. input rules
    const base = (o = {}) => ({ firstName: 'Test', lastName: 'Person', workEmail: `t${Math.random().toString(36).slice(2, 8)}${stamp}@example.com`, orgUnitId: sales, hireDate: '2025-01-01', employmentType: 'full_time', ...o })
    const create = (o, t = owner) => call('POST', '/employees', t, base(o))
    for (const [label, o] of [['employment type banana', { employmentType: 'banana' }], ['gender xx', { gender: 'xx' }], ['nationality Narnia', { nationality: 'Narnia' }], ['start date 2099', { hireDate: '2099-01-01' }], ['birth date 2030', { dateOfBirth: '2030-01-01' }], ['a name of spaces', { firstName: '   ' }], ['mobile abc', { mobilePersonal: 'abc' }], ['hire date xyz', { hireDate: 'xyz' }], ['birth date garbage', { dateOfBirth: 'garbage' }], ['birth date under 14', { dateOfBirth: addDays(-365 * 5) }]]) {
      const r = await create(o)
      check(r.status === 400, `Add person refuses ${label} with a 400 (${r.status} ${String(r.body.message).slice(0, 60)})`)
    }
    const mary = await create({ firstName: 'Mary', lastName: 'Banda', mobilePersonal: '+260 971 234 567', dateOfBirth: '1990-05-05', gender: 'female', nationality: 'ZM', workEmail: `mary${stamp}@example.com` })
    check(mary.status === 201, 'a valid person is added')
    const maryId = mary.data.employee.id
    check((await db.collection('employees').findOne({ _id: maryId })).mobilePersonal === '+260971234567', 'the phone number is stored tidied')
    const dup = await create({ mobilePersonal: '0097 1 234 567' })
    check((await create({ mobilePersonal: '+260971234567' })).status === 409, 'a phone number already on someone is refused with a 409')
    void dup
    // Required fields enforced
    await call('PUT', '/employees/form-settings', owner, { fields: [{ field: 'dateOfBirth', mode: 'mandatory', employeeCanEdit: false }] })
    const noDob = await create({})
    check(noDob.status === 400 && /Date of birth/.test(String(noDob.body.message)), `a company-required field is enforced on create (${noDob.status} ${String(noDob.body.message).slice(0, 70)})`)
    check((await create({ dateOfBirth: '1992-02-02' })).status === 201, 'with the required field it is added')
    await call('PUT', '/employees/form-settings', owner, { fields: [{ field: 'dateOfBirth', mode: 'display', employeeCanEdit: false }] })

    const danR = await create({ firstName: 'Dan', lastName: 'Manager', workEmail: `dan${stamp}@example.com` })
    const danId = danR.data.employee.id
    const paulR = await create({ firstName: 'Paul', lastName: 'Ops', orgUnitId: ops, workEmail: `paul${stamp}@example.com` })
    const paulId = paulR.data.employee.id
    await call('PATCH', `/employees/${maryId}`, owner, { managerId: danId })
    // edit rules
    check((await call('PATCH', `/employees/${maryId}`, owner, { dateOfBirth: 'xyz' })).status === 400, 'a bad birth date on edit is a 400')
    check((await call('PATCH', `/employees/${maryId}`, owner, { employmentStatus: 'banana' })).status === 400, 'an invented status on edit is refused')
    check((await call('PATCH', `/employees/${maryId}`, owner, { gender: 'xx' })).status === 400, 'a gender outside the list on edit is refused')
    const loop = await call('PATCH', `/employees/${danId}`, owner, { managerId: maryId })
    check(loop.status === 400 && /loop/i.test(String(loop.body.message)), `a reporting loop through edit is refused (${loop.status})`)
    check((await call('PATCH', `/employees/${maryId}`, owner, { jobPositionId: undefined, mobileWork: '+260 955 000 111' })).status === 200, 'a valid edit works')
    check((await call('PATCH', `/employees/${paulId}`, owner, { mobilePersonal: '+260971234567' })).status === 409, 'editing in a phone number that belongs to someone else is refused')
    // bank
    check((await call('PATCH', `/employees/${maryId}/bank`, owner, { bankName: 'Narnia Bank', bankAccountNo: '1234567890' })).status === 400, 'a bank outside the Bank list is refused')
    check((await call('PATCH', `/employees/${maryId}/bank`, owner, { bankName: 'zanaco', bankAccountNo: '1234567890' })).status === 200, 'a bank from the list is saved')
    // org unit duplicates
    check((await call('POST', '/employees/org-units', owner, { name: 'sales', type: 'department', parentId: root })).status === 409, 'a second department with the same name (any case) under the same parent is refused')
    check((await call('POST', '/employees/org-units', owner, { name: 'Support', type: 'department', parentId: emea })).status === 201, 'the same kind of name elsewhere is fine')

    // logins
    const login = async (id, email, roles, extra = {}) => {
      const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true, ...extra })
      if (!g.data) throw new Error(`access ${email}: ${g.status} ${JSON.stringify(g.body).slice(0, 120)}`)
      const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
      return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
    }
    const dan = await login(danId, `dan${stamp}@example.com`, ['manager'])
    const marytok = await login(maryId, `mary${stamp}@example.com`, ['employee'])
    const paul = await login(paulId, `paul${stamp}@example.com`, ['employee'])
    const hrbpR = await create({ firstName: 'Hrbp', lastName: 'Partner', workEmail: `hrbp${stamp}@example.com` })
    const hrbp = await login(hrbpR.data.employee.id, `hrbp${stamp}@example.com`, ['hr_admin'], { hrScopeUnitIds: [sales] })
    const hr2R = await create({ firstName: 'Hr', lastName: 'Two', workEmail: `hr2${stamp}@example.com` })
    const hr2 = await login(hr2R.data.employee.id, `hr2${stamp}@example.com`, ['hr_admin'])
    const piaR = await create({ firstName: 'Pia', lastName: 'Pay', workEmail: `pia${stamp}@example.com` })
    const pia = await login(piaR.data.employee.id, `pia${stamp}@example.com`, ['payroll_admin'])

    // ── C. Business Partner scope on writes (Paul is in Operations, outside Sales)
    check((await call('PATCH', `/employees/${paulId}`, hrbp, { firstName: 'Pauly' })).status === 404, 'a Business Partner cannot edit a profile outside their departments')
    check((await call('PATCH', `/employees/${paulId}/bank`, hrbp, { bankName: 'zanaco', bankAccountNo: '1234567890' })).status === 404, '... nor bank details')
    check((await call('POST', '/profile-requests', hrbp, { employeeIds: [paulId], sections: ['personal'], kind: 'update' })).status === 404, '... nor send a request')
    check((await call('PUT', `/employees/${paulId}/access`, hrbp, { loginEnabled: true })).status === 404, '... nor change their login')
    check((await call('POST', `/employees/${paulId}/resume`, hrbp, { lineType: 'experience', name: 'X' })).status === 404, '... nor add a resume line')
    check((await call('POST', `/employees/${paulId}/archive`, hrbp, { reason: 'test' })).status === 404, '... nor archive them')
    check((await call('PATCH', `/employees/${maryId}`, hrbp, { firstName: 'Mary' })).status === 200, 'inside their departments they can edit')
    check((await create({ orgUnitId: ops }, hrbp)).status === 403, 'a Business Partner cannot add a person to a department they do not look after')

    // ── E. only a system admin grants payroll_admin
    const grant = await call('PUT', `/employees/${maryId}/access`, hr2, { roles: ['employee', 'payroll_admin'] })
    check(grant.status === 403 && /payroll/i.test(String(grant.body.message)), `an HR admin cannot hand out payroll_admin (${grant.status})`)
    check((await call('PUT', `/employees/${hr2R.data.employee.id}/access`, hr2, { roles: ['employee', 'hr_admin', 'payroll_admin'] })).status === 403, '... not even to themselves')
    check((await call('PUT', `/employees/${maryId}/access`, owner, { roles: ['employee', 'payroll_admin'] })).status === 200, 'a system admin can')
    await call('PUT', `/employees/${maryId}/access`, owner, { roles: ['employee'] })

    // ── D. bank verification belongs to payroll
    const hrVerify = await call('POST', `/employees/${maryId}/bank/verify`, hr2)
    check(hrVerify.status === 403, 'HR (not payroll) cannot verify bank details')
    const prof = await call('GET', `/employees/${maryId}`, pia)
    check(prof.status === 200 && prof.data.bankAccountLast4 === '7890' && prof.data.bankName, 'payroll sees the bank card (last four digits only)')
    const ver = await call('POST', `/employees/${maryId}/bank/verify`, pia)
    check(ver.status === 200 && ver.data.bankVerified === true, 'a payroll admin verifies bank details entered by someone else')

    // ── F. directory
    const sorted = async (q) => (await call('GET', `/employees?limit=100&${q}`, owner))
    const byName = (await sorted('sort=name&dir=desc')).body.data.map((e) => e.firstName)
    check(byName.join() === [...byName].sort((a, b) => b.localeCompare(a)).join(), 'the directory sorts by name, descending')
    const hd = (await sorted('sort=hireDate&dir=asc')).body.data
    check(hd.length > 2 && hd.every((e, i) => i === 0 || new Date(hd[i - 1].hireDate) <= new Date(e.hireDate)), 'the directory sorts by joining date')
    const dp = (await sorted('sort=department&dir=asc')).body.data.map((e) => e.orgUnit?.name ?? '')
    check(dp.join() === [...dp].sort((a, b) => a.localeCompare(b)).join(), 'the directory sorts by department')
    check((await sorted('search=Mary%20Banda')).body.data.map((e) => e.id).includes(maryId), 'a full-name search finds the person')
    check((await sorted('search=Banda%20Mary')).body.data.length === 1, 'the words can come in any order')
    check((await sorted('search=971%20234%20567')).body.data.map((e) => e.id).includes(maryId), 'a phone number is found through spaces')
    check((await sorted('search=0971')).body.data.length >= 0, 'a short digit search does not break')
    const sub = (await sorted(`orgUnitId=${sales}`)).body.data.map((e) => e.orgUnit?.name)
    check(sub.includes('Sales'), 'a department filter shows its people')
    const e1 = await create({ firstName: 'Eve', lastName: 'Emea', orgUnitId: emea, workEmail: `eve${stamp}@example.com` })
    check((await sorted(`orgUnitId=${sales}`)).body.data.some((e) => e.id === e1.data.employee.id), 'a department filter includes people in its sub-departments')
    check(!(await sorted(`orgUnitId=${sales}&subUnits=0`)).body.data.some((e) => e.id === e1.data.employee.id), '... unless asked for the department alone')
    // archive and status filter
    const ar = await call('POST', `/employees/${paulId}/archive`, owner, { reason: 'left', lastWorkingDay: addDays(-1) })
    check(ar.status === 200, 'a person with no reports can be archived')
    check((await sorted('status=archived')).body.data.every((e) => e.active === false) && (await sorted('status=archived')).body.data.length === 1, 'the archived view lists only archived people')
    check(!(await sorted('status=active')).body.data.some((e) => e.id === paulId) && (await sorted('status=all')).body.data.some((e) => e.id === paulId), 'status active hides them and all shows them')
    check((await db.collection('employees').findOne({ _id: paulId })).exitDate instanceof Date, 'the last working day is kept')
    // export
    const csv = await call('GET', '/employees/export?status=all', owner)
    check(csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type')) && /Employee ID/.test(csv.text) && /Mary/.test(csv.text), 'the CSV export downloads')
    check(!/bank|account|salary|identity/i.test(csv.text.split('\r\n')[0]), 'the CSV has no pay, bank or ID columns')
    const csvMgr = await call('GET', '/employees/export', dan)
    check(csvMgr.status === 200 && !/Work mobile/.test(csvMgr.text.split('\r\n')[0]), 'a manager gets the CSV without phone numbers')

    // ── B. archive rules
    const noMgr = await call('POST', `/employees/${danId}/archive`, owner, { reason: 'left' })
    check(noMgr.status === 400 && noMgr.body.code === 'REASSIGN_REPORTS', `archiving a manager needs a new manager for the reports (${noMgr.status} ${noMgr.body.code})`)
    check((await call('POST', `/employees/${danId}/archive`, owner, { reason: 'left', newManagerId: danId })).status === 400, 'the new manager cannot be the person leaving')
    check((await call('POST', `/employees/${danId}/archive`, owner, { reason: 'left', newManagerId: paulId })).status === 404, 'the new manager must be someone who is here')
    check((await call('POST', `/employees/${su.data.user.employee.id}/archive`, owner, { reason: 'self' })).status === 400, 'you cannot archive yourself')
    const moved = await call('POST', `/employees/${danId}/archive`, owner, { reason: 'left', newManagerId: hr2R.data.employee.id })
    check(moved.status === 200, 'with a new manager the archive goes through')
    check((await db.collection('employees').findOne({ _id: maryId })).managerId === hr2R.data.employee.id, 'the reports moved to the new manager')
    check((await call('PATCH', `/employees/${danId}`, owner, { firstName: 'Danny' })).status === 400, 'an archived person cannot be edited')
    check((await call('PATCH', `/employees/${danId}/bank`, owner, { bankName: 'zanaco', bankAccountNo: '1234567890' })).status === 400, '... nor their bank details')
    const acc = await call('GET', `/employees/${danId}/access`, owner)
    check(acc.data.archived === true && acc.data.loginEnabled === false, 'the login card does not show an archived person as enabled')
    check((await call('PUT', `/employees/${danId}/access`, owner, { loginEnabled: true })).status === 400, 'an archived person cannot be given a login')
    const back = await call('POST', `/employees/${danId}/reinstate`, owner)
    check(back.status === 200 && back.data.loginEnabled === false && /login/i.test(back.data.message), 'reinstate works and says the login stays off')
    check((await call('GET', `/employees/${danId}/access`, owner)).data.loginEnabled === false, 'the login is still off after reinstating')
    check((await call('PATCH', `/employees/${danId}`, owner, { firstName: 'Dan' })).status === 200, 'a reinstated person can be edited again')
    check((await call('POST', `/employees/${danId}/reinstate`, owner)).status === 400, 'reinstating someone who is not archived is refused')
    check(!!(await db.collection('audit_logs').findOne({ tenantId, action: 'EMPLOYEE_REINSTATED', entityId: danId })), 'reinstating is audited')

    // ── G. skills and resume for oneself
    check((await call('GET', '/employees/skill-types', marytok)).status === 200, 'an employee can read the skill catalogue')
    check((await call('POST', `/employees/${maryId}/resume`, marytok, { lineType: 'experience', name: 'Cashier', dateStart: '2019-01-01', dateEnd: '2020-01-01' })).status === 201, 'a person adds their own resume line')
    check((await call('POST', `/employees/${maryId}/resume`, marytok, { lineType: 'experience', name: 'Bad', dateStart: '2020-01-01', dateEnd: '2019-01-01' })).status === 400, 'a resume end date before the start is refused')
    check((await call('POST', `/employees/${maryId}/resume`, marytok, { lineType: 'experience', name: 'Bad', dateStart: 'xyz' })).status === 400, 'a resume date that is not a date is refused')
    check((await call('POST', `/employees/${hr2R.data.employee.id}/resume`, marytok, { lineType: 'experience', name: 'Sneaky' })).status === 403, 'a person cannot edit someone else\'s resume')
    const lines = (await call('GET', `/employees/${maryId}`, owner)).data.resumeLines
    check(lines.length === 1, 'the resume line shows on the profile')
    const lineId = lines[0].id
    check((await call('PATCH', `/employees/${maryId}/resume/${lineId}`, marytok, { dateEnd: '2018-01-01' })).status === 400, 'editing the end date to before the start is refused')
    check((await call('DELETE', `/employees/${maryId}/resume/${lineId}`, marytok)).status === 200, 'a person removes their own resume line')

    // ── H. org chart flags
    const eveId = e1.data.employee.id
    await db.collection('employees').updateOne({ _id: eveId }, { $set: { managerId: paulId } }) // Paul is archived
    const chart = (await call('GET', '/employees/org-chart', owner)).data.people
    check(chart.find((p) => p.id === eveId)?.managerMissing === true, 'a person whose manager has left is flagged for the Unassigned group')
    check(chart.some((p) => p.isHead === true), 'a department head is flagged')

    // ── I. requests
    check((await call('POST', '/profile-requests', owner, { employeeIds: [maryId], sections: ['personal'], kind: 'update', dueDate: addDays(-2) })).status === 400, 'a due date in the past is refused')
    const noLoginPerson = await create({ firstName: 'Nol', lastName: 'Login', workEmail: `nol${stamp}@example.com` })
    const rq0 = await call('POST', '/profile-requests', owner, { employeeIds: [noLoginPerson.data.employee.id], sections: ['contact'], kind: 'update' })
    check(rq0.status === 201 && rq0.data.noLogin?.length === 1, 'a request to someone with no login says so')
    const rq = await call('POST', '/profile-requests', owner, { employeeIds: [maryId], sections: ['personal', 'education'], kind: 'update', dueDate: addDays(5) })
    check(rq.status === 201 && (rq.data.noLogin ?? []).length === 0, 'a request to someone who can sign in is created')
    const dupReq = await call('POST', '/profile-requests', owner, { employeeIds: [maryId], sections: ['personal'], kind: 'update' })
    check(dupReq.status === 409, 'the same section cannot be asked twice while it is open')
    const mine = await call('GET', '/profile-requests?mine=1', marytok)
    const rid = mine.data[0].id
    check(mine.data[0].sections.every((s) => s.filled === false || s.filled === true), 'the person sees which sections are filled')
    const emptySubmit = await call('POST', `/profile-requests/${rid}/sections/education/submit`, marytok)
    check(emptySubmit.status === 400, `an empty section cannot be submitted (${emptySubmit.status} ${String(emptySubmit.body.message).slice(0, 60)})`)
    const ed = await call('POST', `/employees/${maryId}/record/education`, marytok, { qualification: 'diploma', institute: 'City College' })
    check(ed.status === 201, 'the person fills the education section')
    check((await call('POST', `/profile-requests/${rid}/sections/education/submit`, marytok)).status === 200, 'then it can be submitted')
    const hrList = await call('GET', '/profile-requests?q=mary', owner)
    check(hrList.data.some((r) => r.employeeId === maryId) && !hrList.data.some((r) => r.employeeId === noLoginPerson.data.employee.id), 'HR can search the request list by person')
    check((await call('GET', `/profile-requests?status=open`, owner)).data.length >= 1 && (await call('GET', `/profile-requests?status=cancelled`, owner)).status === 200, 'HR can filter by status, cancelled included')
    check((await call('GET', '/profile-requests', hrbp)).data.every((r) => r.employeeId !== paulId), 'a Business Partner sees only requests of people in their departments')
    await db.collection('profile_requests').updateOne({ _id: rid }, { $set: { dueDate: new Date(`${addDays(-1)}T00:00:00.000Z`) } })
    check((await call('GET', '/profile-requests?mine=1', marytok)).data[0].overdue === true, 'a request past its due date is marked overdue')
    const job = await call('POST', '/system/jobs/request-reminders/run', owner)
    check(job.status === 200, `the reminder job runs (${job.status})`)
    await new Promise((r) => setTimeout(r, 400))
    const maryUser = (await db.collection('employees').findOne({ _id: maryId })).userId
    check(!!(await db.collection('notifications').findOne({ userId: maryUser, type: 'profile.reminder' })), 'an overdue request reminds the person')

    // ── bulk import checks (dry run)
    const imp = (rows) => call('POST', '/employees/import', owner, { rows, dryRun: true, createMissing: false, grantLogin: false })
    const good = { first_name: 'Imp', last_name: 'One', work_email: `imp1${stamp}@example.com`, hire_date: '2025-02-01', department: 'Sales' }
    const r1 = await imp([{ ...good, hire_date: '2099-01-01' }, { ...good, work_email: `imp2${stamp}@example.com`, date_of_birth: '2031-01-01' }, { ...good, work_email: `imp3${stamp}@example.com`, mobile: 'abc' }, { ...good, work_email: `imp4${stamp}@example.com`, mobile: '+260 971 234 567' }, { ...good, work_email: `imp5${stamp}@example.com` }])
    const st = r1.data.rows.map((r) => r.status)
    check(st.join() === 'error,error,error,error,ok', `the import dry run refuses a future joining date, a future birth date, a bad mobile and a taken mobile (${st.join()})`)
    console.log(`${passed} passed, ${failed} failed`)
  } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      const ids = emps.map((e) => e._id)
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: ids } })
      for (const c of ['resume_lines', 'employee_education', 'employee_addresses', 'employee_family_members', 'employee_emergency_contacts', 'employee_identities', 'employee_previous_employments', 'profile_request_sections']) await db.collection(c).deleteMany({ employeeId: { $in: ids } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
  }
})().catch((e) => { console.error(e); process.exit(1) })

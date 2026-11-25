// Home on the MongoDB API: notifications for approval requests and decisions, tasks (who may make and cancel), the unified approvals inbox,
// the dashboard on real data, and the helpdesk upgrades (notifications, files, filters, response clock, categories, auto-close, escalation).
// Start the API with STORAGE_PROVIDER=memory:
//   API=http://localhost:4241 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-home.test.js
// Do not run it in the first hours after local midnight: it clocks in and files "yesterday" requests.
process.env.STORAGE_PROVIDER = 'memory'
process.env.DB_PROVIDER = 'mongo'
const mongoose = require('mongoose')
const crypto = require('crypto')
const API = (process.env.API || 'http://localhost:4200') + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data, text }
}
async function upload(path, token, file, fields = {}) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('file', new Blob([file.bytes], { type: file.type }), file.name)
  const res = await fetch(API + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PNG = { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), type: 'image/png', name: 'screenshot.png' }
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

;(async () => {
  const stamp = Date.now(), email = `home${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Home Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    await call('PUT', '/company/plan', owner, { plan: 'enterprise' })
    await call('PUT', '/company/modules', owner, { modules: ['attendance', 'leave', 'payroll', 'expenses', 'exits'] })
    await call('PATCH', '/company', owner, { primaryCountry: 'ZM', baseCurrency: 'ZMW' })
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n) => (await call('POST', '/employees', owner, { firstName: n, lastName: 'Tester', workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const ids = {}, tok = {}
    for (const [n, roles] of [['Dan', ['manager']], ['Mary', ['employee']], ['Paul', ['employee']], ['Ann', ['employee']]]) { ids[n] = await mk(n); tok[n] = await login(owner, ids[n], `${n.toLowerCase()}${stamp}@example.com`, roles) }
    await db.collection('employees').updateMany({ _id: { $in: [ids.Mary, ids.Paul, ids.Ann] } }, { $set: { managerId: ids.Dan } })
    const owner_emp = su.data.user.employee.id
    const titles = async (t, type) => ((await call('GET', '/notifications?limit=100', t)).data?.items ?? []).filter((n) => !type || n.type.startsWith(type)).map((n) => n.title)

    // ═════ approval requests tell the manager, decisions tell the person ═════
    const lt = (await call('GET', '/leave/types', tok.Mary)).data[0]
    const leave = await call('POST', '/leave/requests', tok.Mary, { leaveTypeId: lt.id, startDate: day(7), endDate: day(8), reason: 'Family event' })
    const reg = await call('POST', '/attendance/regularisations', tok.Mary, { date: day(-1), actualIn: '09:00', actualOut: '17:30', reason: 'Forgot to punch' })
    const ot = await call('POST', '/attendance/overtime', tok.Paul, { date: day(-1), overtimeHours: 2, reason: 'Month end' })
    check(leave.status === 201 && reg.status === 201 && ot.status === 201, `Mary asks for leave and a fix, Paul for overtime (${leave.status} ${reg.status} ${ot.status})`)
    const dan1 = await titles(tok.Dan)
    check(dan1.some((t) => /missed-punch fix waiting/.test(t)), `Dan is told about the missed-punch fix (${dan1.join(' | ')})`)
    check(dan1.some((t) => /overtime request waiting/.test(t)), 'and about the overtime request')

    // work that is not an approval chain item: an expense, a timesheet
    const cats = (await call('GET', '/expenses/categories', tok.Mary)).data
    const claim = await call('POST', '/expenses/claims', tok.Mary, { claimType: 'actual', categoryId: cats[0].id, expenseDate: day(-2), description: 'Taxi to client', receiptNumber: 'R-1', expenseCurrency: 'ZMW', expenseAmount: 150 })
    await db.collection('ts_weeks').insertOne({ _id: crypto.randomUUID(), tenantId, employeeId: ids.Ann, weekStart: '2026-11-16', status: 'submitted', entries: [{ date: '2026-11-16', hours: 8, task: 'x', projectId: crypto.randomUUID() }], submittedAt: new Date(), createdAt: new Date(), updatedAt: new Date() })

    // ═════ the inbox ═════
    const inbox = await call('GET', '/approvals/inbox', tok.Dan)
    const types = (inbox.data?.items ?? []).map((i) => i.type)
    check(inbox.status === 200 && ['leave', 'regularisation', 'overtime', 'expense', 'timesheet'].every((t) => types.includes(t)), `Dan's inbox holds leave, fix, overtime, expense and timesheet (${types.join(',')})`)
    check(inbox.data.total === 5 && inbox.data.groups.time === 4 && inbox.data.groups.money === 1, `with the right totals (${JSON.stringify(inbox.data.groups)})`)
    const item = (type) => inbox.data.items.find((i) => i.type === type)
    check(item('leave').approve.path.startsWith('/approvals/leave/') && item('leave').reject.needsNote && item('expense').reject.noteField === 'reason' && item('timesheet').reject.body.approve === false, 'each item says how to approve and reject it')
    check(item('leave').employee === 'Mary Tester' && /Annual|Leave/i.test(item('leave').summary) && !!item('leave').at, `with who asked and what (${item('leave').summary})`)
    check((await call('GET', '/approvals/inbox', tok.Mary)).data.total === 0, 'Mary, who approves nothing, has an empty inbox')
    check((await call('GET', '/approvals/inbox', owner)).data.total >= 5, 'HR sees everything waiting too')
    check((await call('GET', '/approvals/inbox/count', tok.Dan)).data.total === 5, 'and the count endpoint agrees')

    // decide through the inbox's own actions
    const act = async (a, note) => call('POST', a.path, tok.Dan, { ...(a.body ?? {}), ...(note && a.noteField ? { [a.noteField]: note } : {}) })
    check((await act(item('regularisation').approve, 'ok')).status === 200, 'Dan approves the fix from the inbox')
    check((await act(item('overtime').reject)).status === 400, 'rejecting without a note is refused')
    check((await act(item('overtime').reject, 'Not agreed beforehand')).status === 200, 'and rejects the overtime with a note')
    check((await call('POST', item('leave').approve.path, tok.Dan, { ...item('leave').approve.body, shortfall: 'unpaid', comments: 'Enjoy' })).status === 200, 'approves the leave (choosing unpaid for the part beyond the balance)')
    check((await act(item('expense').approve)).status === 200, 'approves the expense (manager step)')
    check((await act(item('timesheet').approve)).status === 200, 'and the timesheet')
    const after = await call('GET', '/approvals/inbox', tok.Dan)
    check(after.data.total === 0, `the inbox empties (${after.data.total})`)
    const mary1 = await titles(tok.Mary)
    check(mary1.some((t) => /attendance fix was approved/.test(t)), `Mary is told the fix was approved (${mary1.join(' | ')})`)
    check((await titles(tok.Paul)).some((t) => /overtime request was not approved/.test(t)), 'Paul is told the overtime was not approved')
    check((await call('GET', '/approvals/inbox', owner)).data.items.some((i) => i.type === 'expense_finance'), 'the approved expense now waits in finance, which HR can see')

    // ═════ the dashboard shows real data ═════
    await call('POST', '/attendance/clock-in', tok.Mary, { method: 'web' })
    await call('POST', '/leave/requests', tok.Mary, { leaveTypeId: lt.id, startDate: day(20), endDate: day(20), reason: 'Appointment' })
    const at = await db.collection('activity_types').findOne({ tenantId })
    const sys = crypto.randomUUID()
    await db.collection('activities').insertOne({ _id: sys, tenantId, activityTypeId: at._id, entityType: 'employee', entityId: ids.Mary, title: 'Upload your ID copy', assignedToId: ids.Mary, createdBy: 'system', dueDate: new Date(Date.now() - 2 * 86400000), status: 'planned', createdAt: new Date(), updatedAt: new Date() })
    const dm = (await call('GET', '/dashboard', tok.Mary)).data
    check(dm.self.attendance && dm.self.attendance.today.clockedIn === true && dm.self.attendance.last7.length === 7, `Mary's dashboard has her clock-in and hours (${JSON.stringify(dm.self.attendance?.today)})`)
    check(dm.self.leave && Array.isArray(dm.self.leave.balances) && dm.self.leave.upcoming.length >= 1, 'her leave balances and the next leave')
    check(dm.self.tasks.open === 1 && dm.self.tasks.overdue === 1 && dm.self.tasks.items[0].title === 'Upload your ID copy', 'her open and overdue tasks')
    const dd = (await call('GET', '/dashboard', tok.Dan)).data
    check(dd.team.size === 3 && dd.team.people.length === 3 && dd.team.today && dd.team.today.in === 1, `Dan's team: three people, one in (${JSON.stringify(dd.team.today)})`)
    check(dd.team.approvals.total === 1 && dd.team.approvals.items[0].type === 'leave', `his approvals are real (${dd.team.approvals.total})`)
    const co = (await call('GET', '/dashboard', owner)).data
    check(co.company.headcount === 5 && co.team.approvals.total >= 1, 'HR sees the company headcount and the same inbox')
    // each person chooses which dashboard cards they see, and how they are arranged
    check((await call('GET', '/dashboard/layout', tok.Dan)).data.hidden.length === 0, 'by default nothing is hidden')
    check((await call('PUT', '/dashboard/layout', tok.Dan, { hidden: ['week_leave', 'hours', 'week_leave'] })).data.hidden.length === 2, 'Dan hides two cards')
    check((await call('PUT', '/dashboard/layout', tok.Dan, { slots: { 'slot-0': 'approvals', 'slot-1': 'kpi_team' } })).data.hidden.length === 2, 'arranging the rest leaves what he hid alone')
    check((await call('PUT', '/dashboard/layout', tok.Dan, { hidden: ['Bad Id!'] })).status === 400 && (await call('PUT', '/dashboard/layout', tok.Dan, { slots: { 'half-0': 'x' } })).status === 400, 'odd ids are refused')
    check((await call('GET', '/dashboard/layout', tok.Mary)).data.hidden.length === 0, "and it is Dan's own, not shared")
    const back = await call('PUT', '/dashboard/layout', tok.Dan, { slots: null, hidden: [] })
    check(back.data.slots === null && back.data.hidden.length === 0, 'reset clears both')
    const cm = (await call('GET', '/dashboard/counts', tok.Mary)).data
    const cd = (await call('GET', '/dashboard/counts', tok.Dan)).data
    check(cm.tasks === 1 && cd.approvals === 1, `the sidebar numbers are real (Mary tasks ${cm.tasks}, Dan approvals ${cd.approvals})`)

    // the "Next steps" checklist on the HR dashboard (it never loaded on MongoDB before)
    const setup = await call('GET', '/company/setup-status', owner)
    check(setup.status === 200 && setup.data.steps.length >= 8 && setup.data.steps.find((s) => s.key === 'people').done === true && setup.data.steps.find((s) => s.key === 'reporting').done === true && setup.data.steps.find((s) => s.key === 'managers').done === true, `the setup checklist loads and reads the company (${short(setup).slice(0, 120)})`)
    check((await call('GET', '/company/setup-status', tok.Mary)).status === 403, 'and only admins can see it')

    // ═════ tasks ═════
    const task = (extra) => ({ activityTypeId: at._id, title: 'Task', dueDate: day(3), assignedToId: ids.Mary, ...extra })
    check((await call('GET', '/activities/types', tok.Mary)).data?.length > 0, 'people can see the task types')
    const own = await call('POST', '/activities', tok.Mary, task({ title: 'Book my flight' }))
    check(own.status === 201 && own.data.createdBy, `Mary makes a task for herself (${own.status})`)
    check((await call('POST', '/activities', tok.Mary, task({ assignedToId: ids.Paul }))).status === 403, 'but not for Paul')
    check((await call('POST', '/activities', tok.Mary, { ...task(), dueDate: undefined })).status === 400, 'a due date is required')
    check((await call('POST', '/activities', tok.Mary, { ...task(), entityType: 'employee' })).status === 400, 'a link needs both its kind and its record')
    const fromDan = await call('POST', '/activities', tok.Dan, task({ title: 'Send me your report', note: 'By Friday', entityType: 'employee', entityId: ids.Mary }))
    check(fromDan.status === 201, 'Dan makes one for Mary, about her record')
    check((await titles(tok.Mary, 'task.')).some((t) => /Send me your report/.test(t)), 'and Mary is told')
    check((await call('POST', '/activities', tok.Dan, task({ assignedToId: owner_emp }))).status === 403, 'Dan cannot make one for HR (not in his team)')
    check((await call('POST', '/activities', tok.Paul, task({ assignedToId: ids.Paul, entityType: 'employee', entityId: ids.Mary }))).status === 404, 'nobody links a record they cannot see')
    const fromHr = await call('POST', '/activities', owner, task({ assignedToId: ids.Paul, title: 'Sign the policy' }))
    check(fromHr.status === 201, 'HR makes one for anyone')
    const mine = (await call('GET', '/activities/mine', tok.Mary)).data
    const sent = mine.find((t) => t.title === 'Send me your report')
    check(sent.createdByName === 'Dan Tester' && sent.about.label === 'Mary Tester' && sent.about.path === `/employees/${ids.Mary}`, `Mary sees who it is from and what it is about (${sent?.createdByName})`)
    check(mine.find((t) => t.title === 'Upload your ID copy').createdByName === 'Automatic', 'automatic tasks say so')
    check((await call('GET', '/activities/created', tok.Dan)).data.some((t) => t.title === 'Send me your report'), "Dan sees the tasks he made for others")
    check((await call('POST', `/activities/${fromDan.data.id}/cancel`, tok.Mary)).status === 403, 'Mary cannot cancel Dan\'s task')
    check((await call('POST', `/activities/${fromDan.data.id}/cancel`, tok.Dan)).status === 200, 'Dan, who made it, can')
    check((await call('POST', `/activities/${own.data.id}/cancel`, tok.Mary)).status === 200, 'Mary cancels her own')
    check((await call('POST', `/activities/${fromHr.data.id}/cancel`, tok.Dan)).status === 403, 'a manager cannot cancel HR\'s task')
    check((await call('POST', `/activities/${sys}/cancel`, tok.Paul)).status === 403, 'someone else cannot dismiss an automatic task')
    check((await call('POST', `/activities/${sys}/cancel`, tok.Mary)).status === 200, 'its owner can')
    check((await call('POST', `/activities/${fromHr.data.id}/complete`, tok.Paul, { doneNote: '' })).status === 200, 'completing needs no note')

    // ═════ helpdesk ═════
    const cat = (await call('GET', '/helpdesk/categories', tok.Mary)).data.find((c) => c.name === 'Leave')
    const tk = await call('POST', '/helpdesk/tickets', tok.Mary, { categoryId: cat.id, subject: 'Leave balance looks wrong', description: 'I should have 21 days' })
    check(tk.status === 201, 'Mary raises a ticket')
    check((await titles(owner, 'helpdesk.')).some((t) => /New ticket HD-0001/.test(t)), 'HR is told about it')
    const t0 = (await call('GET', `/helpdesk/tickets/${tk.data.id}`, owner)).data
    const hrs = (a, b) => Math.round((new Date(a) - new Date(b)) / 360000) / 10
    check(Math.abs(hrs(t0.dueAt, t0.createdAt) - 24) < 0.2, `a normal ticket is due in the category's 24 hours (${hrs(t0.dueAt, t0.createdAt)})`)
    const urgent = await call('PATCH', `/helpdesk/tickets/${tk.data.id}`, owner, { priority: 'urgent', assigneeUserId: su.data.user.id })
    check(Math.abs(hrs(urgent.data.dueAt, t0.createdAt) - 6) < 0.2 && urgent.data.assigneeUserId === su.data.user.id, 'urgent cuts the target to a quarter')
    const staff = await call('GET', '/helpdesk/staff', owner)
    check(staff.data.length >= 1 && (await call('GET', '/helpdesk/staff', tok.Mary)).status === 403, 'HR can see who a ticket can go to, employees cannot')
    const before = (await call('GET', `/helpdesk/tickets/${tk.data.id}`, owner)).data.dueAt
    await call('PATCH', `/helpdesk/tickets/${tk.data.id}`, owner, { status: 'waiting' })
    check((await titles(tok.Mary, 'helpdesk.')).some((t) => /is waiting for your reply/.test(t)), 'Mary is told it waits on her')
    await sleep(1300)
    const reply = await call('POST', `/helpdesk/tickets/${tk.data.id}/comments`, tok.Mary, { body: 'Here are the details' })
    const resumed = reply.data
    check(resumed.status === 'in_progress' && new Date(resumed.dueAt) - new Date(before) >= 1000, `her reply puts it back in progress and the clock paused while it waited (+${new Date(resumed.dueAt) - new Date(before)} ms)`)
    check((await titles(owner, 'helpdesk.')).some((t) => /Mary Tester replied/.test(t)), 'the owner is told she replied')
    await call('POST', `/helpdesk/tickets/${tk.data.id}/comments`, owner, { body: 'Checking with payroll', internal: true })
    await call('POST', `/helpdesk/tickets/${tk.data.id}/comments`, owner, { body: 'Fixed, please look' })
    check((await titles(tok.Mary, 'helpdesk.')).some((t) => /replied/.test(t)) && !(await titles(tok.Mary, 'helpdesk.')).some((t) => /payroll/.test(t)), 'her reply notice appears, internal notes never notify her')

    // files
    check((await upload(`/helpdesk/tickets/${tk.data.id}/attachments`, tok.Mary, PNG)).status === 201, 'Mary attaches a screenshot')
    const internalFile = await upload(`/helpdesk/tickets/${tk.data.id}/attachments`, owner, { ...PNG, name: 'internal.png' }, { internal: 'true' })
    check(internalFile.status === 201, 'HR attaches an internal file')
    check((await upload(`/helpdesk/tickets/${tk.data.id}/attachments`, tok.Mary, { bytes: Buffer.from('x'), type: 'text/plain', name: 'x.txt' })).status === 400, 'only photos and PDFs')
    check((await upload(`/helpdesk/tickets/${tk.data.id}/attachments`, tok.Mary, { bytes: Buffer.alloc(5 * 1024 * 1024 + 10), type: 'image/png', name: 'big.png' })).status === 400, 'a file over 5 MB is refused')
    const mv = (await call('GET', `/helpdesk/tickets/${tk.data.id}`, tok.Mary)).data
    check(mv.attachments.length === 1 && !mv.attachments[0].key && mv.comments.every((c) => !c.internal), 'Mary sees her file only, no internal notes, no storage keys')
    const sv = (await call('GET', `/helpdesk/tickets/${tk.data.id}`, owner)).data
    check(sv.attachments.length === 2 && sv.assigneeName === 'Hana Owner' && sv.requesterName === 'Mary Tester', 'HR sees both and the names')
    check((await call('GET', `/helpdesk/tickets/${tk.data.id}/attachments/${mv.attachments[0].id}`, tok.Mary)).data?.url?.length > 5, 'Mary can open her file')
    check((await call('GET', `/helpdesk/tickets/${tk.data.id}/attachments/${sv.attachments.find((a) => a.internal).id}`, tok.Mary)).status === 404, 'but not the internal one')

    // search, filters, paging, categories
    const t2 = await call('POST', '/helpdesk/tickets', tok.Paul, { categoryId: (await call('GET', '/helpdesk/categories', tok.Paul)).data.find((c) => c.name === 'Payroll and payslips').id, subject: 'Payslip missing', description: 'October payslip not showing', priority: 'high' })
    const list = (q) => call('GET', `/helpdesk/tickets?scope=all&${q}`, owner)
    check((await list('q=payslip')).data.total === 1 && (await list('q=HD-0001')).data.total === 1, 'search by words and by number')
    check((await list(`categoryId=${cat.id}`)).data.total === 1 && (await list('priority=high')).data.total === 1, 'filter by category and priority')
    check((await list('assignee=me')).data.total === 1 && (await list('assignee=none')).data.total === 1, 'filter by owner and unassigned')
    check((await list('status=active')).data.counts.open >= 1 && (await list('limit=1&page=2')).data.items.length === 1 && (await list('limit=1')).data.pages === 2, 'status counts and paging')
    check((await call('GET', '/helpdesk/tickets?scope=all', tok.Paul)).data.total === 1, 'an employee still only sees their own')
    const editCat = await call('PATCH', `/helpdesk/categories/${cat.id}`, owner, { name: 'Leave and time off', responseHours: 12 })
    check(editCat.status === 200 && editCat.data.responseHours === 12, 'HR renames a category and changes its target')
    await call('PATCH', `/helpdesk/categories/${cat.id}`, owner, { active: false })
    check(!(await call('GET', '/helpdesk/categories', tok.Mary)).data.some((c) => c.id === cat.id) && (await call('GET', '/helpdesk/categories?all=1', owner)).data.some((c) => c.id === cat.id), 'a switched-off category disappears for people but not for HR')
    check((await call('POST', '/helpdesk/tickets', tok.Mary, { categoryId: cat.id, subject: 'Again', description: 'again' })).status === 404, 'and cannot be picked')
    check((await call('PATCH', `/helpdesk/categories/${cat.id}`, tok.Mary, { active: true })).status === 403, 'only HR edits categories')

    // closing by itself and escalation (the hourly job)
    require('../../dist/mongo-mode')
    const { helpdeskMaintenance } = require('../../dist/modules/helpdesk/helpdesk.mongo.router')
    await call('PATCH', `/helpdesk/tickets/${tk.data.id}`, owner, { status: 'resolved' })
    await db.collection('helpdesk_tickets').updateOne({ _id: tk.data.id }, { $set: { resolvedAt: new Date(Date.now() - 8 * 86400000) } })
    await db.collection('helpdesk_tickets').updateOne({ _id: t2.data.id }, { $set: { dueAt: new Date(Date.now() - 3600000) } })
    const done = await helpdeskMaintenance(tenantId)
    check(done === 2, `the job closes the old resolved ticket and flags the late one (${done})`)
    check((await call('GET', `/helpdesk/tickets/${tk.data.id}`, owner)).data.status === 'closed', 'the resolved ticket is closed')
    check((await call('GET', `/helpdesk/tickets/${t2.data.id}`, owner)).data.overdue === true && (await titles(owner, 'helpdesk.')).some((t) => /past its response target/.test(t)), 'the late ticket is overdue and HR is told')
    check((await helpdeskMaintenance(tenantId)) === 0, 'and nothing happens twice')
    check((await list('overdue=1')).data.total === 1, 'the overdue filter finds it')

    // leave decisions reach the person too (delivered by the event pump every 5 s)
    await sleep(7000)
    check((await titles(tok.Mary, 'leave.')).length >= 1 || (await titles(tok.Mary)).some((t) => /leave/i.test(t)), `Mary is told her leave was decided (${(await titles(tok.Mary)).filter((t) => /leave/i.test(t)).join(' | ')})`)
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('counters').deleteOne({ _id: `helpdesk:${tenantId}` })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

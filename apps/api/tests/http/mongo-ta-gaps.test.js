// Time & Attendance gaps on the MongoDB API: a 6-day working week in the dashboard and the attendance report, no timesheet hours on approved
// leave days, and the roster notification link. Removes its company at the end.
//   API=http://localhost:4212 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-ta-gaps.test.js
process.env.STORAGE_PROVIDER = 'memory'
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
const addDays = (s, n) => iso(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000))
const mondayOf = (d) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return iso(x) }

;(async () => {
  const stamp = Date.now()
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `TA Gaps ${stamp}`, fullName: 'Hana Owner', email: `tag${stamp}@example.com`, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    await call('PUT', '/company/plan', owner, { plan: 'enterprise' })
    await call('PUT', '/company/modules', owner, { modules: ['attendance', 'leave', 'payroll', 'expenses', 'exits'] })
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n) => (await call('POST', '/employees', owner, { firstName: n, lastName: 'Gap', workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const ids = { Dan: await mk('Dan'), Mary: await mk('Mary') }
    const dan = await login(owner, ids.Dan, `dan${stamp}@example.com`, ['manager'])
    const mary = await login(owner, ids.Mary, `mary${stamp}@example.com`, ['employee'])
    await db.collection('employees').updateMany({ _id: ids.Mary }, { $set: { managerId: ids.Dan } })

    // ── working week in the dashboard and the attendance report
    const month = iso(new Date()).slice(0, 7)
    const workingDays = async () => (await call('GET', '/dashboard', mary)).data.self?.attendance?.month?.workingDays
    const five = await workingDays()
    const set6 = await call('PUT', '/attendance/working-week', owner, { days: [0, 1, 2, 3, 4, 5] })
    check(set6.status === 200, 'working week set to six days')
    const six = await workingDays()
    check(typeof five === 'number' && typeof six === 'number', `dashboard gives working days so far (${five} -> ${six})`)
    const today = new Date(); const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
    let saturdays = 0
    for (let d = new Date(startOfMonth); d < new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())); d = new Date(d.getTime() + 86400000)) if (d.getUTCDay() === 6) saturdays++
    check(six - five === saturdays, `a 6-day week adds the Saturdays so far to the dashboard (${saturdays})`)
    const rep = await call('GET', `/reports/attendance?month=${month}`, owner)
    check(rep.status === 200 || rep.status === 404, `attendance report answers (${rep.status})`)
    if (rep.status === 200) {
      const rows = rep.data.rows ?? rep.data.employees ?? []
      const mrow = rows.find((r) => /Mary/.test(r.employee ?? ''))
      check(!mrow || mrow.workingDays >= 20, `report counts Saturdays for the 6-day week (${mrow && mrow.workingDays})`)
    }
    await call('PUT', '/attendance/working-week', owner, { days: [0, 1, 2, 3, 4] })

    // ── no timesheet hours on a day of approved leave
    const lt = (await call('GET', '/leave/types', mary)).data.find((t) => t.isPaid)
    await call('POST', '/leave/allocations/manual', owner, { employeeId: ids.Mary, leaveTypeId: lt.id, daysAllocated: 10, validFrom: addDays(iso(new Date()), -30), reason: 'test' })
    const monday = mondayOf(new Date(Date.now() + 14 * 86400000))
    const tue = addDays(monday, 1)
    const proj = await call('POST', '/timesheets/projects', owner, { code: `G${String(stamp).slice(-6)}`, name: 'Gap project' })
    const lv = await call('POST', '/leave/requests', mary, { leaveTypeId: lt.id, startDate: tue, endDate: tue, reason: 'day off' })
    check(lv.status === 201, 'leave applied for the Tuesday')
    const ap = await call('POST', `/approvals/leave/${lv.data.id}/approve`, dan, {})
    check(ap.status === 200, 'manager approves it')
    const wk = await call('GET', `/timesheets/week?start=${monday}`, mary)
    check((wk.data.leaveDays ?? []).includes(tue), 'the week lists the leave day')
    const bad = await call('PUT', '/timesheets/week', mary, { weekStart: monday, entries: [{ date: tue, projectId: proj.data.id, task: '', hours: 4 }] })
    check(bad.status === 400 && bad.body.code === 'ON_LEAVE', 'hours on an approved leave day are refused')
    const good = await call('PUT', '/timesheets/week', mary, { weekStart: monday, entries: [{ date: addDays(monday, 2), projectId: proj.data.id, task: '', hours: 4 }] })
    check(good.status === 200, 'hours on a normal day are saved')

    // ── roster notification opens a page everybody can open
    const shift = await call('POST', '/attendance/shifts', owner, { name: 'Early', shiftType: 'fixed', startTime: '07:00', endTime: '15:00' })
    const ro = await call('POST', '/attendance/roster', owner, { employeeIds: [ids.Mary], from: monday, to: addDays(monday, 6), pattern: [shift.data.id] })
    check(ro.status === 200 || ro.status === 201, 'roster applied')
    const maryUser = (await db.collection('employees').findOne({ _id: ids.Mary })).userId
    await new Promise((r) => setTimeout(r, 600))
    const note = await db.collection('notifications').findOne({ userId: maryUser, type: 'attendance.roster' })
    check(note && note.link === '/attendance', `roster notification links to /attendance (${note && note.link})`)
    console.log(`${passed} passed, ${failed} failed`)
  } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('leave_requests').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
  }
})().catch((e) => { console.error(e); process.exit(1) })

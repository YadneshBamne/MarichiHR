// Time & Attendance, people side, on the MongoDB API: timesheets (withdraw, HR reopen, notifications, archived projects), clock-in checks
// (a rejection tells the person and opens a task, bulk accept), field tracking (night-shift hours, local-day trail, "stopped reporting" job)
// and the terminal timezone. Removes its company at the end. Start the API with STORAGE_PROVIDER=memory, then:
//   API=http://localhost:4252 DIST=../../dist-b DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-ta-people.test.js
process.env.STORAGE_PROVIDER = 'memory'
const mongoose = require('mongoose')
const API = (process.env.API || 'http://localhost:4200') + '/api/v1'
const DIST = process.env.DIST || '../../dist'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data }
}
async function form(method, path, token, fields, file) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v))
  if (file) fd.append('selfie', new Blob([file.bytes], { type: file.type }), file.name)
  const res = await fetch(API + path, { method, headers: { Authorization: `Bearer ${token}` }, body: fd })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const PNG = { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), type: 'image/png', name: 'me.png' }
const iso = (d) => d.toISOString().slice(0, 10)
const mondayOf = (d) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x }
const addDays = (s, n) => iso(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const stamp = Date.now(), email = `tap${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `TA People ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const danId = await mk('Dan', 'Zulu'), maryId = await mk('Mary', 'Banda'), paulId = await mk('Paul', 'Mwale')
    const dan = await login(owner, danId, `dan${stamp}@example.com`, ['manager'])
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danId } })
    check((await call('PUT', '/company/plan', owner, { plan: 'enterprise', addons: ['gpsTracking', 'timesheets', 'biometricDevices'] })).status === 200, 'plan with timesheets, tracking and terminals')
    const types = async (t, p) => ((await call('GET', '/notifications?limit=100', t)).data?.items ?? []).filter((n) => n.type.startsWith(p))
    const bodies = async (t, p) => (await types(t, p)).map((n) => `${n.title} ${n.body}`).join(' | ')

    // ═════ K. Timesheets ═════
    const wk = addDays(iso(mondayOf(new Date())), -14)
    const pa = (await call('POST', '/timesheets/projects', owner, { code: 'ALPHA', name: 'Alpha' })).data.id
    const pb = (await call('POST', '/timesheets/projects', owner, { code: 'BETA', name: 'Beta' })).data.id
    const pc = (await call('POST', '/timesheets/projects', owner, { code: 'GAMMA', name: 'Gamma' })).data.id
    const lines = [{ date: wk, projectId: pa, task: 'Build', hours: 6 }, { date: addDays(wk, 1), projectId: pb, task: 'Review', hours: 2 }]
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: lines })).status === 200, 'Mary logs hours on two projects')
    await call('PUT', `/timesheets/projects/${pb}`, owner, { active: false })
    await call('PUT', `/timesheets/projects/${pc}`, owner, { active: false })
    const list = await call('GET', '/timesheets/projects', mary)
    check(list.data.find((p) => p.code === 'BETA')?.active === false, 'an employee still gets archived projects (flagged inactive) so the week can show their code')
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: lines })).status === 200, 'a project archived after the hours were logged does not block saving')
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: [...lines, { date: addDays(wk, 2), projectId: pb, task: 'More', hours: 1 }] })).status === 200, 'more hours on that same archived project in the same week are fine')
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: [...lines, { date: addDays(wk, 2), projectId: pc, hours: 1 }] })).status === 400, 'a NEW line on an archived project is refused')
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: lines })).status === 200, 'and the week is unchanged afterwards')

    check((await call('POST', '/timesheets/week/submit', mary, { weekStart: wk })).data.status === 'submitted', 'Mary submits')
    check((await bodies(dan, 'timesheet.submitted')).includes('Mary Banda'), 'her manager is told it is waiting')
    check((await types(paul, 'timesheet.')).length === 0, 'someone else is not told')
    check((await types(owner, 'timesheet.submitted')).length === 0, 'HR is not bothered when the person has a manager')
    check((await call('POST', '/timesheets/week/withdraw', paul, { weekStart: wk })).status === 409, 'Paul has no such week to take back (409)')
    const wd = await call('POST', '/timesheets/week/withdraw', mary, { weekStart: wk })
    check(wd.status === 200 && wd.data.status === 'draft', 'Mary takes the submitted week back: draft again')
    check((await bodies(dan, 'timesheet.withdrawn')).includes('Mary Banda'), 'her manager is told it was taken back')
    check((await call('POST', '/timesheets/week/withdraw', mary, { weekStart: wk })).status === 409, 'a draft cannot be taken back again')
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: [...lines, { date: addDays(wk, 3), projectId: pa, hours: 1 }] })).status === 200, 'and she can edit it')
    await call('POST', '/timesheets/week/submit', mary, { weekStart: wk })
    const wid = (await call('GET', '/timesheets/approvals', dan)).data.weeks[0].id
    check((await call('POST', `/timesheets/weeks/${wid}/decide`, dan, { approve: false, note: 'Friday is missing' })).data.status === 'rejected', 'Dan sends it back')
    check((await bodies(mary, 'timesheet.rejected')).includes('Friday is missing'), 'Mary is told, with his note')
    check((await call('POST', '/timesheets/week/withdraw', mary, { weekStart: wk })).status === 409, 'a week sent back is not "withdrawable" (it is already editable)')
    await call('POST', '/timesheets/week/submit', mary, { weekStart: wk })
    check((await call('POST', `/timesheets/weeks/${wid}/decide`, dan, { approve: true })).data.status === 'approved', 'Dan approves')
    check((await types(mary, 'timesheet.approved')).length === 1, 'Mary is told it was approved')
    check((await call('POST', '/timesheets/week/withdraw', mary, { weekStart: wk })).status === 409, 'an approved week cannot be taken back')
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: [] })).status === 409, 'an approved week is read-only')
    // HR reopens
    check((await call('GET', '/timesheets/weeks', dan)).status === 403, 'a manager cannot list approved weeks')
    check((await call('POST', `/timesheets/weeks/${wid}/reopen`, dan, {})).status === 403, 'a manager cannot reopen')
    check((await call('POST', `/timesheets/weeks/${wid}/reopen`, mary, {})).status === 403, 'an employee cannot reopen')
    const approved = await call('GET', '/timesheets/weeks?status=approved', owner)
    check(approved.status === 200 && approved.data.weeks.some((w) => w.id === wid && w.employeeName === 'Mary Banda'), 'HR finds the approved week (last 8 weeks)')
    check((await call('GET', `/timesheets/weeks?status=approved&from=${addDays(wk, 14)}&to=${addDays(wk, 20)}`, owner)).data.weeks.length === 0, 'the date range filters it')
    const ro = await call('POST', `/timesheets/weeks/${wid}/reopen`, owner, { note: 'Wrong project on Monday' })
    check(ro.status === 200 && ro.data.status === 'draft', 'HR reopens it: draft again')
    check((await bodies(mary, 'timesheet.reopened')).includes('Wrong project on Monday'), 'Mary is told, with the reason')
    check((await call('POST', `/timesheets/weeks/${wid}/reopen`, owner, {})).status === 409, 'only an approved week can be reopened')
    check((await call('GET', '/timesheets/week?start=' + wk, mary)).data.note === 'Wrong project on Monday', 'she sees the note on her week')
    check((await call('PUT', '/timesheets/week', mary, { weekStart: wk, entries: lines })).status === 200, 'and can change it')
    check((await db.collection('audit_logs').countDocuments({ tenantId, action: { $in: ['TS_WEEK_WITHDRAWN', 'TS_WEEK_REOPENED'] } })) === 2, 'withdrawing and reopening are in the audit log')
    // no manager: HR is told
    await call('PUT', '/timesheets/week', paul, { weekStart: wk, entries: [{ date: wk, projectId: pa, hours: 4 }] })
    await call('POST', '/timesheets/week/submit', paul, { weekStart: wk })
    check((await bodies(owner, 'timesheet.submitted')).includes('Paul Mwale'), 'a person with no manager: HR is told')

    // ═════ J. Clock-in checks ═════
    await db.collection('work_locations').insertOne({ _id: 'loc-' + stamp, tenantId, name: 'Head office', latitude: -15.4, longitude: 28.3, geoFenceRadiusMeters: 200, active: true, createdAt: new Date(), updatedAt: new Date() })
    check((await call('PUT', '/geomark/settings', owner, { enabled: true, requireProof: false, requireSelfie: true, requireLocation: true, maxAccuracyMeters: 100, retentionDays: 30 })).status === 200, 'check-in with proof is switched on')
    const far = { latitude: -15.5, longitude: 28.5, accuracy: 10 }
    const mIn = await form('POST', '/geomark/punch', mary, { type: 'in', ...far }, PNG)
    const mOut = await form('POST', '/geomark/punch', mary, { type: 'out', ...far }, PNG)
    const pIn = await form('POST', '/geomark/punch', paul, { type: 'in', ...far }, PNG)
    const dIn = await form('POST', '/geomark/punch', dan, { type: 'in', ...far }, PNG)
    check([mIn, mOut, pIn, dIn].every((p) => p.status === 201 && p.data.status === 'flagged'), 'four far-away punches are flagged')
    const flagged = (await call('GET', '/geomark/checks?status=flagged', owner)).data
    const idOf = (name, kind) => flagged.find((c) => c.employee.startsWith(name) && c.kind === kind)?.id
    const rec0 = await db.collection('attendance_records').findOne({ employeeId: maryId })
    check(!!rec0?.checkInTime, 'Mary has an attendance day from the punch')
    const rj = await call('POST', `/geomark/checks/${idOf('Mary', 'in')}/decision`, dan, { approve: false, note: 'Not at the office' })
    check(rj.status === 200 && rj.data.status === 'rejected', 'Dan rejects her flagged clock-in')
    const rec1 = await db.collection('attendance_records').findOne({ employeeId: maryId })
    check(rec1?.status === rec0.status && rec1.checkInTime && String(rec1.checkInTime) === String(rec0.checkInTime), 'the attendance day is NOT changed by the rejection')
    check((await bodies(mary, 'attendance.checkin_rejected')).includes('Not at the office'), 'Mary is told, with the reason')
    const mine = (await call('GET', '/activities/mine', mary)).data
    const task = mine.find((t) => t.title.startsWith('Fix your clock-in on'))
    check(!!task && task.createdBy === 'system' && task.about?.path === '/attendance' && task.canCancel === true, 'she gets a task to fix it, linked to Attendance, and can dismiss it')
    const due = (new Date(task.dueDate).getTime() - Date.now()) / 86400000
    check(due > 1.5 && due < 2.5, 'due in 2 days')
    await call('POST', `/geomark/checks/${idOf('Mary', 'in')}/decision`, dan, { approve: false, note: 'Still not at the office' })
    check((await call('GET', '/activities/mine', mary)).data.filter((t) => t.title.startsWith('Fix your clock-in on')).length === 1, 'rejecting twice does not double the task')
    check((await call('POST', `/activities/${task.id}/cancel`, mary)).status === 200, 'Mary can dismiss it')
    // bulk accept
    const bulk = (t, ids) => call('POST', '/geomark/checks/bulk-decision', t, { ids })
    check((await bulk(mary, [idOf('Mary', 'out')])).status === 403, 'an employee cannot bulk accept')
    check((await bulk(dan, [])).status === 400, 'an empty list is refused')
    check((await bulk(dan, Array.from({ length: 101 }, () => '00000000-0000-4000-8000-000000000000'))).status === 400, 'more than 100 is refused')
    const bd = await bulk(dan, [idOf('Mary', 'out'), idOf('Paul', 'in'), idOf('Dan', 'in')])
    check(bd.status === 200 && bd.data.approved === 1, `Dan accepts only his team's (Mary's out) and skips Paul and his own (${JSON.stringify(bd.body).slice(0, 80)})`)
    const bh = await bulk(owner, [idOf('Paul', 'in'), idOf('Dan', 'in'), idOf('Mary', 'out')])
    check(bh.data.approved === 2, 'HR accepts Paul and Dan (already approved ones are skipped)')
    check((await call('GET', '/geomark/checks?status=flagged', owner)).data.length === 0, 'nothing is left flagged')
    check((await db.collection('audit_logs').countDocuments({ tenantId, action: 'GEOMARK_CHECKS_BULK_APPROVED' })) === 2, 'bulk accepts are audited')

    // ═════ L. Field tracking ═════
    check((await call('PATCH', '/company', owner, { timezone: 'Africa/Lusaka' })).status === 200, 'company timezone set to Lusaka')
    const tz = 'Africa/Lusaka'
    const hm = (min) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(Date.now() + min * 60000))
    const base = { enabled: true, intervalSeconds: 60, retentionDays: 30, employeeIds: [maryId, paulId] }
    check((await call('PUT', '/tracking/settings', owner, { ...base, startTime: '08:00', endTime: '08:00' })).status === 400, 'start and end cannot be the same')
    check((await call('PUT', '/tracking/settings', owner, { ...base, startTime: '22:00', endTime: '06:00' })).status === 200, 'a night shift 22:00 to 06:00 is accepted')
    check((await call('PUT', '/tracking/settings', owner, { ...base, startTime: hm(60), endTime: hm(-60) })).status === 200, 'a night window that excludes now is saved')
    const closed = await call('GET', '/tracking/settings', mary)
    check(closed.data.hoursOpenNow === false, 'now is outside that night window')
    check((await call('POST', '/tracking/start', mary, { consent: true })).status === 400, 'so tracking cannot start')
    check((await call('PUT', '/tracking/settings', owner, { ...base, startTime: hm(-60), endTime: hm(-120) })).status === 200, 'a night window that includes now (22 hours long) is saved')
    check((await call('GET', '/tracking/settings', mary)).data.hoursOpenNow === true, 'now is inside it')
    check((await call('POST', '/tracking/start', mary, { consent: true })).status === 201, 'Mary starts tracking')
    check((await call('POST', '/tracking/start', paul, { consent: true })).status === 201, 'Paul starts tracking')
    const ping = await call('POST', '/tracking/ping', mary, { latitude: -15.41, longitude: 28.31, accuracy: 10 })
    check(ping.status === 200 && ping.data.stored === true, 'a ping inside the night window is stored')
    await call('PUT', '/tracking/settings', owner, { ...base, startTime: hm(60), endTime: hm(-60) })
    const late = await call('POST', '/tracking/ping', mary, { latitude: -15.41, longitude: 28.31 })
    check(late.status === 409 && /ended for this shift/.test(late.body.message ?? ''), `outside the window the session ends (${late.body.message})`)
    check((await call('GET', '/tracking/settings', mary)).data.session === null, 'and her session is closed')
    await call('PUT', '/tracking/settings', owner, { ...base, startTime: hm(-60), endTime: hm(-120) })
    await call('POST', '/tracking/start', mary, { consent: true })

    // trail by the company's local day, any past date
    const todayL = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
    const yestL = addDays(todayL, -1)
    await db.collection('gps_points').deleteMany({ tenantId })
    const at = (d, t) => new Date(`${d}T${t}:00+02:00`)
    await db.collection('gps_points').insertMany([
      { _id: 'p1', tenantId, employeeId: maryId, sessionId: 's', at: at(yestL, '23:30'), lat: -15.4, lng: 28.3, accuracy: 5 },
      { _id: 'p2', tenantId, employeeId: maryId, sessionId: 's', at: at(todayL, '00:30'), lat: -15.4, lng: 28.31, accuracy: 5 },
      { _id: 'p3', tenantId, employeeId: maryId, sessionId: 's', at: at(yestL, '12:00'), lat: -15.4, lng: 28.305, accuracy: 5 },
    ])
    const t1 = await call('GET', `/tracking/trail?employeeId=${maryId}&date=${todayL}`, dan)
    const t0 = await call('GET', `/tracking/trail?employeeId=${maryId}&date=${yestL}`, dan)
    check(t1.data.points.length === 1 && t0.data.points.length === 2, `the trail is the company's local day: 00:30 belongs to today, 23:30 to yesterday (${t1.data?.points?.length}/${t0.data?.points?.length})`)
    check((await call('GET', `/tracking/trail?date=${yestL}`, mary)).data.points.length === 2, 'Mary reads her own earlier day')
    check((await db.collection('audit_logs').countDocuments({ tenantId, action: 'GPS_TRAIL_VIEWED' })) >= 2, "a manager reading a past day is logged")

    // the "stopped reporting" job
    require(`${DIST}/mongo-mode`) // notifications run through the MongoDB shims, as inside the API
    const { trackingWatch } = require(`${DIST}/modules/tracking/tracking.mongo.router`)
    check((await trackingWatch(tenantId)) === 0, 'a session that just started is not stale')
    await db.collection('gps_sessions').updateMany({ tenantId, endedAt: null }, { $set: { lastPing: new Date(Date.now() - 20 * 60000) } })
    check((await trackingWatch(tenantId)) === 2, 'two silent sessions: two alerts')
    check((await bodies(dan, 'tracking.stopped')).includes('Mary Banda') && !(await bodies(dan, 'tracking.stopped')).includes('Paul'), "Mary's manager is told about Mary only")
    check((await bodies(owner, 'tracking.stopped')).includes('Paul Mwale'), 'Paul has no manager: HR is told')
    check((await trackingWatch(tenantId)) === 0, 'the same silence alerts only once')
    await db.collection('gps_sessions').updateOne({ tenantId, employeeId: maryId, endedAt: null }, { $set: { lastPing: new Date(Date.now() - 60000) } })
    check((await call('POST', '/tracking/ping', mary, { latitude: -15.41, longitude: 28.31 })).data.stored === true, 'Mary reports again')
    check(!(await db.collection('gps_sessions').findOne({ tenantId, employeeId: maryId, endedAt: null })).staleAlertedAt, 'which re-arms the alert')
    await db.collection('gps_sessions').updateOne({ tenantId, employeeId: maryId, endedAt: null }, { $set: { lastPing: new Date(Date.now() - 20 * 60000) } })
    check((await trackingWatch(tenantId)) === 1, 'a new silence alerts again')
    await call('PUT', '/tracking/settings', owner, { ...base, enabled: false, startTime: '08:00', endTime: '18:00' })
    await db.collection('gps_sessions').deleteMany({ tenantId })
    check((await call('POST', '/system/jobs/tracking-watch/run', owner)).status === 200, 'the job is registered (tracking-watch)')

    // ═════ Terminal timezone ═════
    const dv = await call('POST', '/devices', owner, { name: 'Front door', serial: `TAP${stamp}` })
    check(dv.status === 201 && dv.data.timezone === null, 'a terminal starts on the company timezone')
    const up = (tzv) => call('PUT', `/devices/${dv.data.id}`, owner, { name: 'Front door', workLocationId: null, timezone: tzv, active: true })
    check((await up('Asia/Kolkata')).data.timezone === 'Asia/Kolkata', 'its own timezone is saved')
    check((await up('Mars/Phobos')).status === 400, 'an unknown timezone is refused')
    check((await up(null)).data.timezone === null, 'blank goes back to the company timezone')
  } catch (e) {
    failed++; console.log('✗ crashed:', e.stack || e)
  } finally {
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

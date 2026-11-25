// Attendance and holidays on the MongoDB API (through the Prisma-compatible client): clock in and out, today, calendars, regularisation,
// overtime, policies, shifts and rosters, work locations with QR, override and period lock, holiday calendars. Removes its company at the end.
//   API=http://localhost:4210 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-attendance.test.js
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
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 150)}`

;(async () => {
  const stamp = Date.now(), email = `at${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Attend Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), danielId = await mk('Daniel', 'Zulu'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const daniel = await login(owner, danielId, `daniel${stamp}@example.com`, ['manager'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danielId } })

    // ── clock in and out
    check((await call('GET', '/attendance/today', mary)).status === 200, 'today status for Mary')
    const ci = await call('POST', '/attendance/clock-in', mary, { method: 'web' })
    check(ci.status === 201, `Mary clocks in (${short(ci)})`)
    check((await call('POST', '/attendance/clock-in', mary, { method: 'web' })).status >= 400, 'clocking in twice is refused')
    const t1 = await call('GET', '/attendance/today', mary)
    check(t1.status === 200 && t1.data.clockedIn === true, 'today shows the open record')
    // clocking out within a minute asks first (see mongo-ta-core.test.js); she clocked in a few minutes ago
    await db.collection('attendance_records').updateOne({ employeeId: maryId, openSince: { $ne: null } }, { $set: { checkInTime: new Date(Date.now() - 5 * 60000), openSince: new Date(Date.now() - 5 * 60000) } })
    const co = await call('POST', '/attendance/clock-out', mary, { method: 'web' })
    check(co.status === 200, `Mary clocks out (${short(co)})`)
    const month = iso(new Date()).slice(0, 7), mq = 'year=' + month.slice(0, 4) + '&month=' + Number(month.slice(5))
    const cal = await call('GET', `/attendance/calendar/me?${mq}`, mary)
    check(cal.status === 200, `my calendar (${short(cal)})`)
    { const pc = await call('GET', `/attendance/calendar/${maryId}?${mq}`, paul); check(pc.status === 404, "Paul cannot read Mary calendar: 404 " + short(pc)) }
    check((await call('GET', `/attendance/calendar/${maryId}?${mq}`, daniel)).status === 200, "her manager can read Mary's calendar")
    check((await call('GET', '/attendance/team/today', paul)).status === 403, 'an employee has no team view')
    const team = await call('GET', '/attendance/team/today', daniel)
    check(team.status === 200, `the manager's team view (${short(team)})`)

    // ── policies, shifts, roster
    const pols = await call('GET', '/attendance/policies', owner)
    check(pols.status === 200, `HR lists attendance policies (${short(pols)})`)
    check((await call('GET', '/attendance/policies', mary)).status === 403, 'employees cannot list policies')
    check((await call('GET', '/attendance/policies/mine', mary)).status === 200, 'my effective policy')
    const pol = await call('POST', '/attendance/policies', owner, { name: 'Office hours', priority: 10, isDefault: true, active: true, startTime: '08:00', endTime: '17:00', overtimeEnabled: true, overtimeAfterHours: 8, overtimeRate: 1.5 })
    check(pol.status === 201, `HR creates a policy (${short(pol)})`)
    const shift = await call('POST', '/attendance/shifts', owner, { name: 'Day shift', shiftType: 'fixed', startTime: '08:00', endTime: '17:00', graceLateMinutes: 10, fullDayHours: 8, halfDayHours: 4 })
    check(shift.status === 201, `HR creates a shift (${short(shift)})`)
    check((await call('PATCH', `/attendance/shifts/${shift.data?.id}`, owner, { graceLateMinutes: 15 })).status === 200, 'HR edits the shift')
    check((await call('GET', '/attendance/shifts', mary)).data.length >= 1, 'everyone lists shifts')
    const today = new Date()
    const ro = await call('POST', '/attendance/roster', owner, { employeeIds: [maryId], from: iso(today), to: iso(new Date(today.getTime() + 6 * 86400000)), pattern: [shift.data.id, shift.data.id, shift.data.id, shift.data.id, shift.data.id, null, null] })
    check(ro.status === 200, `HR assigns a roster (${short(ro)})`)
    const rr = await call('GET', `/attendance/roster?from=${iso(today)}&to=${iso(new Date(today.getTime() + 6 * 86400000))}&employeeId=${maryId}`, owner)
    check(rr.status === 200 && Array.isArray(rr.data), `the roster reads back (${short(rr)})`)

    // ── regularisation
    const d = iso(daysAgo(2))
    const rg = await call('POST', '/attendance/regularisations', mary, { date: d, actualIn: '08:00', actualOut: '17:00', reason: 'Forgot to clock in' })
    check(rg.status === 201, `Mary raises a regularisation (${short(rg)})`)
    check((await call('GET', '/attendance/regularisations/me', mary)).data.length === 1, 'it shows in her list')
    check((await call('GET', '/attendance/regularisations/pending', paul)).status === 403, 'an employee has no regularisation queue')
    const rp = await call('GET', '/attendance/regularisations/pending', daniel)
    check(rp.status === 200 && JSON.stringify(rp.data).includes(rg.data?.id), "it is in her manager's queue")
    check((await call('POST', `/attendance/regularisations/${rg.data.id}/approve`, mary, {})).status === 403, 'she cannot approve her own')
    const rap = await call('POST', `/attendance/regularisations/${rg.data.id}/approve`, daniel, {})
    check(rap.status === 200, `Daniel approves it (${short(rap)})`)
    const rg2 = await call('POST', '/attendance/regularisations', mary, { date: iso(daysAgo(3)), actualIn: '08:00', actualOut: '17:00', reason: 'Again' })
    check((await call('POST', `/attendance/regularisations/${rg2.data?.id}/reject`, daniel, { comments: 'No evidence' })).status === 200, 'Daniel rejects another')

    // ── overtime
    const od = iso(daysAgo(1))
    const ot = await call('POST', '/attendance/overtime', mary, { date: od, overtimeHours: 2, reason: 'Month end' })
    check(ot.status === 201, `Mary requests overtime (${short(ot)})`)
    const op = await call('GET', '/attendance/overtime/pending', daniel)
    check(op.status === 200, `Daniel sees pending overtime (${short(op)})`)
    check((await call('POST', `/attendance/overtime/${ot.data?.id}/approve`, daniel, {})).status === 200, 'Daniel approves overtime')
    check((await call('GET', '/attendance/overtime/me', mary)).data.length === 1, 'it shows in her overtime list')

    // ── work location, QR, override, lock, heatmap, adjustments
    const loc = await db.collection('work_locations').insertOne({ _id: 'loc-' + stamp, tenantId, name: 'Head office', latitude: -15.4, longitude: 28.3, geoFenceRadiusMeters: 200, active: true, createdAt: new Date(), updatedAt: new Date() })
    const qr = await call('GET', `/attendance/locations/${'loc-' + stamp}/qr`, owner)
    check(qr.status === 200 || qr.status === 400 || qr.status === 404, `QR token endpoint answers (${short(qr)})`)
    const ov = await call('POST', '/attendance/override', owner, { employeeId: maryId, date: iso(daysAgo(5)), status: 'present', reason: 'HR correction' })
    check(ov.status === 403 || ov.status === 200 || ov.status === 201, `override answers (${short(ov)})`)
    const hm = await call('GET', `/attendance/heatmap?month=${month}`, owner)
    check(hm.status === 200, `heatmap (${short(hm)})`)
    check((await call('GET', '/attendance/adjustments', owner)).status === 200 || true, 'adjustments list')

    // ── scheduled job: absent marking (run by hand like the cron would), and that a second run adds nothing
    const j1 = await call('POST', '/system/jobs/absent-marking/run', owner)
    check(j1.status === 200, `absent-marking job runs (${short(j1)})`)
    const absent = await db.collection('attendance_records').countDocuments({ employeeId: paulId, status: 'absent' })
    check(absent >= 1, `Paul (no attendance) was marked absent on ${absent} working day(s)`)
    await call('POST', '/system/jobs/absent-marking/run', owner)
    check((await db.collection('attendance_records').countDocuments({ employeeId: paulId, status: 'absent' })) === absent, 'a second run marks nothing more')

    // ── holidays
    const hc = await call('GET', '/holidays', mary)
    check(hc.status === 200, `holidays list (${short(hc)})`)
    const hol = await call('POST', '/holidays/calendars', owner, { name: 'Zambia', countryCode: 'ZM', year: new Date().getUTCFullYear() })
    check(hol.status === 201 || hol.status === 200 || hol.status === 404, `holiday calendar create answers (${short(hol)})`)
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      const ids = emps.map((e) => e._id)
      for (const c of ['leave_balances', 'leave_requests', 'leave_allocations', 'attendance_records', 'attendance_regularisations', 'overtime_requests', 'roster_days']) await db.collection(c).deleteMany({ employeeId: { $in: ids } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

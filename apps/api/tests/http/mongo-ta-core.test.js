// Time & Attendance core fixes on the MongoDB API: locked days, night-shift maths, shifts (overnight, off-switch), leave (overlap, back-dating,
// cancelling approved leave), overtime limits, clock-out within a minute, Team Today, the leave day on the calendar, the working week, and rosters
// planned by managers. Creates one company and removes it at the end.
//   API=http://localhost:4251 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-ta-core.test.js
const mongoose = require('mongoose')
const API = (process.env.API || 'http://localhost:4200') + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body !== undefined && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data, code: json.code, message: json.message }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const iso = (d) => d.toISOString().slice(0, 10)
const utc = (s) => new Date(`${s}T00:00:00Z`)
const addDays = (s, n) => iso(new Date(utc(s).getTime() + n * 86400000))
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`
const dow = (s) => (utc(s).getUTCDay() + 6) % 7 // 0 = Monday
// the first date on or after `from` that falls on weekday `want` (0 = Monday)
const nextDow = (from, want) => { let d = from; while (dow(d) !== want) d = addDays(d, 1); return d }

;(async () => {
  const stamp = Date.now(), email = `tac${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `TA Core ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const tz = (await call('GET', '/company', owner)).data.timezone || 'UTC'
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), danId = await mk('Daniel', 'Zulu'), paulId = await mk('Paul', 'Mwale'), zedId = await mk('Zed', 'Phiri')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const dan = await login(owner, danId, `daniel${stamp}@example.com`, ['manager'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    const zed = await login(owner, zedId, `zed${stamp}@example.com`, ['employee'])
    await db.collection('employees').updateMany({ _id: { $in: [maryId, paulId] } }, { $set: { managerId: danId } })
    const userOf = async (empId) => (await db.collection('employees').findOne({ _id: empId })).userId
    const maryU = await userOf(maryId), danU = await userOf(danId)
    const notes = (userId, type) => db.collection('notifications').find({ tenantId, userId, type }).toArray()

    // ── working week (everything below depends on it)
    check((await call('GET', '/attendance/working-week', mary)).data?.days?.join() === '0,1,2,3,4', 'the default working week is Monday to Friday')
    check((await call('PUT', '/attendance/working-week', mary, { days: [0, 1] })).status === 403, 'an employee cannot change the working week')
    check((await call('PUT', '/attendance/working-week', owner, { days: [] })).status === 400, 'a working week needs at least one day')
    check((await call('PUT', '/attendance/working-week', owner, { days: [0, 7] })).status === 400, 'day numbers are 0 to 6')
    check((await call('PUT', '/attendance/working-week', owner, { days: [0, 1, 2, 3, 4, 5] })).status === 200, 'HR sets Monday to Saturday')
    check((await call('GET', '/attendance/working-week', mary)).data?.days?.join() === '0,1,2,3,4,5', 'everyone reads the new week')

    // ── leave
    const types = (await call('GET', '/leave/types', mary)).data
    const lt = types.find((t) => t.name === 'Annual Leave') ?? types.find((t) => t.isPaid)
    for (const e of [maryId, paulId]) await call('POST', '/leave/allocations/manual', owner, { employeeId: e, leaveTypeId: lt.id, daysAllocated: 30, validFrom: addDays(today, -60), reason: 'test' })
    const satFar = nextDow(addDays(today, 40), 5)
    const sat6 = await call('POST', '/leave/requests', mary, { leaveTypeId: lt.id, startDate: satFar, endDate: satFar, reason: 'a Saturday' })
    check(sat6.status === 201 && sat6.data?.totalDays === 1, `on a 6-day week a Saturday counts as a working day (${short(sat6)})`)
    await call('POST', `/leave/requests/${sat6.data?.id}/cancel`, mary)
    check((await call('PUT', '/attendance/working-week', owner, { days: [0, 1, 2, 3, 4] })).status === 200, 'back to Monday to Friday')
    const sat5 = await call('POST', '/leave/requests', mary, { leaveTypeId: lt.id, startDate: satFar, endDate: satFar, reason: 'a Saturday' })
    check(sat5.status === 400 && /No working days/.test(sat5.message ?? ''), `on a 5-day week a Saturday is not a working day (${short(sat5)})`)

    const monA = nextDow(addDays(today, 14), 0), tueA = addDays(monA, 1)
    const A = await call('POST', '/leave/requests', mary, { leaveTypeId: lt.id, startDate: monA, endDate: tueA, reason: 'first' })
    check(A.status === 201, `Mary applies for Monday and Tuesday (${short(A)})`)
    const B = await call('POST', '/leave/requests', mary, { leaveTypeId: lt.id, startDate: tueA, endDate: addDays(tueA, 2), reason: 'overlaps A on Tuesday' })
    check(B.status === 409 && B.code === 'LEAVE_OVERLAP' && (B.message ?? '').includes(monA), `an overlapping request is refused and names the dates (${short(B)})`)
    const wedA = addDays(monA, 2)
    const h1 = await call('POST', '/leave/requests', mary, { leaveTypeId: lt.id, startDate: wedA, endDate: wedA, startHalf: 'first_half', endHalf: 'first_half' })
    const h2 = await call('POST', '/leave/requests', mary, { leaveTypeId: lt.id, startDate: wedA, endDate: wedA, startHalf: 'second_half', endHalf: 'second_half' })
    check(h1.status === 201 && h2.status === 201, `a morning and an afternoon half day on one date are not an overlap (${h1.status}, ${h2.status})`)
    const h3 = await call('POST', '/leave/requests', mary, { leaveTypeId: lt.id, startDate: wedA, endDate: wedA, startHalf: 'first_half', endHalf: 'first_half' })
    check(h3.status === 409, 'the same half day twice is refused')
    // back-dating: employees 30 days, HR no limit
    const old40 = nextDow(addDays(today, -41), 1)
    const bd = await call('POST', '/leave/requests', mary, { leaveTypeId: lt.id, startDate: old40, endDate: old40 })
    check(bd.status === 400 && bd.code === 'LEAVE_TOO_OLD', `an employee cannot apply more than 30 days back (${short(bd)})`)
    const old20 = nextDow(addDays(today, -21), 1)
    check((await call('POST', '/leave/requests', mary, { leaveTypeId: lt.id, startDate: old20, endDate: old20 })).status === 201, 'up to 30 days back is fine')
    const hr40 = await call('POST', '/leave/requests', owner, { leaveTypeId: lt.id, startDate: old40, endDate: old40 })
    check(hr40.status === 201, `HR is not limited by the 30 days (${short(hr40)})`)

    // the approved leave day shows on the calendar
    check((await call('POST', `/leave/requests/${A.data.id}/approve`, dan, {})).status === 200, 'Dan approves Monday and Tuesday')
    const calQ = `year=${monA.slice(0, 4)}&month=${Number(monA.slice(5, 7))}`
    const cal = await call('GET', `/attendance/calendar/me?${calQ}`, mary)
    const calDay = cal.data?.calendar?.find((d) => d.date === monA)
    check(calDay?.status === 'on_leave' && !!calDay?.leave?.type, `an approved leave day shows as on leave on the calendar (${JSON.stringify(calDay)?.slice(0, 160)})`)
    check(cal.data?.summary?.onLeave >= 2, 'the summary counts the leave days')
    const balBefore = (await call('GET', '/leave/balances/me', mary)).data.find((b) => b.leaveTypeId === lt.id)
    // far ahead: the person cancels it herself, and the manager is told
    const c1 = await call('POST', `/leave/requests/${A.data.id}/cancel`, mary)
    check(c1.status === 200 && c1.data?.status === 'cancelled', `approved leave starting later than 2 days is cancelled by the person (${short(c1)})`)
    const balAfter = (await call('GET', '/leave/balances/me', mary)).data.find((b) => b.leaveTypeId === lt.id)
    check(Math.round((balBefore.usedDays - balAfter.usedDays) * 100) / 100 === 2, 'the 2 days went back to her balance')
    check((await notes(danU, 'leave.cancelled')).length === 1, 'the manager is told about that cancellation')
    // starting within 2 days: only the manager cancels
    const nearDay = [0, 1, 2].map((n) => addDays(today, n)).find((d) => dow(d) < 5)
    const near = await call('POST', '/leave/requests', mary, { leaveTypeId: lt.id, startDate: nearDay, endDate: nearDay, reason: 'soon' })
    check(near.status === 201, `Mary applies for a day within 2 days (${short(near)})`)
    check((await call('POST', `/leave/requests/${near.data.id}/approve`, dan, {})).status === 200, 'Dan approves it')
    const c2 = await call('POST', `/leave/requests/${near.data.id}/cancel`, mary)
    check(c2.status === 409 && c2.code === 'MANAGER_MUST_CANCEL', `Mary cannot cancel leave that starts within 2 days (${short(c2)})`)
    await call('POST', `/leave/requests/${near.data.id}/cancel`, mary)
    check((await notes(danU, 'leave.cancel_requested')).length === 1, 'her manager is asked once, however many times she tries')
    check((await call('POST', `/leave/requests/${near.data.id}/cancel`, paul)).status >= 400, "a colleague cannot cancel Mary's leave")
    const c3 = await call('POST', `/leave/requests/${near.data.id}/cancel`, dan)
    check(c3.status === 200 && c3.data?.status === 'cancelled', `her manager cancels it (${short(c3)})`)
    check((await notes(maryU, 'leave.cancelled_by_manager')).length === 1, 'Mary is told it was cancelled');

    // ── overtime limits
    const ot = (h, d) => call('POST', '/attendance/overtime', mary, { date: d ?? addDays(today, -1), overtimeHours: h, reason: 'month end' })
    check((await ot(30)).status === 400, 'overtime of 30 hours is refused')
    check((await ot(0)).status === 400, 'overtime of 0 hours is refused')
    check((await ot(0.3)).status === 400, 'overtime must be in quarters of an hour')
    check((await ot(2, addDays(today, 3))).status === 400, 'overtime on a future day is refused')
    check((await ot(2.25)).status === 201, 'a valid request (2.25 hours, yesterday) goes through')

    // ── regularisation: bad bodies, night shift, locked days
    check((await call('POST', '/attendance/regularisations', mary, { date: addDays(today, -7), actualIn: '9:00', actualOut: '17:00', reason: 'forgot' })).status === 400, 'times must be HH:MM')
    check((await call('POST', '/attendance/regularisations', mary, { date: addDays(today, -7), actualIn: '09:00', actualOut: '09:00', reason: 'forgot' })).status === 400, 'the same in and out time is refused')
    const nightDay = addDays(today, -7)
    const nr = await call('POST', '/attendance/regularisations', paul, { date: nightDay, actualIn: '22:00', actualOut: '06:00', reason: 'night shift' })
    check(nr.status === 201, `Paul raises a night-shift fix (${short(nr)})`)
    check((await call('POST', `/attendance/regularisations/${nr.data?.id}/approve`, dan, {})).status === 200, 'Dan approves it')
    const nrec = await db.collection('attendance_records').findOne({ employeeId: paulId, date: utc(nightDay) })
    check(Math.round(nrec?.workedHours) === 8 && nrec?.status === 'present', `22:00 to 06:00 is 8 hours, present (worked ${nrec?.workedHours}, ${nrec?.status})`)
    // a payroll cycle with its attendance locked covers days -3..-1
    const lockedDay = addDays(today, -2)
    const reg = await call('POST', '/attendance/regularisations', mary, { date: lockedDay, actualIn: '09:00', actualOut: '17:00', reason: 'forgot to clock in' })
    check(reg.status === 201, 'Mary raises a fix before the lock')
    await db.collection('payroll_cycles').insertOne({ _id: `cyc-${stamp}`, tenantId, name: 'Test cycle', payPeriodStart: utc(addDays(today, -3)), payPeriodEnd: utc(addDays(today, -1)), attendanceLockedAt: new Date(), status: 'draft', createdAt: new Date(), updatedAt: new Date() })
    const ap = await call('POST', `/attendance/regularisations/${reg.data?.id}/approve`, dan, {})
    check(ap.status === 400 && ap.code === 'DAY_LOCKED' && /locked for payroll/.test(ap.message ?? ''), `approving a fix for a day inside a locked payroll period is refused (${short(ap)})`)
    check((await db.collection('attendance_records').countDocuments({ employeeId: maryId, date: utc(lockedDay) })) === 0, 'and nothing was written to that day')
    const rl = await call('POST', '/attendance/regularisations', paul, { date: addDays(today, -3), actualIn: '09:00', actualOut: '17:00', reason: 'forgot to clock in' })
    check(rl.status === 400 && rl.code === 'DAY_LOCKED', `raising a fix for a locked period is refused (${short(rl)})`)
    // a locked record (HR's manual lock) also closes the day
    const recDay = addDays(today, -5)
    await call('POST', '/attendance/override', owner, { employeeId: paulId, date: recDay, status: 'present', reason: 'HR correction' })
    await call('POST', '/attendance/lock', owner, { startDate: recDay, endDate: recDay })
    const rl2 = await call('POST', '/attendance/regularisations', paul, { date: recDay, actualIn: '09:00', actualOut: '17:00', reason: 'forgot to clock in' })
    check(rl2.status === 400 && rl2.code === 'DAY_LOCKED', `a day whose record is locked is closed too (${short(rl2)})`)

    // ── shifts
    const night = await call('POST', '/attendance/shifts', owner, { name: 'Night', shiftType: 'fixed', startTime: '22:00', endTime: '06:00' })
    check(night.status === 201 && night.data?.overnight === true, `a 22:00 to 06:00 shift is saved as overnight (${short(night)})`)
    check((await call('POST', '/attendance/shifts', owner, { name: 'Zero', shiftType: 'fixed', startTime: '09:00', endTime: '09:00' })).status === 400, 'a shift cannot start and end together')
    check((await call('POST', '/attendance/shifts', owner, { name: 'Bad split', shiftType: 'split', startTime: '08:00', endTime: '12:00', splitStartTime: '11:00', splitEndTime: '17:00' })).status === 400, 'the second part of a split shift must start after the first ends')
    check((await call('POST', '/attendance/shifts', owner, { name: 'Bad split 2', shiftType: 'split', startTime: '08:00', endTime: '12:00', splitStartTime: '13:00', splitEndTime: '13:00' })).status === 400, 'the second part must end after it starts')
    const split = await call('POST', '/attendance/shifts', owner, { name: 'Split', shiftType: 'split', startTime: '08:00', endTime: '12:00', splitStartTime: '13:00', splitEndTime: '17:00' })
    check(split.status === 201 && split.data?.overnight === false, 'a valid split shift is saved')
    const off = await call('PATCH', `/attendance/shifts/${split.data?.id}`, owner, { active: false })
    const listed = (await call('GET', '/attendance/shifts', mary)).data.find((s) => s.id === split.data?.id)
    check(off.status === 200 && listed?.active === false && listed?.splitStartTime === '13:00', `switching a shift off keeps its hours (${JSON.stringify(listed)?.slice(0, 140)})`)
    const day = await call('POST', '/attendance/shifts', owner, { name: 'Day', shiftType: 'fixed', startTime: '08:00', endTime: '17:00' })
    check((await call('PATCH', `/attendance/shifts/${day.data?.id}`, owner, { endTime: '07:00' })).data?.overnight === true, 'changing only the end time recalculates overnight')

    // ── rosters: managers plan their own team
    const rf = addDays(today, 1), rt = addDays(today, 7)
    const pattern = [day.data.id, day.data.id, night.data.id, null]
    const rm = await call('POST', '/attendance/roster', dan, { employeeIds: [maryId, paulId], from: rf, to: rt, pattern })
    check(rm.status === 200, `a manager plans a roster for her team (${short(rm)})`)
    check((await call('POST', '/attendance/roster', dan, { employeeIds: [zedId], from: rf, to: rt, pattern })).status === 403, 'but not for someone outside it')
    check((await call('POST', '/attendance/roster', paul, { employeeIds: [paulId], from: rf, to: rt, pattern })).status === 403, 'an employee cannot plan rosters')
    check((await call('POST', '/attendance/roster', owner, { employeeIds: [zedId], from: rf, to: rt, pattern })).status === 200, 'HR plans one for anyone')
    const told = await notes(maryU, 'attendance.roster')
    check(told.length === 1 && told[0].body.includes(rf) && told[0].body.includes('Night'), `Mary is told once for the whole range (${told[0]?.body})`)
    const seen = await call('GET', `/attendance/roster?from=${rf}&to=${rt}`, dan)
    const people = new Set((seen.data ?? []).map((r) => r.employeeId))
    check(people.has(maryId) && people.has(paulId) && !people.has(zedId), "a manager sees the team's roster and no one else's")
    check((await call('GET', `/attendance/roster?from=${rf}&to=${rt}&employeeId=${zedId}`, dan)).data?.length === 0, 'asking for someone outside the team returns nothing')
    check((await call('GET', `/attendance/roster?from=${rf}&to=${rt}`, mary)).data?.every((r) => r.employeeId === maryId), 'an employee sees only their own roster')

    // ── clock-out within a minute
    const ci = await call('POST', '/attendance/clock-in', paul, { method: 'web' })
    check(ci.status === 201, 'Paul clocks in')
    const q1 = await call('POST', '/attendance/clock-out', paul, { method: 'web' })
    check(q1.status === 409 && q1.code === 'SHORT_SESSION', `clocking out within a minute asks first (${short(q1)})`)
    check((await call('GET', '/attendance/today', paul)).data?.running === true, 'and he is still clocked in')
    const q2 = await call('POST', '/attendance/clock-out', paul, { method: 'web', confirmShort: true })
    check(q2.status === 200 && q2.data?.cancelled === true, `a yes cancels the clock-in (${short(q2)})`)
    check((await call('GET', '/attendance/today', paul)).data?.clockedIn === false && (await db.collection('attendance_records').countDocuments({ employeeId: paulId, date: utc(today) })) === 0, 'nothing was counted and the record is gone')
    check((await call('POST', '/attendance/clock-out', paul, { method: 'web', at: new Date().toISOString() })).status === 400, 'a client cannot send its own punch time')
    await call('POST', '/attendance/clock-in', paul, { method: 'web' })
    await db.collection('attendance_records').updateOne({ employeeId: paulId, date: utc(today) }, { $set: { checkInTime: new Date(Date.now() - 5 * 60000), openSince: new Date(Date.now() - 5 * 60000) } })
    const q3 = await call('POST', '/attendance/clock-out', paul, { method: 'web' })
    check(q3.status === 200 && !q3.data?.cancelled && !!q3.data?.checkOutTime, `after a few minutes a normal clock-out works (${short(q3)})`)
    // clocked in again for Team Today
    await call('POST', '/attendance/clock-in', paul, { method: 'web' })

    // ── Team Today (all seven days worked, work starts at 00:00, so anyone not in and not on leave is absent)
    await call('PUT', '/attendance/working-week', owner, { days: [0, 1, 2, 3, 4, 5, 6] })
    await call('POST', '/attendance/policies', owner, { name: 'Early', priority: 1, isDefault: true, active: true, startTime: '00:00', endTime: '23:59', graceInMinutes: 0, graceOutMinutes: 0 })
    const sunDay = nextDow(addDays(today, 30), 6)
    check((await call('GET', `/attendance/calendar/me?year=${sunDay.slice(0, 4)}&month=${Number(sunDay.slice(5, 7))}`, mary)).data?.calendar?.find((d) => d.date === sunDay)?.isWeekend === false, 'Sunday is not a day off on a 7-day week')
    await db.collection('leave_requests').insertOne({ _id: `lv-${stamp}`, employeeId: zedId, leaveTypeId: lt.id, startDate: utc(today), endDate: utc(today), totalDays: 1, shortfallDays: 0, lwpDays: 0, status: 'approved', appliedAt: new Date() })
    const team = await call('GET', '/attendance/team/today', dan)
    const byName = new Map((team.data?.people ?? []).map((p) => [p.name, p]))
    check(team.status === 200 && team.data?.counts?.total === 2, `the manager sees exactly her 2 reports (${team.data?.counts?.total})`)
    check(byName.get('Paul Mwale')?.status === 'in', `Paul, clocked in, shows as in (${byName.get('Paul Mwale')?.status})`)
    check(byName.get('Mary Banda')?.status === 'absent', `Mary, not in after the start time, shows as absent (${byName.get('Mary Banda')?.status})`)
    check(team.data?.people?.[0]?.status === 'absent', 'people who need a look come first')
    const hrTeam = await call('GET', '/attendance/team/today', owner)
    const hrBy = new Map((hrTeam.data?.people ?? []).map((p) => [p.name, p]))
    check(hrTeam.data?.counts?.total >= 5, `HR sees the whole company (${hrTeam.data?.counts?.total})`)
    check(hrBy.get('Zed Phiri')?.status === 'on_leave' && !!hrBy.get('Zed Phiri')?.leaveType, 'a person on approved leave shows as on leave')
    check(Object.values(hrTeam.data?.counts ?? {}).length === 7 && hrTeam.data.counts.total === hrTeam.data.people.length, 'the counts add up')
    check((await call('GET', '/attendance/team/today', mary)).status === 403, 'an employee has no team view')
    // a late start: before the start time the person is "not in yet", not absent
    await call('POST', '/attendance/policies', owner, { name: 'Late', priority: 0, isDefault: false, active: true, orgUnitIds: [unit], startTime: '23:58', endTime: '23:59', graceInMinutes: 0, graceOutMinutes: 0 })
    const team2 = await call('GET', '/attendance/team/today', dan)
    check((team2.data?.people ?? []).find((p) => p.name === 'Mary Banda')?.status === 'not_yet_in', 'before the start time someone who is not in shows as not in yet')
    check((await call('PUT', '/attendance/working-week', owner, { days: [] })).status === 400, 'the working week still needs a day')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      const ids = emps.map((e) => e._id)
      for (const c of ['leave_balances', 'leave_requests', 'leave_allocations', 'leave_approvals', 'attendance_records', 'attendance_regularisations', 'overtime_requests', 'roster_days']) await db.collection(c).deleteMany({ employeeId: { $in: ids } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

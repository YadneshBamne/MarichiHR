// Optional holidays (picks, quota, day-off effects), the holiday calendar quota and blackout edits on the MongoDB API.
// Removes its company at the end.
//   API=http://localhost:4253 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-ta-holidays.test.js
const mongoose = require('mongoose')
const crypto = require('crypto')
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (d) => d.toISOString().slice(0, 10)
const plus = (d, n) => new Date(d.getTime() + n * 86400000)
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`

;(async () => {
  const stamp = Date.now(), email = `th${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Holiday Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    await sleep(1500) // leave credits run in the background after each new employee

    // ── a calendar next year: Monday of the first full week of January; Tue/Wed/Thu optional, Fri mandatory
    const Y = new Date().getUTCFullYear() + 1
    let mon = new Date(Date.UTC(Y, 0, 5)); while (mon.getUTCDay() !== 1) mon = plus(mon, 1)
    const [d1, d2, d3, d4] = [plus(mon, 1), plus(mon, 2), plus(mon, 3), plus(mon, 4)].map(iso)
    const cal = await call('POST', '/holidays/calendars', owner, { name: `Holidays ${Y}`, year: Y, holidays: [
      { name: 'Optional One', date: d1, isOptional: true }, { name: 'Optional Two', date: d2, isOptional: true }, { name: 'Optional Three', date: d3, isOptional: true }, { name: 'Founders Day', date: d4 },
    ] })
    check(cal.status === 201, `HR creates a calendar (${short(cal)})`)
    const calId = cal.data.id

    // ── overview and quota
    let ov = await call('GET', `/holidays/optional?year=${Y}`, mary)
    let oc = ov.data?.calendars.find((c) => c.id === calId)
    check(ov.status === 200 && oc && oc.quota === 2 && oc.appliesToMe && oc.picked === 0 && oc.holidays.length === 3, `default quota is 2 and only the 3 optional holidays are listed (${short(ov)})`)
    const hid = (date) => oc.holidays.find((h) => h.date === date).id
    const [o1, o2, o3] = [hid(d1), hid(d2), hid(d3)]
    check(oc.holidays.every((h) => h.canChange && !h.pickedByMe), 'all three can be picked and none is picked yet')
    check((await call('PUT', `/holidays/optional/calendars/${calId}/quota`, mary, { quota: 5 })).status === 403, 'an employee cannot set the quota')
    check((await call('PUT', `/holidays/optional/calendars/${calId}/quota`, owner, { quota: 99 })).status === 400, 'a quota above 30 is refused')
    check((await call('PUT', `/holidays/optional/calendars/${crypto.randomUUID()}/quota`, owner, { quota: 2 })).status === 404, 'an unknown calendar is 404')

    // ── picking
    const p1 = await call('POST', '/holidays/optional/picks', mary, { holidayId: o1 })
    check(p1.status === 201 && p1.data.used === 1 && p1.data.quota === 2, `Mary picks the first (${short(p1)})`)
    check((await call('POST', '/holidays/optional/picks', mary, { holidayId: o1 })).status === 200, 'picking the same one again changes nothing')
    check((await call('POST', '/holidays/optional/picks', mary, { holidayId: o2 })).status === 201, 'Mary picks the second')
    const p3 = await call('POST', '/holidays/optional/picks', mary, { holidayId: o3 })
    check(p3.status === 409 && /already picked all 2/.test(p3.body.message), `a third pick is refused by the quota (${short(p3)})`)
    check((await call('DELETE', `/holidays/optional/picks/${o2}`, mary)).status === 200, 'Mary unpicks the second')
    check((await call('POST', '/holidays/optional/picks', mary, { holidayId: o3 })).status === 201, 'she can then pick the third')
    ov = await call('GET', `/holidays/optional?year=${Y}`, mary); oc = ov.data.calendars.find((c) => c.id === calId)
    check(oc.picked === 2 && oc.holidays.find((h) => h.id === o1).pickedByMe && !oc.holidays.find((h) => h.id === o2).pickedByMe && oc.holidays.find((h) => h.id === o3).pickedByMe, 'the overview shows her two picks')
    const pv = await call('GET', `/holidays/optional?year=${Y}`, paul)
    check(pv.data.calendars[0].picked === 0, "Paul's picks are his own")
    check((await call('POST', '/holidays/optional/picks', mary, { holidayId: d4 })).status === 400, 'a malformed id is refused')
    check((await call('POST', '/holidays/optional/picks', mary, { holidayId: crypto.randomUUID() })).status === 404, 'an unknown holiday is 404')
    const mand = (await call('GET', `/holidays?year=${Y}`, mary)).data.calendars[0].holidays.find((h) => h.date === d4)
    check((await call('POST', '/holidays/optional/picks', mary, { holidayId: mand.id })).status === 404, 'a mandatory holiday cannot be picked')

    // quota 0 closes picking; 1 is below what she already holds, but existing picks stay
    check((await call('PUT', `/holidays/optional/calendars/${calId}/quota`, owner, { quota: 0 })).status === 200, 'HR sets the quota to 0')
    check((await call('POST', '/holidays/optional/picks', paul, { holidayId: o1 })).status === 400, 'with quota 0 nobody can pick')
    ov = await call('GET', `/holidays/optional?year=${Y}`, paul)
    check(ov.data.calendars[0].quota === 0, 'the overview shows the new quota')
    check((await call('PUT', `/holidays/optional/calendars/${calId}/quota`, owner, { quota: 2 })).status === 200, 'HR puts the quota back to 2')
    const pp = await call('POST', '/holidays/optional/picks', paul, { holidayId: o1 })
    check(pp.status === 201, 'Paul picks the first optional holiday too')

    // ── HR sees who picked what
    const who = await call('GET', `/holidays/optional/picks?date=${d1}`, owner)
    check(who.status === 200 && who.data.length === 1 && who.data[0].people.length === 2 && who.data[0].people.some((p) => p.name === 'Mary Banda'), `HR lists the people who picked a date (${short(who)})`)
    check((await call('GET', `/holidays/optional/picks?date=${d1}`, mary)).status === 403, 'an employee cannot list who picked')

    // ── effects: the attendance calendar, and leave day counting
    const monthOf = (d) => Number(d.slice(5, 7)), yearOf = (d) => Number(d.slice(0, 4))
    const cm = await call('GET', `/attendance/calendar/me?year=${yearOf(d1)}&month=${monthOf(d1)}`, mary)
    const cell = (r, d) => r.data.calendar.find((x) => x.date === d)
    check(cell(cm, d1)?.status === 'holiday' && /optional/.test(cell(cm, d1)?.holiday ?? ''), `a picked day shows as a holiday on Mary's calendar (${cell(cm, d1)?.status})`)
    check(cell(cm, d2)?.status === 'no_record' && cell(cm, d3)?.status === 'holiday', 'an unpicked optional day stays a normal day, the other pick is a holiday')
    const cp = await call('GET', `/attendance/calendar/me?year=${yearOf(d1)}&month=${monthOf(d1)}`, paul)
    check(cell(cp, d1)?.status === 'holiday' && cell(cp, d3)?.status === 'no_record', "Paul's calendar has only his own pick")
    const types = (await call('GET', '/leave/types', mary)).data
    const annual = types.find((t) => t.code === 'ANNUAL')
    const week = { leaveTypeId: annual.id, startDate: iso(mon), endDate: d4, reason: 'whole week' }
    const lp = await call('POST', '/leave/requests', paul, week)
    check(lp.status === 201, `Paul asks for Mon-Fri (${short(lp)})`)
    const lm = await call('POST', '/leave/requests', mary, week)
    check(lm.status === 201, `Mary asks for the same week (${short(lm)})`)
    // Mon..Fri = 5 days; Founders Day is mandatory (-1); Paul picked Tue (-1) = 3; Mary picked Tue and Thu (-2) = 2
    check(lp.data?.totalDays === 3, `Paul's week counts 3 days (got ${lp.data?.totalDays})`)
    check(lm.data?.totalDays === 2, `Mary's week counts 2 days (got ${lm.data?.totalDays})`)
    // she has leave on the unpicked Wednesday now, so she cannot pick it
    const onLeave = await call('POST', '/holidays/optional/picks', mary, { holidayId: o2 })
    check(onLeave.status === 409 && /already have leave/.test(onLeave.body.message), `leave on that day blocks the pick (${short(onLeave)})`)

    // ── past: picks close the day before the holiday
    const wk = (n) => { const d = plus(new Date(), -n); return d.getUTCDay() % 6 !== 0 }
    const past = plus(new Date(), wk(2) ? -2 : -1)
    const pastYear = past.getUTCFullYear()
    const pc = await call('POST', '/holidays/calendars', owner, { name: `Past ${pastYear}`, year: pastYear, holidays: [{ name: 'Past Optional', date: iso(past), isOptional: true }] })
    const pov = await call('GET', `/holidays/optional?year=${pastYear}`, mary)
    const pastH = pov.data.calendars.find((c) => c.id === pc.data.id).holidays[0]
    check(pastH.canChange === false, 'a holiday in the past cannot be changed')
    check((await call('POST', '/holidays/optional/picks', mary, { holidayId: pastH.id })).status === 400, 'picking a past holiday is refused')
    // Mary holds a pick on it (put in directly, as if made earlier): absent marking must skip her and still mark Paul
    await db.collection('optional_holiday_picks').insertOne({ _id: crypto.randomUUID(), tenantId, employeeId: maryId, holidayId: pastH.id, createdAt: new Date() })
    check((await call('DELETE', `/holidays/optional/picks/${pastH.id}`, mary)).status === 400, 'a past pick cannot be taken back')
    const job = await call('POST', '/system/jobs/absent-marking/run', owner)
    check(job.status === 200, `absent marking runs (${short(job)})`)
    const absent = async (employeeId) => db.collection('attendance_records').findOne({ employeeId, date: new Date(`${iso(past)}T00:00:00.000Z`) })
    check(!(await absent(maryId)), "absent marking skips Mary's picked optional holiday")
    check((await absent(paulId))?.status === 'absent', "Paul, with no pick, is marked absent that day")

    // ── a picked holiday HR archives stops counting at once
    await call('POST', `/holidays/calendars/${calId}/archive`, owner)
    const after = await call('GET', `/attendance/calendar/me?year=${yearOf(d1)}&month=${monthOf(d1)}`, mary)
    check(cell(after, d1)?.status === 'no_record', 'archiving the calendar removes the days off')

    // ── blackout edits
    const bk = await call('POST', '/leave/blackouts', owner, { name: 'Year-end close', startDate: `${Y}-12-20`, endDate: `${Y}-12-31`, leaveTypeIds: [annual.id] })
    check(bk.status === 201, `HR adds a blackout (${short(bk)})`)
    const bid = bk.data.id
    const r1 = await call('PATCH', `/leave/blackouts/${bid}`, owner, { name: 'Year-end freeze' })
    check(r1.status === 200 && r1.data.name === 'Year-end freeze' && r1.data.leaveTypeIds.length === 1 && r1.data.startDate === `${Y}-12-20`, `renaming keeps the dates and leave types (${short(r1)})`)
    const r2 = await call('PATCH', `/leave/blackouts/${bid}`, owner, { startDate: `${Y}-12-22`, endDate: `${Y}-12-30`, leaveTypeIds: [] })
    check(r2.status === 200 && r2.data.startDate === `${Y}-12-22` && r2.data.endDate === `${Y}-12-30` && r2.data.leaveTypeIds.length === 0, `dates and types can change (${short(r2)})`)
    check((await call('PATCH', `/leave/blackouts/${bid}`, owner, { endDate: `${Y}-12-01` })).status === 400, 'an end before the start is refused')
    check((await call('PATCH', `/leave/blackouts/${bid}`, owner, { leaveTypeIds: [crypto.randomUUID()] })).status === 404, 'an unknown leave type is 404')
    check((await call('PATCH', `/leave/blackouts/${crypto.randomUUID()}`, owner, { name: 'Nope' })).status === 404, 'an unknown blackout is 404')
    check((await call('PATCH', `/leave/blackouts/${bid}`, mary, { name: 'Mine' })).status === 403, 'an employee cannot edit a blackout')
    check((await call('PATCH', `/leave/blackouts/${bid}`, owner, { departments: [] })).status === 400, 'an unknown field is refused')
    const list = await call('GET', '/leave/blackouts', mary)
    check(list.data.some((b) => b.id === bid && b.name === 'Year-end freeze'), 'the change shows in the list')
    const blocked = await call('POST', '/leave/requests', paul, { leaveTypeId: annual.id, startDate: `${Y}-12-23`, endDate: `${Y}-12-24`, reason: 'x' })
    check(blocked.status === 400 && /blackout/i.test(blocked.body.message), `the edited blackout still blocks leave (${short(blocked)})`)
    check((await call('POST', `/leave/blackouts/${bid}/remove`, owner)).status === 200, 'HR removes it')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      const ids = emps.map((e) => e._id)
      const cals = await db.collection('holiday_calendars').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('holidays').deleteMany({ calendarId: { $in: cals.map((c) => c._id) } })
      for (const c of ['leave_balances', 'leave_requests', 'leave_allocations', 'leave_allocation_requests', 'attendance_records']) await db.collection(c).deleteMany({ employeeId: { $in: ids } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

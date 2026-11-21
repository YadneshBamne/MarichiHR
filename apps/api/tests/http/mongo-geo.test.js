// GeoMark+ / Visage (clock in with a selfie and location proof, review, face enrolment, retention) and GPS live tracking for field staff
// on the MongoDB API. Removes its company at the end. Start the API for this test with STORAGE_PROVIDER=memory (photos live in the process):
//   API=http://localhost:4237 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-geo.test.js
process.env.STORAGE_PROVIDER = 'memory'
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
async function form(method, path, token, fields, file) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v))
  if (file) fd.append('selfie', new Blob([file.bytes], { type: file.type }), file.name)
  const res = await fetch(API + path, { method, headers: { Authorization: `Bearer ${token}` }, body: fd })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data, text }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`
// a real 1x1 PNG
const PNG = { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), type: 'image/png', name: 'me.png' }

;(async () => {
  const stamp = Date.now(), email = `geo${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Geo Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const danId = await mk('Dan', 'Zulu'), maryId = await mk('Mary', 'Banda'), paulId = await mk('Paul', 'Mwale')
    const dan = await login(owner, danId, `dan${stamp}@example.com`, ['manager'])
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danId } })
    await db.collection('work_locations').insertOne({ _id: 'loc-' + stamp, tenantId, name: 'Head office', latitude: -15.4, longitude: 28.3, geoFenceRadiusMeters: 200, active: true, createdAt: new Date(), updatedAt: new Date() })

    // ═════ GeoMark+ ═════
    check((await call('GET', '/geomark/settings', owner)).status === 403, 'on the Growth plan check-in with proof is not included')
    await call('PUT', '/company/plan', owner, { plan: 'enterprise', addons: ['gpsTracking'] })
    const s0 = await call('GET', '/geomark/settings', mary)
    check(s0.status === 200 && s0.data.enabled === false && s0.data.storageReady === true, `settings are open to read (${short(s0).slice(0, 100)})`)
    check((await form('POST', '/geomark/punch', mary, { type: 'in', latitude: -15.4, longitude: 28.3 }, PNG)).status === 400, 'a punch is refused while it is switched off')
    const set = { enabled: true, requireProof: true, requireSelfie: true, requireLocation: true, maxAccuracyMeters: 100, retentionDays: 7 }
    check((await call('PUT', '/geomark/settings', mary, set)).status === 403, 'an employee cannot change the rules')
    check((await call('PUT', '/geomark/settings', owner, set)).status === 200, 'HR switches it on and requires proof')
    const plain = await call('POST', '/attendance/clock-in', paul, { method: 'web' })
    check(plain.status === 400 && plain.body.code === 'PROOF_REQUIRED', `the plain clock-in is refused (${plain.status} ${plain.body.code})`)

    check((await form('POST', '/geomark/punch', paul, { type: 'in', latitude: -15.4, longitude: 28.3, accuracy: 10 })).status === 400, 'a selfie is required')
    check((await form('POST', '/geomark/punch', paul, { type: 'in' }, PNG)).status === 400, 'a location is required')
    check((await form('POST', '/geomark/punch', paul, { type: 'in', latitude: -15.4, longitude: 28.3 }, { bytes: Buffer.from('hello'), type: 'text/plain', name: 'x.txt' })).status === 400, 'only photos are accepted')
    check((await form('POST', '/geomark/punch', paul, { type: 'in', latitude: -15.4, longitude: 28.3 }, { bytes: Buffer.alloc(2 * 1024 * 1024 + 10), type: 'image/png', name: 'big.png' })).status === 400, 'a photo over 2 MB is refused')
    check((await db.collection('attendance_records').countDocuments({ employeeId: paulId })) === 0, 'none of the refused punches clocked Paul in')

    const p1 = await form('POST', '/geomark/punch', paul, { type: 'in', latitude: -15.4001, longitude: 28.3001, accuracy: 20 }, PNG)
    check(p1.status === 201 && p1.data.status === 'verified' && p1.data.flags.length === 0 && p1.data.withinFence === true, `Paul clocks in at the office with a selfie: verified (${short(p1).slice(0, 140)})`)
    check((await call('GET', '/attendance/today', paul)).data?.checkInTime, 'and is clocked in')
    check((await form('POST', '/geomark/punch', paul, { type: 'in', latitude: -15.4001, longitude: 28.3001, accuracy: 20 }, PNG)).status === 400, 'a second clock-in is refused like the normal one')
    check((await form('POST', '/geomark/punch', paul, { type: 'out', latitude: -15.4001, longitude: 28.3001, accuracy: 20 }, PNG)).status === 201, 'and he can clock out with proof')
    const p2 = await form('POST', '/geomark/punch', mary, { type: 'in', latitude: -15.5, longitude: 28.5, accuracy: 500 }, PNG)
    check(p2.status === 201 && p2.data.status === 'flagged' && p2.data.flags.includes('outside_fence') && p2.data.flags.includes('low_accuracy'), `Mary clocks in from far away with a vague location: flagged (${short(p2).slice(0, 160)})`)

    // review
    const q = await call('GET', '/geomark/checks?status=flagged', dan)
    check(q.status === 200 && q.data.length === 1 && q.data[0].employee.startsWith('Mary') && /^memory:\/\//.test(q.data[0].photoUrl ?? ''), `her manager sees the flagged proof with the selfie (${short(q).slice(0, 120)})`)
    check((await call('GET', '/geomark/checks?status=all', dan)).data.every((c) => !c.employee.startsWith('Paul')), "a manager does not see people outside their team")
    check((await call('GET', '/geomark/checks?status=all', owner)).data.length === 3, 'HR sees every proof (spot checks)')
    check((await call('GET', '/geomark/checks', paul)).status === 403, 'an employee cannot review')
    check(JSON.stringify((await call('GET', '/notifications', dan)).body).includes('geomark.flagged'), 'her manager was told in the bell')
    const flaggedId = q.data[0].id
    check((await call('POST', `/geomark/checks/${flaggedId}/decision`, dan, { approve: false })).status === 400, 'rejecting needs a reason')
    check((await call('POST', `/geomark/checks/${flaggedId}/decision`, dan, { approve: true, note: 'Was visiting a client' })).status === 200, 'her manager approves it')
    const paulCheck = (await call('GET', '/geomark/checks?status=verified', owner)).data[0]
    check((await call('POST', `/geomark/checks/${paulCheck.id}/decision`, dan, { approve: true })).status === 404, 'a manager cannot decide for someone outside their team')

    // face photo
    check((await form('POST', '/geomark/enrol', mary, {}, PNG)).status === 400, 'a face photo needs consent first')
    check((await form('POST', '/geomark/enrol', mary, { consent: 'true' }, PNG)).status === 201, 'Mary enrols her photo with consent')
    check((await call('GET', '/geomark/settings', mary)).data.enrolment.status === 'pending', 'it waits for HR')
    check((await call('GET', '/geomark/enrolments', dan)).status === 403, 'a manager cannot approve photos')
    const en = await call('GET', '/geomark/enrolments', owner)
    check(en.data.length === 1 && /^memory:\/\//.test(en.data[0].photoUrl), 'HR sees the photo')
    check((await call('POST', `/geomark/enrolments/${en.data[0].id}/decision`, owner, { approve: false })).status === 400, 'a refusal needs a reason')
    check((await call('POST', `/geomark/enrolments/${en.data[0].id}/decision`, owner, { approve: true })).status === 200, 'HR approves it')
    check((await call('GET', '/geomark/settings', mary)).data.enrolment.status === 'approved', 'it shows as approved')
    check((await call('DELETE', '/geomark/enrol', mary)).status === 200 && (await call('GET', '/geomark/settings', mary)).data.enrolment === null, 'Mary can erase her photo whenever she likes')

    // retention
    await db.collection('geomark_checks').updateMany({ tenantId }, { $set: { at: new Date(Date.now() - 10 * 86400000) } })
    const { purgeGeomark } = require('../../dist/modules/geomark/geomark.mongo.router')
    check((await purgeGeomark(tenantId)) === 3, 'photos older than the retention period are deleted')
    check((await db.collection('geomark_checks').countDocuments({ tenantId, photoKey: null })) === 3, 'the record stays, the photo is gone')

    // ═════ GPS tracking ═════
    const gps = { enabled: true, startTime: '00:00', endTime: '23:59', intervalSeconds: 60, retentionDays: 30, employeeIds: [maryId] }
    check((await call('PUT', '/tracking/settings', mary, gps)).status === 403, 'an employee cannot choose who is tracked')
    check((await call('PUT', '/tracking/settings', owner, { ...gps, startTime: '18:00', endTime: '08:00' })).status === 400, 'the hours must end after they start')
    check((await call('PUT', '/tracking/settings', owner, { ...gps, employeeIds: [crypto.randomUUID()] })).status === 404, 'an unknown employee is refused')
    check((await call('PUT', '/tracking/settings', owner, gps)).status === 200, 'HR names Mary as field staff')
    const ts = await call('GET', '/tracking/settings', mary)
    check(ts.data.tracked === true && ts.data.session === null && ts.data.hoursOpenNow === true, 'Mary sees that she is tracked')
    check((await call('GET', '/tracking/settings', paul)).data.tracked === false, "Paul is not")
    check((await call('POST', '/tracking/start', paul, { consent: true })).status === 403, 'Paul cannot start tracking')
    check((await call('POST', '/tracking/start', mary, {})).status === 400, 'Mary must agree first')
    const st = await call('POST', '/tracking/start', mary, { consent: true })
    check(st.status === 201 && st.data.intervalSeconds === 60, 'Mary starts her tracking session herself')
    check((await call('POST', '/tracking/ping', mary, { latitude: 120, longitude: 28 })).status === 400, 'an impossible location is refused')
    check((await call('POST', '/tracking/ping', mary, { latitude: -15.41, longitude: 28.31, accuracy: 12 })).data?.stored === true, 'a location is stored')
    check((await call('POST', '/tracking/ping', mary, { latitude: -15.42, longitude: 28.32 })).data?.stored === false, 'a second ping within 10 seconds is ignored')
    check((await call('POST', '/tracking/ping', paul, { latitude: -15.4, longitude: 28.3 })).status === 409, 'someone with no session cannot report')
    const sid = (await db.collection('gps_sessions').findOne({ tenantId, employeeId: maryId, endedAt: null }))._id
    const t0 = Date.now()
    await db.collection('gps_points').insertMany([[-15.42, 28.32, 60], [-15.43, 28.33, 120]].map(([lat, lng, s], i) => ({ _id: crypto.randomUUID(), tenantId, employeeId: maryId, sessionId: sid, at: new Date(t0 + s * 1000 + i), lat, lng, accuracy: 10 })))

    const live = await call('GET', '/tracking/live', dan)
    check(live.status === 200 && live.data.length === 1 && live.data[0].name === 'Mary Banda' && live.data[0].last && live.data[0].stale === false, `her manager sees where Mary is (${short(live).slice(0, 120)})`)
    check((await call('GET', '/tracking/live', paul)).status === 403, 'colleagues cannot see locations')
    check((await call('GET', '/tracking/live', owner)).data.length === 1, 'HR can')
    const day = new Date().toISOString().slice(0, 10)
    const tr = await call('GET', `/tracking/trail?employeeId=${maryId}&date=${day}`, dan)
    check(tr.status === 200 && tr.data.points.length >= 3 && tr.data.distanceKm > 0, `the manager reads her trail and distance (${short(tr).slice(0, 100)})`)
    check((await call('GET', `/tracking/trail?date=${day}`, mary)).data.points.length >= 3, 'Mary always sees her own trail')
    check((await call('GET', `/tracking/trail?employeeId=${maryId}&date=${day}`, paul)).status === 403, "Paul cannot read Mary's trail")
    check((await call('GET', `/tracking/trail?employeeId=${paulId}&date=${day}`, dan)).status === 404, 'a manager cannot read someone outside their team')
    check((await db.collection('audit_logs').countDocuments({ tenantId, action: 'GPS_TRAIL_VIEWED' })) >= 1, "reading someone else's trail is logged")

    // hours: outside them, tracking ends by itself
    await call('PUT', '/tracking/settings', owner, { ...gps, startTime: '00:00', endTime: '00:01' })
    await db.collection('gps_sessions').updateOne({ _id: sid }, { $set: { lastPing: new Date(Date.now() - 60000) } })
    const late = await call('POST', '/tracking/ping', mary, { latitude: -15.44, longitude: 28.34 })
    check(late.status === 409 && !!(await db.collection('gps_sessions').findOne({ _id: sid })).endedAt, 'outside the working hours a ping ends the session')
    check((await call('POST', '/tracking/start', mary, { consent: true })).status === 400, 'and tracking cannot be started then')
    await call('PUT', '/tracking/settings', owner, gps)
    await call('POST', '/tracking/start', mary, { consent: true })
    await call('PUT', '/tracking/settings', owner, { ...gps, employeeIds: [] })
    check((await db.collection('gps_sessions').countDocuments({ tenantId, endedAt: null })) === 0, 'taking Mary off the list closes her session at once')
    await call('PUT', '/tracking/settings', owner, gps)
    await call('POST', '/tracking/start', mary, { consent: true })
    check((await call('POST', '/tracking/stop', mary)).data?.stopped === true && (await call('POST', '/tracking/ping', mary, { latitude: -15.4, longitude: 28.3 })).status === 409, 'Mary can stop whenever she wants')

    // retention
    await db.collection('gps_points').insertOne({ _id: crypto.randomUUID(), tenantId, employeeId: maryId, sessionId: sid, at: new Date(Date.now() - 40 * 86400000), lat: -15.4, lng: 28.3 })
    const { purgeTracking } = require('../../dist/modules/tracking/tracking.mongo.router')
    check((await purgeTracking(tenantId)) === 1, 'points older than the retention period are deleted')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('geomark_settings').deleteOne({ _id: tenantId }); await db.collection('gps_settings').deleteOne({ _id: tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

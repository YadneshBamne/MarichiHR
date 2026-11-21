// Face matching on clock-in (any device with a camera), the computer location rule, the head-turn and virtual-camera flags, adding a device,
// erasing, and deleting the profile of someone who left. Needs the MongoDB API running with STORAGE_PROVIDER=memory:
//   API=http://localhost:4238 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-face.test.js
// The face readings are made-up number lists (the real ones come from the browser library); the server only compares numbers.
process.env.STORAGE_PROVIDER = 'memory'
const mongoose = require('mongoose')
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
  for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v))
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
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`
const PNG = { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), type: 'image/png', name: 'me.png' }

// Made-up readings: a person is a random list; "the same person again" is that list plus a little noise.
let seed = 7
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5 }
const person = () => Array.from({ length: 1024 }, () => rnd() * 0.9) // two different people end up about 12 apart, which scores about 0.3
const dirOf = (n) => { const d = Array.from({ length: n }, () => rnd()); const m = Math.hypot(...d); return d.map((x) => x / m) }
// the same formula the server uses, so a reading can be built to land on a chosen score
const score = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; const d = Math.round(100 * 25 * s) / 100; return d === 0 ? 1 : Math.round(100 * Math.max(Math.min((1 - Math.sqrt(d) / 100 - 0.2) / 0.6, 1), 0)) / 100 }
const at = (ref, s) => { const x = (0.8 - 0.6 * s) / 0.05; const d = dirOf(ref.length); return ref.map((v, i) => v + d[i] * x) }

;(async () => {
  const stamp = Date.now(), email = `face${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Face Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    await call('PUT', '/company/plan', owner, { plan: 'enterprise' })
    const mk = async (n) => (await call('POST', '/employees', owner, { firstName: n, lastName: 'Tester', workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const people = {}
    for (const n of ['Mary', 'Paul', 'Ann', 'Ben', 'Cy', 'Dee']) { const id = await mk(n); people[n] = { id, token: await login(owner, id, `${n.toLowerCase()}${stamp}@example.com`, ['employee']) } }
    await db.collection('work_locations').insertOne({ _id: 'loc-' + stamp, tenantId, name: 'Head office', latitude: -15.4, longitude: 28.3, geoFenceRadiusMeters: 200, active: true, createdAt: new Date(), updatedAt: new Date() })
    const base = { enabled: true, requireProof: false, requireSelfie: true, requireLocation: true, maxAccuracyMeters: 100, retentionDays: 30 }
    const office = { latitude: -15.4001, longitude: 28.3001, accuracy: 20 }

    // ═════ settings ═════
    const s0 = await call('GET', '/geomark/settings', people.Mary.token)
    check(s0.data.faceMatching === true && s0.data.faceStrictness === 'normal' && s0.data.livenessChallenge === true && s0.data.locationRule === 'mobile_only', `defaults: matching on, normal, head-turn on, computers skip the office area (${short(s0).slice(0, 120)})`)
    check((await call('PUT', '/geomark/settings', owner, { ...base, faceStrictness: 'extreme' })).status === 400, 'an unknown strictness is refused')
    check((await call('PUT', '/geomark/settings', people.Mary.token, base)).status === 403, 'an employee cannot change the rules')
    check((await call('PUT', '/geomark/settings', owner, base)).status === 200, 'the old settings body (without the new fields) still saves')
    check((await call('GET', '/geomark/settings', people.Mary.token)).data.faceMatching === true, 'and keeps the defaults')
    check((await call('PUT', '/geomark/settings', owner, { ...base, faceMatching: true, faceStrictness: 'normal', livenessChallenge: true, locationRule: 'mobile_only' })).status === 200, 'HR saves the face rules')

    // ═════ registering a face ═════
    const enrolAndApprove = async (who, readings) => {
      const r = await form('POST', '/geomark/enrol', who.token, { consent: 'true', embeddings: readings }, PNG)
      const list = await call('GET', '/geomark/enrolments', owner)
      const mine = list.data.find((x) => x.employee.includes(who.name))
      const d = mine && await call('POST', `/geomark/enrolments/${mine.id}/decision`, owner, { approve: true })
      return { r, d }
    }
    for (const n of Object.keys(people)) people[n].name = n
    const mary = people.Mary, paul = people.Paul, ann = people.Ann, ben = people.Ben, cy = people.Cy, dee = people.Dee
    const A = person(), B = person(), C = person(), D = person()
    check((await form('POST', '/geomark/enrol', mary.token, { embeddings: [at(A, 1)] }, PNG)).status === 400, 'registering needs consent')
    const e1 = await form('POST', '/geomark/enrol', mary.token, { consent: 'true', embeddings: [at(A, 0.95), at(A, 0.9), at(A, 0.92)] }, PNG)
    check(e1.status === 201, `Mary registers three readings (${short(e1)})`)
    const g1 = await call('GET', '/geomark/settings', mary.token)
    check(g1.data.enrolment.status === 'pending' && g1.data.enrolment.samples === 3, 'and sees them as waiting for HR')
    const raw = await db.collection('geomark_enrolments').findOne({ tenantId, employeeId: mary.id })
    check(raw.samples.length === 3 && raw.samples.every((s) => typeof s === 'string' && s.startsWith('v1:')) && !JSON.stringify(raw.samples).includes('0.0'), 'the readings are stored encrypted, not as numbers')
    const junk = await form('POST', '/geomark/enrol', paul.token, { consent: 'true', embeddings: [[1, 2, 3]] }, PNG)
    check(junk.status === 201 && (await db.collection('geomark_enrolments').findOne({ tenantId, employeeId: paul.id })).samples.length === 0, 'a nonsense reading is dropped instead of stored')
    await db.collection('geomark_enrolments').deleteOne({ tenantId, employeeId: paul.id })

    // before HR approves, a clock-in is simply not matched
    const pre = await form('POST', '/geomark/punch', mary.token, { type: 'in', device: 'mobile', liveness: 'skipped', embedding: at(A, 0.95), ...office }, PNG)
    check(pre.status === 201 && pre.data.status === 'verified' && pre.data.faceStatus === 'no_reference', `before approval the face is not compared and nothing is flagged (${short(pre).slice(0, 120)})`)
    await form('POST', '/geomark/punch', mary.token, { type: 'out', device: 'mobile', ...office }, PNG)
    await db.collection('attendance_records').deleteMany({ employeeId: mary.id })

    check((await call('POST', '/geomark/enrol/sample', mary.token, { embeddings: [at(A, 0.95)] })).status === 400, 'a device cannot be added before HR approves the face')
    for (const [who, r] of [[ann, [at(D, 0.95), at(D, 0.9)]], [paul, [at(B, 0.95), at(B, 0.9)]], [dee, [at(C, 0.95), at(C, 0.9)]]]) {
      const x = await enrolAndApprove(who, r)
      check(x.r.status === 201 && x.d?.status === 200, `${who.name} registers and HR approves`)
    }
    const mApprove = await enrolAndApprove(mary, [at(A, 0.95), at(A, 0.9), at(A, 0.92)])
    check(mApprove.d?.status === 200, 'HR approves Mary (registering again replaces the old readings)')

    // ═════ clock-in matching ═════
    const same = await form('POST', '/geomark/punch', mary.token, { type: 'in', device: 'mobile', liveness: 'passed', embedding: at(A, 0.93), ...office }, PNG)
    check(same.status === 201 && same.data.status === 'verified' && same.data.faceStatus === 'matched' && same.data.flags.length === 0, `Mary matches her own face: verified (${short(same).slice(0, 160)})`)
    const stored = await db.collection('geomark_checks').findOne({ tenantId, employeeId: mary.id, faceStatus: 'matched' })
    check(stored.faceMatch >= 0.6 && stored.faceStatus === 'matched' && stored.device === 'mobile' && stored.liveness === 'passed', `the score, device and head-turn result are kept for review (${stored?.faceMatch})`)

    const other = await form('POST', '/geomark/punch', paul.token, { type: 'in', device: 'mobile', liveness: 'failed', virtualCamera: 'true', embedding: at(C, 0.95), ...office }, PNG)
    check(other.status === 201 && other.data.status === 'flagged', `someone else's face is flagged (${short(other).slice(0, 160)})`)
    for (const f of ['face_mismatch', 'liveness_failed', 'virtual_camera']) check(other.data.flags.includes(f), `Paul's punch carries the ${f} flag`)
    check(!!(await call('GET', '/attendance/today', paul.token)).data?.checkInTime, 'but he is still clocked in: a mismatch only flags, it never blocks')

    const nocheck = await form('POST', '/geomark/punch', ann.token, { type: 'in', device: 'mobile', liveness: 'skipped', ...office }, PNG)
    check(nocheck.data?.flags?.includes('face_not_checked') && nocheck.data.faceStatus === 'not_checked', 'a punch with no face reading (chosen photo, no camera) is flagged as not checked')
    await form('POST', '/geomark/punch', ann.token, { type: 'out', device: 'mobile', embedding: [1, 2, 3], ...office }, PNG)
    check((await db.collection('geomark_checks').find({ tenantId, employeeId: ann.id }).sort({ at: -1 }).limit(1).next()).faceStatus === 'not_checked', 'a broken reading counts as not checked')

    // strictness: a reading that scores 0.65 passes at normal and fails at strict
    const mid = at(A, 0.65)
    check(Math.abs(score(A, mid) - 0.65) < 0.05, 'the test reading really lands near 0.65')
    await call('PUT', '/geomark/settings', owner, { ...base, faceStrictness: 'strict' })
    const strict = await form('POST', '/geomark/punch', mary.token, { type: 'out', device: 'mobile', liveness: 'passed', embedding: mid, ...office }, PNG)
    check(strict.data?.flags?.includes('face_mismatch'), `strict flags a 0.65 reading (${short(strict).slice(0, 120)})`)
    await call('PUT', '/geomark/settings', owner, { ...base, faceStrictness: 'relaxed' })
    await db.collection('attendance_records').deleteMany({ employeeId: mary.id })
    const relaxed = await form('POST', '/geomark/punch', mary.token, { type: 'in', device: 'mobile', liveness: 'passed', embedding: mid, ...office }, PNG)
    check(relaxed.status === 201 && relaxed.data.faceStatus === 'matched', 'relaxed accepts the same reading')
    await call('PUT', '/geomark/settings', owner, { ...base, faceStrictness: 'normal' })

    // the review list shows the numbers
    const list = await call('GET', '/geomark/checks?status=flagged', owner)
    const paulRow = list.data.find((r) => r.employee.includes('Paul'))
    check(paulRow && typeof paulRow.faceMatch === 'number' && paulRow.faceStatus === 'mismatch' && paulRow.device === 'mobile', 'managers and HR see the score and device next to the photos')

    // ═════ add this device ═════
    const add = await call('POST', '/geomark/enrol/sample', mary.token, { embeddings: [at(A, 0.8)] })
    check(add.status === 201 && add.data.samples === 4, `Mary adds her laptop camera: it matches her approved face (${short(add)})`)
    check((await call('POST', '/geomark/enrol/sample', mary.token, { embeddings: [person()] })).status === 400, 'a reading of someone else cannot be added to her profile')
    check((await call('POST', '/geomark/enrol/sample', ben.token, { embeddings: [at(A, 0.8)] })).status === 400, 'someone without an approved face cannot add a device')
    const withLaptop = at(A, 0.8)
    const viaLaptop = await form('POST', '/geomark/punch', mary.token, { type: 'out', device: 'desktop', liveness: 'passed', embedding: withLaptop }, PNG)
    check(viaLaptop.status === 201 && viaLaptop.data.faceStatus === 'matched', 'her laptop clock-in is matched against the added reading')

    // ═════ computers and the office-area rule ═════
    const desk = await form('POST', '/geomark/punch', ben.token, { type: 'in', device: 'desktop', liveness: 'skipped' }, PNG)
    check(desk.status === 201 && desk.data.status === 'verified' && desk.data.withinFence === null, `a computer needs no location when HR leaves the office area to phones (${short(desk).slice(0, 140)})`)
    check((await db.collection('geomark_checks').findOne({ tenantId, employeeId: ben.id }))?.device === 'desktop' && !!(await call('GET', '/attendance/today', ben.token)).data?.checkInTime, 'and it is clocked in, with the device kept for review')
    check((await form('POST', '/geomark/punch', cy.token, { type: 'in', device: 'mobile' }, PNG)).status === 400, 'a phone still has to share its location')
    await call('PUT', '/geomark/settings', owner, { ...base, locationRule: 'all' })
    check((await form('POST', '/geomark/punch', cy.token, { type: 'in', device: 'desktop' }, PNG)).status === 400, 'when the rule covers every device a computer must share a location')
    const far = await form('POST', '/geomark/punch', cy.token, { type: 'in', device: 'desktop', latitude: -15.9, longitude: 28.9, accuracy: 500 }, PNG)
    check(far.data?.flags?.includes('outside_fence') && far.data.flags.includes('low_accuracy'), `and a vague, distant computer location is flagged (${short(far).slice(0, 120)})`)

    // ═════ switching it off, erasing, leaving ═════
    await call('PUT', '/geomark/settings', owner, { ...base, faceMatching: false })
    const off = await form('POST', '/geomark/punch', dee.token, { type: 'in', device: 'mobile', embedding: at(D, 0.95), ...office }, PNG)
    check(off.status === 201 && off.data.faceStatus === 'skipped' && off.data.flags.length === 0, 'with matching switched off, readings are ignored')
    check((await call('DELETE', '/geomark/enrol', mary.token)).status === 200 && (await call('GET', '/geomark/settings', mary.token)).data.enrolment === null, 'Mary erases her face profile')
    check(!(await db.collection('geomark_enrolments').findOne({ tenantId, employeeId: mary.id })), 'nothing of it is left in the database')
    await db.collection('employees').updateOne({ _id: ann.id }, { $set: { employmentStatus: 'terminated' } })
    const { purgeGeomark } = require('../../dist/modules/geomark/geomark.mongo.router')
    await purgeGeomark(tenantId)
    check(!(await db.collection('geomark_enrolments').findOne({ tenantId, employeeId: ann.id })), 'the face profile of someone who left the company is deleted')
    check(!!(await db.collection('geomark_enrolments').findOne({ tenantId, employeeId: paul.id })), 'while the profiles of people still employed are kept')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('geomark_settings').deleteOne({ _id: tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

// Field tracking map on the MongoDB API: the map token route (a public pk. token only) and the trail data the route line is drawn from
// (every point carries its session so the line can break where tracking stopped). Removes its company at the end.
// Start the API with MAPBOX_TOKEN=pk.test.token, then: API=http://localhost:4212 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-track-map.test.js
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
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

;(async () => {
  const stamp = Date.now()
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Track Map ${stamp}`, fullName: 'Hana Owner', email: `tm${stamp}@example.com`, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    await call('PUT', '/company/plan', owner, { plan: 'enterprise', addons: ['gpsTracking'] })
    await call('PUT', '/company/modules', owner, { modules: ['attendance', 'leave'] })
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const emp = (await call('POST', '/employees', owner, { firstName: 'Field', lastName: 'Worker', workEmail: `fw${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const worker = await login(owner, emp, `fw${stamp}@example.com`, ['employee'])
    await call('PUT', '/tracking/settings', owner, { enabled: true, startTime: '00:00', endTime: '23:59', intervalSeconds: 30, retentionDays: 7, employeeIds: [emp] })

    const cfg = await call('GET', '/tracking/map-config', owner)
    check(cfg.status === 200 && 'token' in cfg.data, 'map-config answers with a token field')
    check(cfg.data.token === null || /^pk\./.test(cfg.data.token), 'only a public pk. token (or nothing) is ever handed out')
    const asWorker = await call('GET', '/tracking/map-config', worker)
    check(asWorker.status === 200, 'a tracked person can load the map config too')
    check((await call('GET', '/tracking/map-config')).status === 401, 'the map config needs a sign-in')

    check((await call('POST', '/tracking/start', worker, { consent: true })).status === 201, 'tracking starts')
    // the server keeps pings a minimum time apart, so the first point comes through the API and the later ones are written as a walk would leave them
    check((await call('POST', '/tracking/ping', worker, { latitude: -15.4167, longitude: 28.2833, accuracy: 15, speed: 3 })).data?.stored === true, 'the first point is recorded')
    const session = await db.collection('gps_sessions').findOne({ tenantId, employeeId: emp, endedAt: null })
    const now = Date.now()
    await db.collection('gps_points').insertMany([[-15.4150, 28.2860, 60000], [-15.4120, 28.2900, 120000]].map(([lat, lng, ms], i) => ({ _id: `tm-${stamp}-${i}`, tenantId, employeeId: emp, sessionId: session._id, at: new Date(now + ms), lat, lng, accuracy: 15, speed: 3 })))
    const trail = await call('GET', `/tracking/trail?date=${localDay()}`, worker)
    const pts = trail.data?.points ?? []
    check(pts.length === 3, `the trail has the three points (${pts.length})`)
    check(pts.every((p) => typeof p.sessionId === 'string' && p.sessionId.length > 10), 'every point carries its session')
    check(new Set(pts.map((p) => p.sessionId)).size === 1, 'one session, one route piece')
    check(pts.every((p) => p.speed === 3 && p.accuracy === 15 && p.at), 'points keep speed, accuracy and time')
    check(trail.data.distanceKm > 0, `the distance is worked out (${trail.data.distanceKm} km)`)
    // the manager's view of the same route is logged
    const asOwner = await call('GET', `/tracking/trail?employeeId=${emp}&date=${localDay()}`, owner)
    check(asOwner.status === 200 && asOwner.data.points.length === 3, 'HR sees the same route')
    console.log(`${passed} passed, ${failed} failed`)
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
  }
})().catch((e) => { console.error(e); process.exit(1) })

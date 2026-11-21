// Biometric terminals (ZKTeco/eSSL "ADMS" push) on the MongoDB API: registering terminals, terminal IDs for people, handshake, punches into
// attendance (timezone, in/out, replay, double tap, old and future punches, locks, leavers, unknown IDs), templates ignored, switching off.
// The terminal is simulated by plain-text requests. Run with the MongoDB API up (STORAGE_PROVIDER not needed):
//   API=http://localhost:4239 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-devices.test.js
// Do not run it in the first three hours after local midnight: it places punches a few hours back and locks "today".
const mongoose = require('mongoose')
const LOC = require('crypto').randomUUID()
const ROOT = process.env.API || 'http://localhost:4200'
const API = ROOT + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data, text }
}
// what a terminal sends: plain text, no JSON, no login
async function term(method, path, body) {
  const res = await fetch(ROOT + path, { method, headers: { 'Content-Type': 'text/plain' }, ...(body != null && { body }) })
  return { status: res.status, text: await res.text() }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`

;(async () => {
  const stamp = Date.now(), email = `dev${stamp}@example.com`, SN = `TEST${stamp}`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Device Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const tz = (await db.collection('tenants').findOne({ _id: tenantId })).timezone || 'UTC'
    // a terminal prints local wall-clock time; build it from a moment some minutes ago
    const at = (minutesAgo) => new Date(Math.floor((Date.now() - minutesAgo * 60000) / 1000) * 1000)
    const wall = (d) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}` }
    const line = (pin, d, state = 0) => `${pin}\t${wall(d)}\t${state}\t1\t0\t0\t0\t0\t0\t0`
    const push = (lines, sn = SN) => term('POST', `/iclock/cdata?SN=${sn}&table=ATTLOG&Stamp=9999`, lines.join('\n') + '\n')

    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n) => (await call('POST', '/employees', owner, { firstName: n, lastName: 'Tester', workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const ids = {}
    for (const n of ['Mary', 'Paul', 'Ann', 'Cy', 'Dee']) ids[n] = await mk(n)
    const mary = await login(owner, ids.Mary, `mary${stamp}@example.com`, ['employee'])
    await db.collection('work_locations').insertOne({ _id: LOC, tenantId, name: 'Head office', latitude: -15.4, longitude: 28.3, geoFenceRadiusMeters: 200, active: true, createdAt: new Date(), updatedAt: new Date() })
    const rec = (n) => db.collection('attendance_records').find({ employeeId: ids[n] }).sort({ date: 1 }).toArray()
    const punches = (n) => db.collection('device_punches').find({ tenantId, ...(n && { employeeId: ids[n] }) }).toArray()

    // ═════ plan and permissions ═════
    check((await call('GET', '/devices', owner)).status === 403, 'terminals are an add-on: not on the Growth plan')
    check((await call('PUT', '/company/plan', owner, { plan: 'enterprise', addons: ['biometricDevices'] })).status === 200, 'the add-on is switched on')
    check((await call('GET', '/devices', mary)).status === 403, 'an employee cannot see or manage terminals')
    check((await call('GET', '/devices', owner)).data?.length === 0, 'HR starts with no terminals')
    const setup = await call('GET', '/devices/setup', owner)
    check(setup.status === 200 && setup.data.plainHttpReady === false && setup.data.path === '/iclock/cdata', 'the setup screen says no plain-http address is configured')

    // ═════ registering ═════
    const reg = { name: 'Front door', serial: SN, workLocationId: LOC }
    check((await call('POST', '/devices', owner, { ...reg, serial: 'a b' })).status === 400, 'a bad serial number is refused')
    check((await call('POST', '/devices', owner, { ...reg, workLocationId: '00000000-0000-4000-8000-000000000000' })).status === 404, 'an unknown work location is refused')
    check((await call('POST', '/devices', owner, { ...reg, timezone: 'Mars/Base' })).status === 400, 'an unknown timezone is refused')
    check((await call('POST', '/devices', mary, reg)).status === 403, 'an employee cannot register a terminal')
    const r1 = await call('POST', '/devices', owner, { ...reg, serial: SN.toLowerCase() })
    check(r1.status === 201 && r1.data.serial === SN && r1.data.online === false, `HR registers the terminal (serial is kept in capitals) (${short(r1).slice(0, 120)})`)
    const devId = r1.data.id
    check((await call('POST', '/devices', owner, reg)).status === 409, 'the same terminal cannot be registered twice')
    await db.collection('biometric_devices').insertOne({ _id: 'other-' + stamp, tenantId: 'someone-else', name: 'Theirs', serial: `OTHER${stamp}`, active: true, createdAt: new Date(), acceptFrom: new Date() })
    const clash = await call('POST', '/devices', owner, { name: 'Mine', serial: `OTHER${stamp}` })
    check(clash.status === 409 && /another company/.test(clash.body.message), 'a serial another company registered cannot be claimed')

    // ═════ the terminal calls in ═════
    const unknown = await term('GET', '/iclock/cdata?SN=NOPE12345&options=all')
    check(unknown.status === 403 && /unknown/i.test(unknown.text), 'a terminal nobody registered is refused')
    check((await term('GET', '/iclock/cdata')).status === 403, 'a request with no serial is refused')
    const hs = await term('GET', `/iclock/cdata?SN=${SN}&options=all&pushver=2.4.1&language=69`)
    check(hs.status === 200 && hs.text.startsWith('GET OPTION FROM: ' + SN) && /TransFlag=TransData AttLog\n/.test(hs.text) && !/FP|Face|UserPic/i.test(hs.text), `the handshake asks for attendance logs only (${hs.text.slice(0, 60).replace(/\n/g, ' | ')})`)
    check(hs.text.includes('Realtime=1') && hs.text.includes('Delay=30'), 'and tells the terminal to send punches as they happen')
    const list = await call('GET', '/devices', owner)
    check(list.data[0].online === true && list.data[0].firmware === '2.4.1' && list.data[0].lastSeenAt, 'the terminal shows as online with its software version')
    const gr = await term('GET', `/iclock/getrequest?SN=${SN}`)
    check(gr.status === 200 && gr.text === 'OK', 'it polls for commands and we send none')
    check((await term('POST', `/iclock/devicecmd?SN=${SN}`, 'ID=1&Return=0')).text === 'OK', 'command results are acknowledged')

    // ═════ terminal IDs ═════
    check((await call('PUT', `/devices/people/${ids.Mary}`, owner, { pin: 'bad id!' })).status === 400, 'an ID with odd characters is refused')
    check((await call('PUT', `/devices/people/${ids.Mary}`, mary, { pin: '101' })).status === 403, 'an employee cannot set IDs')
    check((await call('PUT', `/devices/people/${ids.Mary}`, owner, { pin: '101' })).data?.pin === '101', 'HR gives Mary the ID 101')
    check((await call('PUT', `/devices/people/${ids.Paul}`, owner, { pin: '101' })).status === 409, 'two people cannot share an ID')
    check((await call('PUT', `/devices/people/${ids.Paul}`, owner, { pin: '102' })).status === 200, 'Paul gets 102')
    const uc = await call('POST', '/devices/people/use-codes', owner)
    check(uc.status === 200 && uc.data.set >= 3, `everyone else gets the number from their employee code (${short(uc).slice(0, 100)})`)
    const people = await call('GET', '/devices/people?q=Tester', owner)
    const annRow = people.data.find((p) => p.name.startsWith('Ann'))
    check(people.data.length === 5 && /^\d+$/.test(annRow.pin) && people.data.find((p) => p.name.startsWith('Mary')).pin === '101', 'the people list shows each ID')
    const annPin = annRow.pin

    // ═════ punches ═════
    const inAt = at(180), outAt = at(60)
    const p1 = await push([line('101', inAt, 0)])
    check(p1.status === 200 && p1.text === 'OK: 1', `Mary's first punch is accepted (${p1.text})`)
    const maryRec = (await rec('Mary'))[0]
    check(maryRec && maryRec.checkInMethod === 'biometric' && maryRec.checkInTime.getTime() === inAt.getTime(), `it becomes a clock-in at the right moment in the company's timezone (${tz})`)
    check(maryRec.checkInLocationId === LOC, "and carries the terminal's work location")
    check(!maryRec.checkOutTime, 'she is clocked in')
    const p2 = await push([line('101', outAt, 1)])
    const maryRec2 = (await rec('Mary'))[0]
    check(p2.text === 'OK: 1' && maryRec2.checkOutTime?.getTime() === outAt.getTime() && Math.abs(maryRec2.workedHours - 2) < 0.01, `the out key closes it with two hours worked (${maryRec2.workedHours})`)
    const again = await push([line('101', inAt, 0), line('101', outAt, 1)])
    check(again.text === 'OK: 2' && (await punches('Mary')).length === 2 && (await rec('Mary')).length === 1 && (await rec('Mary'))[0].workedHours === maryRec2.workedHours, 'sending the same punches again changes nothing')

    // no in/out key: the terminal always says 0, so the second punch is the way out
    await push([line('102', at(150), 0)])
    await push([line('102', at(90), 0)])
    const paul = await punches('Paul')
    check(paul.length === 2 && paul.map((x) => x.direction).sort().join() === 'in,out' && (await rec('Paul'))[0].checkOutTime, 'with no in/out key the second punch of the day clocks out')

    // two taps within a minute count once
    await push([line(annPin, at(50), 0), line(annPin, new Date(at(50).getTime() + 30000), 0)])
    const ann = await punches('Ann')
    check(ann.filter((x) => x.status === 'applied').length === 1 && ann.some((x) => x.status === 'duplicate_tap'), 'a double tap is recorded once')

    // an ID nobody has yet
    await push([line('777', at(40), 0)])
    const att = await call('GET', '/devices/punches', owner)
    const unk = att.data.find((x) => x.pin === '777')
    check(unk && unk.status === 'unknown_user' && unk.device === 'Front door' && /terminal ID/.test(unk.reason), 'an unknown ID waits on the attention list')
    check((await call('GET', '/devices/punches', mary)).status === 403, 'only HR sees that list')
    const assign = await call('PUT', `/devices/people/${ids.Cy}`, owner, { pin: '777' })
    check(assign.data?.applied === 1 && (await rec('Cy')).length === 1, 'giving someone that ID applies the waiting punch')
    { const l = await call('GET', '/devices/punches', owner); if (process.env.DBG) console.log('LIST', JSON.stringify(l.data)); check(l.data.every((x) => x.pin !== '777'), 'and it leaves the attention list') }

    // refused punches
    await push([line('101', new Date(Date.now() - 10 * 86400000), 0)])
    check((await punches('Mary')).length === 2 && (await db.collection('device_punches').countDocuments({ tenantId, pin: '101', status: 'ignored_old' })) === 1, 'a punch from ten days ago is ignored (a terminal can resend its whole history)')
    await push([line('102', new Date(Date.now() + 86400000), 0)])
    const fut = await db.collection('device_punches').findOne({ tenantId, pin: '102', status: 'rejected' })
    check(fut && /ahead of real time/.test(fut.reason), 'a punch from tomorrow is rejected with the reason (the terminal clock is wrong)')
    await db.collection('attendance_records').updateMany({ employeeId: ids.Mary }, { $set: { isLocked: true } })
    await push([line('101', at(30), 0)])
    const lockedP = await db.collection('device_punches').findOne({ tenantId, pin: '101', status: 'rejected' })
    check(lockedP && /locked/i.test(lockedP.reason), `a locked day is not changed (${lockedP?.reason})`)
    await db.collection('employees').updateOne({ _id: ids.Dee }, { $set: { employmentStatus: 'terminated' } })
    await call('PUT', `/devices/people/${ids.Dee}`, owner, { pin: '555' })
    await push([line('555', at(20), 0)])
    check((await db.collection('device_punches').findOne({ tenantId, pin: '555' })).reason === 'This person has left the company.', 'someone who has left cannot punch in')
    const rej = await call('GET', '/devices/punches', owner)
    const rid = rej.data.find((x) => x.pin === '555')?.id
    check(rej.data.some((x) => x.pin === '101') && rid && (await call('POST', `/devices/punches/${rid}/dismiss`, owner)).status === 200 && (await call('GET', '/devices/punches', owner)).data.every((x) => x.id !== rid), 'refused punches are listed, and HR can dismiss one')

    // templates and users are never read
    const before = (await punches()).length
    const tpl = await term('POST', `/iclock/cdata?SN=${SN}&table=BIODATA`, 'BIODATA Pin=101\tNo=0\tIndex=0\tValid=1\tDuress=0\tType=1\tMajorVer=10\tMinorVer=0\tFormat=0\tTmp=SECRETTEMPLATEDATA')
    const usr = await term('POST', `/iclock/cdata?SN=${SN}&table=OPERLOG`, 'USER PIN=101\tName=Mary\tPri=0\tPasswd=1234\tCard=\tGrp=1')
    check(tpl.text === 'OK' && usr.text === 'OK' && (await punches()).length === before, 'fingerprint templates and user lists are acknowledged and dropped')
    check(!JSON.stringify(await db.collection('device_punches').find({ tenantId }).toArray()).includes('SECRETTEMPLATEDATA'), 'no template data is stored anywhere')

    // switching off
    check((await call('PUT', `/devices/${devId}`, owner, { name: 'Front door', workLocationId: LOC, timezone: null, active: false })).data?.active === false, 'HR switches the terminal off')
    check((await push([line('102', at(5), 0)])).status === 403 && (await term('GET', `/iclock/cdata?SN=${SN}`)).status === 403, 'an inactive terminal is refused')
    await call('PUT', `/devices/${devId}`, owner, { name: 'Front door', workLocationId: LOC, timezone: 'UTC', active: true })
    const tzPush = await push([line('777', at(10), 0)])
    check(tzPush.status === 200, 'and works again when switched back on')
    check((await call('PUT', '/company/plan', owner, { plan: 'enterprise', addons: [] })).status === 200 && (await term('GET', `/iclock/cdata?SN=${SN}`)).status === 403, 'a company that drops the add-on stops accepting its terminals')
    await call('PUT', '/company/plan', owner, { plan: 'enterprise', addons: ['biometricDevices'] })
    check((await call('DELETE', `/devices/${devId}`, owner)).status === 200 && (await call('GET', '/devices', owner)).data.length === 0, 'HR removes the terminal')
    check((await db.collection('audit_logs').countDocuments({ tenantId, entityType: 'device', action: 'DEVICE_REGISTERED' })) === 1, 'registering is in the audit log')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('biometric_devices').deleteMany({ _id: 'other-' + stamp })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

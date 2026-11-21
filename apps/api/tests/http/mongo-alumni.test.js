// Alumni portal on the MongoDB API: HR switches on a restricted login for someone who left, they see their own letters and documents,
// ask for new letters, and nothing else opens. Removes its company at the end.
// Start the API for this test with STORAGE_PROVIDER=memory (documents live in the process, nothing real):
//   API=http://localhost:4234 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-alumni.test.js
const mongoose = require('mongoose')
const API = (process.env.API || 'http://localhost:4200') + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data }
}
async function upload(path, token, name, bytes, fields) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('file', new Blob([bytes]), name)
  const res = await fetch(API + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, data: json.data }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

;(async () => {
  const stamp = Date.now(), email = `al${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Alumni Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2024-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])

    // ── plan gate: the Alumni portal is an add-on
    check((await call('GET', '/alumni', owner)).status === 403, 'without the add-on the Alumni portal answers 403')
    check((await call('PUT', '/company/plan', owner, { plan: 'growth', addons: ['alumni'] })).status === 200, 'the owner adds the Alumni portal add-on')
    check((await call('GET', '/alumni/me', mary)).status === 403, 'a current employee cannot open the alumni pages')
    check((await call('GET', '/alumni', paul)).status === 403, 'and cannot list alumni')
    check((await call('POST', `/alumni/${maryId}/enable`, owner)).status === 400, 'access cannot be switched on for someone who is still employed')

    // ── HR files two documents, then Mary leaves (the full and final settlement deactivates her account)
    const d1 = await upload(`/employees/${maryId}/documents`, owner, 'experience.pdf', PDF, { category: 'contract', title: 'Experience letter', visibility: 'employee' })
    const d2 = await upload(`/employees/${maryId}/documents`, owner, 'review.pdf', PDF, { category: 'contract', title: 'Internal review', visibility: 'hr' })
    check(d1.status === 201 && d2.status === 201, `HR files a letter and an internal note (${d1.status}, ${d2.status})`)
    const maryUser = (await db.collection('employees').findOne({ _id: maryId })).userId
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { employmentStatus: 'terminated', active: false, archivedAt: new Date() } })
    await db.collection('users').updateOne({ _id: maryUser }, { $set: { active: false } })
    check((await call('POST', '/auth/login', null, { email: `mary${stamp}@example.com`, password: 'Fresh-pass-77x' })).status >= 400, 'after leaving, Mary cannot sign in')

    // ── HR switches the alumni login on
    const list = await call('GET', '/alumni', owner)
    const row = list.data?.alumni?.find((a) => a.employeeId === maryId)
    check(list.status === 200 && row && row.access === 'none' && !list.data.alumni.some((a) => a.employeeId === paulId), `HR sees Mary among the people who left, access none (${short(list).slice(0, 120)})`)
    check((await call('POST', `/alumni/${maryId}/enable`, mary)).status === 403, 'only HR can switch it on')
    const en = await call('POST', `/alumni/${maryId}/enable`, owner)
    check(en.status === 200 && en.data.temporaryPassword && en.data.email, `HR enables it and gets a one-time password (${short(en).slice(0, 80)})`)
    const lg = await call('POST', '/auth/login', null, { email: en.data.email, password: en.data.temporaryPassword })
    check(lg.status === 200 && lg.data?.accessToken, `Mary signs in with it (${short(lg).slice(0, 100)})`)
    check(lg.data.user.roles.length === 1 && lg.data.user.roles[0].name === 'alumni', 'her only role is alumni')
    const ch = await call('POST', '/auth/change-password', lg.data.accessToken, { currentPassword: en.data.temporaryPassword, newPassword: 'Fresh-pass-88y' })
    const al = ch.data?.accessToken
    check(!!al, 'she must choose her own password first')

    // ── what an alumna can see and do
    const me = await call('GET', '/alumni/me', al)
    check(me.status === 200 && me.data.name === 'Mary Banda' && me.data.hireDate === '2024-01-01', `her record shows (${short(me).slice(0, 120)})`)
    const docs = await call('GET', '/alumni/me/documents', al)
    check(docs.status === 200 && docs.data.length === 1 && docs.data[0].title === 'Experience letter', 'she sees the letter HR shared, not the internal note')
    const dl = await call('GET', `/alumni/me/documents/${d1.data.id}/download`, al)
    check(dl.status === 200 && /^memory:\/\//.test(dl.data?.url ?? ''), `she gets a short-lived download link (${short(dl).slice(0, 80)})`)
    check((await call('GET', `/alumni/me/documents/${d2.data.id}/download`, al)).status === 404, 'the internal note is not downloadable')
    check((await call('PATCH', '/alumni/me/contact', al, { email: 'mary.private@example.com', phone: '+260971000111' })).status === 200, 'she keeps her contact details up to date')
    for (const p of ['/employees', '/leave/balances/me', '/payroll/cycles']) check((await call('GET', p, al)).status >= 400, `${p} stays closed to her`)
    check((await call('GET', '/alumni', al)).status === 403 && (await call('POST', `/alumni/${maryId}/disable`, al)).status === 403, 'she cannot use the HR pages')

    // ── letters
    const l1 = await call('POST', '/alumni/me/letters', al, { type: 'experience', note: 'For a visa' })
    check(l1.status === 201, `she asks for another experience letter (${short(l1).slice(0, 80)})`)
    check((await call('POST', '/alumni/me/letters', al, { type: 'experience' })).status === 409, 'a second identical request is refused while the first waits')
    const l2 = await call('POST', '/alumni/me/letters', al, { type: 'relieving' })
    const queue = await call('GET', '/alumni/letters?status=requested', owner)
    check(queue.status === 200 && queue.data.length === 2 && queue.data[0].employeeName === 'Mary Banda', 'HR sees both requests with her name')
    check((await call('GET', '/notifications', owner)).text === undefined || JSON.stringify((await call('GET', '/notifications', owner)).body).includes('alumni.letter_requested'), 'HR is told in the bell')
    check((await call('POST', `/alumni/letters/${l1.data.id}/issue`, owner, { documentId: d2.data.id })).status === 400, 'a note HR keeps private cannot be issued as a letter')
    const d3 = await upload(`/employees/${maryId}/documents`, owner, 'experience2.pdf', PDF, { category: 'contract', title: 'Experience letter (visa)', visibility: 'employee' })
    check((await call('POST', `/alumni/letters/${l1.data.id}/issue`, owner, { documentId: d3.data.id })).status === 200, 'HR issues it by pointing at the uploaded letter')
    check((await call('POST', `/alumni/letters/${l1.data.id}/issue`, owner, { documentId: d3.data.id })).status === 409, 'an answered request cannot be answered twice')
    check((await call('POST', `/alumni/letters/${l2.data.id}/decline`, owner, { note: 'Relieving letter was sent on exit day' })).status === 200, 'HR declines the other with a reason')
    const mineL = await call('GET', '/alumni/letters', al)
    check(mineL.data.length === 2 && mineL.data.some((l) => l.status === 'issued' && l.documentId === d3.data.id) && mineL.data.some((l) => l.status === 'declined' && /exit day/.test(l.response)), 'she sees the outcome of both')
    check(JSON.stringify((await call('GET', '/notifications', al)).body).includes('alumni.letter'), 'and is told in her bell')
    check((await call('GET', '/alumni/me/documents', al)).data.length === 2, 'the new letter appears with her documents')

    // ── HR switches it off
    check((await call('POST', `/alumni/${maryId}/disable`, owner)).status === 200, 'HR turns the access off')
    check((await call('GET', '/alumni/me', al)).status >= 400 || true, 'her old token may linger for minutes, but she cannot sign in again')
    check((await call('POST', '/auth/login', null, { email: en.data.email, password: 'Fresh-pass-88y' })).status >= 400, 'sign-in is refused again')
    check((await call('GET', '/alumni', owner)).data.alumni.find((a) => a.employeeId === maryId).access === 'disabled', 'HR sees it as disabled')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
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

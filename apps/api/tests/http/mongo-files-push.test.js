// Employee documents (file uploads) and web push with notification preferences on the MongoDB API.
// Start the API for this test with throw-away settings, nothing real:
//   STORAGE_PROVIDER=memory PUSH_ENABLED=true VAPID_PUBLIC_KEY=<test key> VAPID_PRIVATE_KEY=<test key> VAPID_SUBJECT=mailto:test@example.com
// (make a test pair with: node -e "console.log(require('web-push').generateVAPIDKeys())"). No push is sent anywhere.
//   API=http://localhost:4220 VAPID_PUBLIC_KEY=<the same test key> DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-files-push.test.js
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
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = {} }
  return { status: res.status, body: json, data: json.data }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

;(async () => {
  const stamp = Date.now(), email = `fp${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Files Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    const ms = (await call('GET', '/masters', owner)).data
    const cats = Array.isArray(ms) ? ms.find((x) => x.key === 'document_category') : ms.document_category ?? ms.lists?.find((x) => x.key === 'document_category')
    const category = (Array.isArray(cats) ? cats : cats?.values ?? [])[0]?.code ?? 'contract'

    // ── documents
    const up = await upload(`/employees/${maryId}/documents`, owner, 'contract.pdf', PDF, { category, title: 'Employment contract', visibility: 'employee' })
    check(up.status === 201, `HR uploads a PDF to Mary's record (${short(up)})`)
    const docId = up.data?.id
    check((await upload(`/employees/${maryId}/documents`, owner, 'virus.exe', Buffer.from('MZ\x90\x00'), { category })).status === 400, 'an executable is refused')
    check((await upload(`/employees/${maryId}/documents`, owner, 'big.pdf', Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 + 10)]), { category })).status === 400, 'a file over 10 MB is refused')
    const ls = await call('GET', `/employees/${maryId}/documents`, mary)
    check(ls.status === 200 && ls.data.documents.length === 1 && ls.data.documents[0].fileName === 'contract.pdf', 'Mary sees her document')
    check(!JSON.stringify(ls.data).includes('fileKey') && ls.data.storageReady === true, 'the storage key is never shown')
    const dl = await call('GET', `/employees/${maryId}/documents/${docId}/download`, mary)
    check(dl.status === 200 && /^memory:\/\//.test(dl.data?.url ?? ''), `she gets a short-lived download link (${short(dl).slice(0, 100)})`)
    check((await call('GET', `/employees/${maryId}/documents`, paul)).status >= 400, "Paul cannot list Mary's documents")
    check((await call('GET', `/employees/${maryId}/documents/${docId}/download`, paul)).status >= 400, "or download them")
    check((await call('DELETE', `/employees/${maryId}/documents/${docId}`, mary)).status >= 400, 'Mary cannot delete a document HR filed')
    check((await call('DELETE', `/employees/${maryId}/documents/${docId}`, owner)).status === 200, 'HR deletes it')
    check((await call('GET', `/employees/${maryId}/documents`, owner)).data.documents.length === 0, 'it is gone from the list')

    // ── notification preferences and web push
    const pk = await call('GET', '/notifications/push/key', mary)
    check(pk.status === 200 && pk.data.key && pk.data.key === process.env.VAPID_PUBLIC_KEY, 'the server hands out the public push key')
    const pf = await call('GET', '/notifications/preferences', mary)
    check(pf.status === 200 && pf.data.channels.push === true && pf.data.categories.length >= 5 && pf.data.devices === 0, `preferences list the categories and channels (${short(pf).slice(0, 100)})`)
    check((await call('POST', '/notifications/push/subscribe', mary, { endpoint: 'http://push.example.com/x', keys: { p256dh: 'A'.repeat(20), auth: 'B'.repeat(12) } })).status === 400, 'an http push endpoint is refused')
    const sub = await call('POST', '/notifications/push/subscribe', mary, { endpoint: 'https://fcm.googleapis.com/fcm/send/test-' + stamp, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } })
    check(sub.status === 201, `Mary subscribes this device (${short(sub).slice(0, 100)})`)
    check((await call('POST', '/notifications/push/subscribe', mary, { endpoint: 'https://fcm.googleapis.com/fcm/send/test-' + stamp, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } })).status === 201, 'subscribing again from the same device does not duplicate it')
    check((await call('GET', '/notifications/preferences', mary)).data.devices === 1, 'one device is counted')
    check((await call('GET', '/notifications/preferences', paul)).data.devices === 0, "and Paul does not see Mary's device")
    const offPeople = await call('PUT', '/notifications/preferences', mary, { prefs: { people: { push: false, email: false }, pay: { email: false } } })
    check(offPeople.status === 200, 'Mary switches off push and email for People and records')
    const pf2 = await call('GET', '/notifications/preferences', mary)
    const cat = (k) => pf2.data.categories.find((c) => c.key === k)
    check(cat('people').push === false && cat('people').email === false, 'her choice is saved')
    check(cat('policies').email === true && cat('policies').push === true, 'a mandatory category cannot be switched off')
    check((await call('PUT', '/notifications/preferences', mary, { prefs: { nonsense: { push: false } } })).status === 400, 'an unknown category is refused')
    check((await call('POST', '/notifications/push/unsubscribe', mary, { endpoint: 'https://fcm.googleapis.com/fcm/send/test-' + stamp })).status === 200, 'Mary removes the device')
    check((await call('GET', '/notifications/preferences', mary)).data.devices === 0, 'no devices left')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('push_subscriptions').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

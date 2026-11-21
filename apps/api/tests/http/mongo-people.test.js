// Employee record and onboarding requests on the MongoDB API: the record (education, family, emergency contacts, identities that are stored
// encrypted and revealed only on request), form settings and custom fields, and onboarding requests that the person fills in and HR reviews.
// Removes its company at the end.
//   API=http://localhost:4216 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-people.test.js
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
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`

;(async () => {
  const stamp = Date.now(), email = `pp${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `People Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])

    const ms = (await call('GET', '/masters', owner)).data
    const code = (key, pick) => { const l = Array.isArray(ms) ? ms.find((x) => x.key === key) : ms[key] ?? ms.lists?.find((x) => x.key === key); const vals = Array.isArray(l) ? l : l?.values ?? []; return (vals.find((v) => v.code === pick) ?? vals[0])?.code }
    // ── the record
    const rec = await call('GET', `/employees/${maryId}/record`, mary)
    check(rec.status === 200, `Mary opens her record (${short(rec).slice(0, 100)})`)
    check((await call('GET', `/employees/${maryId}/record`, paul)).status >= 400, "Paul cannot open Mary's record")
    check((await call('GET', `/employees/${maryId}/record`, owner)).status === 200, 'HR opens it')
    const ed = await call('POST', `/employees/${maryId}/record/education`, mary, { qualification: code('qualification', 'degree'), institute: 'University of Zambia', specialisation: 'Accounting', startYear: 2015, endYear: 2019 })
    check(ed.status === 201 || ed.status === 403, `an education entry (${short(ed).slice(0, 120)})`)
    const fam = await call('POST', `/employees/${maryId}/record/emergencyContacts`, owner, { name: 'Peter Banda', relationship: code('relationship', 'spouse'), phone: '0977123456', priority: 1 })
    check(fam.status === 201, `HR adds an emergency contact (${short(fam).slice(0, 120)})`)
    const fam2 = await call('POST', `/employees/${maryId}/record/family`, owner, { name: 'Ana Banda', relationship: code('relationship', 'child'), dateOfBirth: '2018-05-01' })
    check(fam2.status === 201, `and a family member (${short(fam2).slice(0, 120)})`)
    check((await call('PATCH', `/employees/${maryId}/record/family/${fam2.data?.id}`, owner, { profession: 'Student' })).status === 200, 'edits it')
    check((await call('DELETE', `/employees/${maryId}/record/family/${fam2.data?.id}`, owner)).status === 200, 'removes it')
    check((await call('PATCH', `/employees/${maryId}/record`, owner, { values: { bloodGroup: 'O+' } })).status < 500, 'edits scalar fields of the record')

    // ── identities are encrypted
    const idn = await call('POST', `/employees/${maryId}/identities`, owner, { documentType: code('identity_document', 'nrc'), number: '123456/10/1', issuingCountry: 'ZM' })
    check(idn.status === 201, `HR records an NRC (${short(idn).slice(0, 120)})`)
    check(!JSON.stringify(idn.data).includes('123456/10/1'), 'the number is not returned in the clear')
    const stored = await db.collection('employee_identities').findOne({ employeeId: maryId })
    check(stored && !JSON.stringify(stored).includes('123456/10/1'), 'and it is not stored in the clear')
    const rv = await call('POST', `/employees/${maryId}/identities/${idn.data?.id}/reveal`, owner, {})
    check(rv.status === 200 && JSON.stringify(rv.data).includes('123456/10/1'), `an authorised reveal returns it (${short(rv).slice(0, 100)})`)
    check((await call('POST', `/employees/${maryId}/identities/${idn.data?.id}/reveal`, paul, {})).status >= 400, 'Paul cannot reveal it')

    // ── form settings and custom fields
    check((await call('GET', '/employees/form-settings', mary)).status === 200, 'form settings are readable')
    check((await call('PUT', '/employees/form-settings', mary, { fields: [{ field: 'bloodGroup', mode: 'mandatory', employeeCanEdit: true }] })).status === 403, 'an employee cannot change them')
    check((await call('PUT', '/employees/form-settings', owner, { fields: [{ field: 'bloodGroup', mode: 'mandatory', employeeCanEdit: true }] })).status === 200, 'HR changes them')
    const cf = await call('POST', '/employees/custom-fields', owner, { label: 'T-shirt size', section: 'custom', type: 'list', options: [{ code: 'S', label: 'Small' }, { code: 'M', label: 'Medium' }] })
    check(cf.status === 201, `HR adds a custom field (${short(cf).slice(0, 120)})`)
    check((await call('POST', '/employees/rehire-check', owner, { firstName: 'Mary', lastName: 'Banda' })).status === 200, 'the rehire check answers')

    // ── onboarding requests
    check((await call('POST', '/profile-requests', mary, { employeeIds: [maryId], sections: ['personal'], kind: 'update' })).status === 403, 'an employee cannot raise a request')
    const rq = await call('POST', '/profile-requests', owner, { employeeIds: [paulId], sections: ['emergencyContacts', 'education'], kind: 'onboarding', note: 'Please fill these in' })
    check(rq.status === 201, `HR sends Paul an onboarding request (${short(rq).slice(0, 140)})`)
    const reqId = (await call('GET', '/profile-requests?status=open', owner)).data?.[0]?.id
    check((await call('GET', '/profile-requests?mine=1', paul)).status === 200, 'Paul sees it')
    check((await call('GET', `/profile-requests/${reqId}`, mary)).status >= 400, "Mary cannot open Paul's request")
    check((await call('POST', `/employees/${paulId}/record/emergencyContacts`, paul, { name: 'Joy Mwale', relationship: code('relationship', 'sister'), phone: '0966111222' })).status < 500, 'Paul fills in a section')
    const sub = await call('POST', `/profile-requests/${reqId}/sections/emergencyContacts/submit`, paul, {})
    check(sub.status === 200, `and submits it (${short(sub).slice(0, 120)})`)
    check((await call('POST', `/profile-requests/${reqId}/sections/emergencyContacts/review`, paul, { accept: true })).status >= 400, 'he cannot review his own section')
    check((await call('POST', `/profile-requests/${reqId}/sections/emergencyContacts/review`, owner, { accept: false, note: 'Add a second contact' })).status === 200, 'HR sends the section back with a note')
    check((await call('GET', '/profile-requests?status=open', owner)).status === 200, 'HR lists open requests')
    check((await call('POST', `/profile-requests/${reqId}/cancel`, owner, {})).status === 200, 'HR cancels the request')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      const ids = emps.map((e) => e._id)
      for (const c of ['leave_balances', 'employee_identities', 'employee_addresses', 'employee_family_members', 'employee_emergency_contacts', 'employee_educations', 'employee_previous_employments']) await db.collection(c).deleteMany({ employeeId: { $in: ids } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

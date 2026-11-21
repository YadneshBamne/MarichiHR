// Probation confirmation on the MongoDB API: plan gating, who may review and decide, outcomes (confirm, extend, not confirm),
// and what the employee can see. Needs the API running in MongoDB mode. Removes its company from Atlas at the end.
//   API=http://localhost:4201 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/confirmation.test.js
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
const isoIn = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10)

;(async () => {
  const stamp = Date.now(), email = `cf${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Confirm Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2026-08-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), danielId = await mk('Daniel', 'Zulu'), paulId = await mk('Paul', 'Mwale'), zoeId = await mk('Zoe', 'Phiri')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const daniel = await login(owner, danielId, `daniel${stamp}@example.com`, ['manager'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['manager'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danielId, probationEndDate: new Date(`${isoIn(10)}T00:00:00Z`) } })
    await db.collection('employees').updateOne({ _id: zoeId }, { $set: { probationEndDate: new Date(`${isoIn(200)}T00:00:00Z`) } })

    check((await call('GET', '/confirmation/due', owner)).status === 200, 'Confirmation is in the Growth plan')
    const due = await call('GET', '/confirmation/due', owner)
    check(due.data.length === 1 && due.data[0].name === 'Mary Banda' && due.data[0].daysLeft >= 9 && due.data[0].daysLeft <= 11, 'only Mary is due (Zoe is 200 days away)')
    check((await call('GET', '/confirmation/due', daniel)).status === 403, 'a manager cannot list who is due')
    check((await call('POST', '/confirmation/cases', owner, { employeeId: zoeId })).status === 201, 'HR can still open a review early')
    check((await call('POST', '/confirmation/cases', owner, { employeeId: paulId })).status === 400, 'no probation end date: 400')
    check((await call('POST', '/confirmation/cases', daniel, { employeeId: maryId })).status === 403, 'a manager cannot open a review')
    const open = await call('POST', '/confirmation/cases', owner, { employeeId: maryId })
    check(open.status === 201 && open.data.status === 'manager_review', 'review opened, waiting for the manager')
    const cid = open.data.id
    check((await call('POST', '/confirmation/cases', owner, { employeeId: maryId })).status === 409, 'a second open review is refused')
    check((await call('GET', `/confirmation/cases/${cid}`, paul)).status === 404, 'another manager cannot see it (404)')
    const mine = await call('GET', `/confirmation/cases/${cid}`, mary)
    check(mine.status === 200 && mine.data.status === 'in_review' && !mine.data.review, 'Mary sees only that she is in review')
    check((await call('POST', `/confirmation/cases/${cid}/review`, mary, { rating: 5, strengths: 'great', recommendation: 'confirm' })).status === 403, 'Mary cannot review herself')
    check((await call('POST', `/confirmation/cases/${cid}/review`, owner, { rating: 4, strengths: 'good work', recommendation: 'confirm' })).status === 403, 'HR is not the reviewer either')
    check((await call('POST', `/confirmation/cases/${cid}/decide`, owner, { outcome: 'confirmed' })).status === 409, 'HR cannot decide before the manager has reviewed')
    check((await call('POST', `/confirmation/cases/${cid}/review`, daniel, { rating: 3, strengths: 'learning fast', recommendation: 'extend' })).status === 400, 'an extend recommendation needs months and concerns')
    const rv = await call('POST', `/confirmation/cases/${cid}/review`, daniel, { rating: 3, strengths: 'learning fast', concerns: 'needs more product knowledge', recommendation: 'extend', extensionMonths: 3 })
    check(rv.status === 200 && rv.data.status === 'hr_decision' && rv.data.review.rating === 3, 'Daniel reviews: recommends a 3 month extension')
    check((await call('POST', `/confirmation/cases/${cid}/review`, daniel, { rating: 5, strengths: 'again', recommendation: 'confirm' })).status === 409, 'a review cannot be redone')
    check((await call('POST', `/confirmation/cases/${cid}/decide`, daniel, { outcome: 'confirmed' })).status === 403, 'the manager cannot make the final call')
    check((await call('POST', `/confirmation/cases/${cid}/decide`, owner, { outcome: 'extended', note: 'agree' })).status === 400, 'extending needs a new end date')
    check((await call('POST', `/confirmation/cases/${cid}/decide`, owner, { outcome: 'extended', note: 'agree', newEndDate: isoIn(5) })).status === 400, 'the new end date must be later than the current one')
    const ext = await call('POST', `/confirmation/cases/${cid}/decide`, owner, { outcome: 'extended', note: 'Agree with Daniel', newEndDate: isoIn(100) })
    check(ext.status === 200 && ext.data.status === 'closed' && ext.data.decision.outcome === 'extended', 'HR extends the probation')
    const after = await db.collection('employees').findOne({ _id: maryId })
    check(after.probationEndDate.toISOString().slice(0, 10) === isoIn(100) && !after.confirmationDate, 'Mary\'s probation end date moved, still not confirmed')
    const seen = await call('GET', `/confirmation/cases/${cid}`, mary)
    check(!seen.data.review && seen.data.decision.outcome === 'extended' && !seen.data.decision.note, 'Mary sees the outcome but neither the review nor HR\'s note')
    check((await call('POST', `/confirmation/cases/${cid}/decide`, owner, { outcome: 'confirmed' })).status === 409, 'a closed review cannot be decided again')

    // second round: confirmed
    const c2 = (await call('POST', '/confirmation/cases', owner, { employeeId: maryId })).data.id
    await call('POST', `/confirmation/cases/${c2}/review`, daniel, { rating: 5, strengths: 'excellent', recommendation: 'confirm' })
    const cf = await call('POST', `/confirmation/cases/${c2}/decide`, owner, { outcome: 'confirmed' })
    check(cf.status === 200 && cf.data.decision.outcome === 'confirmed', 'HR confirms Mary')
    check((await db.collection('employees').findOne({ _id: maryId })).confirmationDate, 'her confirmation date is set')
    check((await call('POST', '/confirmation/cases', owner, { employeeId: maryId })).status === 409, 'a confirmed person cannot be reviewed again')
    check((await call('GET', '/confirmation/due', owner)).data.length === 0, 'nobody is due any more')

    // a person with no manager goes straight to HR; HR cannot decide their own case; not-confirmed needs a reason and says what next
    await db.collection('employees').updateOne({ _id: paulId }, { $set: { probationEndDate: new Date(`${isoIn(3)}T00:00:00Z`) } })
    const pc = await call('POST', '/confirmation/cases', owner, { employeeId: paulId })
    check(pc.data.status === 'hr_decision', 'no manager: straight to HR')
    check((await call('POST', `/confirmation/cases/${pc.data.id}/decide`, owner, { outcome: 'not_confirmed' })).status === 400, 'not confirming needs a reason')
    const nc = await call('POST', `/confirmation/cases/${pc.data.id}/decide`, owner, { outcome: 'not_confirmed', note: 'Not a fit' })
    check(nc.status === 200 && /exit/i.test(nc.data.nextStep), 'not confirmed: HR is told to start an exit')
    const own = await db.collection('employees').findOne({ tenantId, userId: su.data.user.id })
    await db.collection('employees').updateOne({ _id: own._id }, { $set: { probationEndDate: new Date(`${isoIn(5)}T00:00:00Z`) } })
    check((await call('POST', '/confirmation/cases', owner, { employeeId: own._id })).status === 403, 'HR cannot open or decide their own confirmation')
    const list = await call('GET', '/confirmation/cases', daniel)
    check(list.data.every((c) => c.employeeId === maryId), 'a manager lists only their team\'s reviews')
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

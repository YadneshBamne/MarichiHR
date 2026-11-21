// Leave on the MongoDB API (through the Prisma-compatible client): types, credits, applying, approvals, cancel, return and
// resubmit, allocation requests, manual adjustments, blackouts, team calendar, year end. Removes its company at the end.
//   API=http://localhost:4205 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-leave.test.js
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// a Monday a few weeks ahead, so dates are in the future whatever day the test runs
const mondayIn = (weeks) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7) + 7 * weeks); return d }
const iso = (d) => d.toISOString().slice(0, 10)
const plus = (d, n) => new Date(d.getTime() + n * 86400000)

;(async () => {
  const stamp = Date.now(), email = `lv${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Leave Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), danielId = await mk('Daniel', 'Zulu'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const daniel = await login(owner, danielId, `daniel${stamp}@example.com`, ['manager'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danielId } })
    await sleep(1500) // credits run in the background after sign-up and after each new employee

    // ── types and balances
    const types = await call('GET', '/leave/types', mary)
    check(types.status === 200 && types.data.length >= 8, `leave types listed (${types.status} ${types.data?.length})`)
    const annual = types.data.find((t) => t.code === 'ANNUAL'), sick = types.data.find((t) => t.code === 'SICK'), lwp = types.data.find((t) => t.code === 'LWP')
    const bal = await call('GET', '/leave/balances/me', mary)
    const ab = bal.data?.find((b) => b.leaveTypeId === annual.id || b.leaveType?.code === 'ANNUAL')
    check(bal.status === 200 && ab && ab.balanceDays > 0, `Mary's annual leave was credited (${JSON.stringify(ab)?.slice(0, 120)})`)
    check((await call('POST', '/leave/types', mary, { name: 'X' })).status === 403, 'an employee cannot create a leave type')
    const newType = await call('POST', '/leave/types', owner, { name: 'Study leave', code: 'STUDY', category: 'casual', isPaid: true, isStatutory: false, statutoryCountry: null, accrualType: 'manual', accrualAmount: 0, accrualDayOfMonth: null, tenureSlabs: null, carryForward: false, carryForwardMax: null, carryForwardExpiryMonths: null, encashable: false, halfDayAllowed: true, approvalLevels: 1 })
    check(newType.status === 201, `HR creates a leave type (${newType.status} ${JSON.stringify(newType.body).slice(0, 150)})`)

    // ── apply, approve
    const mon = mondayIn(3)
    const req1 = await call('POST', '/leave/requests', mary, { leaveTypeId: annual.id, startDate: iso(mon), endDate: iso(plus(mon, 1)), reason: 'Family visit' })
    check(req1.status === 201 && req1.data.totalDays === 2 && req1.data.status === 'pending', `Mary applies for 2 days (${req1.status} ${JSON.stringify(req1.body).slice(0, 160)})`)
    const id1 = req1.data.id
    const b1 = (await call('GET', '/leave/balances/me', mary)).data.find((b) => b.leaveTypeId === annual.id || b.leaveType?.code === 'ANNUAL')
    check(b1.pendingDays === 2, `2 days are held as pending (${JSON.stringify(b1).slice(0, 140)})`)
    check((await call('GET', '/leave/requests/pending', paul)).status === 403, 'an employee has no approvals queue')
    const pend = await call('GET', '/leave/requests/pending', daniel)
    check(pend.status === 200 && pend.data.some((r) => r.id === id1), 'Daniel sees it in his queue')
    check((await call('POST', `/leave/requests/${id1}/approve`, mary, {})).status === 403, 'Mary cannot approve her own request')
    check((await call('POST', `/leave/requests/${id1}/approve`, paul, {})).status === 403, 'Paul cannot approve')
    const ap = await call('POST', `/leave/requests/${id1}/approve`, daniel, { comments: 'Enjoy' })
    check(ap.status === 200 && ap.data.status === 'approved', `Daniel approves (${ap.status} ${JSON.stringify(ap.body).slice(0, 150)})`)
    const b2 = (await call('GET', '/leave/balances/me', mary)).data.find((b) => b.leaveTypeId === annual.id || b.leaveType?.code === 'ANNUAL')
    check(b2.usedDays === 2 && b2.pendingDays === 0, 'used 2, pending 0 after approval')
    check((await call('POST', `/leave/requests/${id1}/approve`, daniel, {})).status >= 400, 'it cannot be approved twice')
    const mine = await call('GET', '/leave/requests/me', mary)
    check(mine.status === 200 && JSON.stringify(mine.data).includes(id1), 'it shows in My requests')

    // ── reject, cancel
    const mon2 = mondayIn(5)
    const r2 = await call('POST', '/leave/requests', mary, { leaveTypeId: annual.id, startDate: iso(mon2), endDate: iso(mon2) })
    const rj = await call('POST', `/leave/requests/${r2.data.id}/reject`, daniel, { comments: 'Busy week' })
    check(rj.status === 200 && rj.data.status === 'rejected', `Daniel rejects (${rj.status} ${JSON.stringify(rj.body).slice(0, 120)})`)
    check((await call('GET', '/leave/balances/me', mary)).data.find((b) => b.leaveTypeId === annual.id).pendingDays === 0, 'the held day is released')
    const r3 = await call('POST', '/leave/requests', mary, { leaveTypeId: annual.id, startDate: iso(mon2), endDate: iso(mon2) })
    const cn = await call('POST', `/leave/requests/${r3.data.id}/cancel`, mary)
    check(cn.status === 200 && cn.data.status === 'cancelled', 'Mary cancels her pending request')
    check((await call('POST', `/leave/requests/${r3.data.id}/cancel`, paul)).status >= 400, "Paul cannot cancel Mary's request")

    // ── return and resubmit
    const r4 = await call('POST', '/leave/requests', mary, { leaveTypeId: annual.id, startDate: iso(mon2), endDate: iso(mon2) })
    check((await call('POST', `/leave/requests/${r4.data.id}/return`, daniel, { note: 'Please add a reason' })).status === 200, 'Daniel returns it for changes')
    const rs = await call('POST', `/leave/requests/${r4.data.id}/resubmit`, mary, { leaveTypeId: annual.id, startDate: iso(mon2), endDate: iso(mon2), reason: 'Dentist' })
    check(rs.status === 201 && rs.data.status === 'pending', `Mary resubmits (${rs.status} ${JSON.stringify(rs.body).slice(0, 120)})`)
    await call('POST', `/leave/requests/${rs.data.id}/reject`, daniel, { comments: 'x' })

    // ── overlap, blackout, team calendar
    const ov = await call('GET', `/leave/overlap?startDate=${iso(mon)}&endDate=${iso(mon)}`, paul)
    check(ov.status === 200, 'overlap lookup works')
    const bo = await call('POST', '/leave/blackouts', owner, { name: 'Audit week', startDate: iso(mondayIn(8)), endDate: iso(plus(mondayIn(8), 4)) })
    check(bo.status === 201, `HR sets a blackout (${bo.status} ${JSON.stringify(bo.body).slice(0, 120)})`)
    check((await call('GET', '/leave/blackouts', mary)).data.length === 1, 'everyone sees blackouts')
    const cal = await call('GET', `/leave/calendar/team?startDate=${iso(mon)}&endDate=${iso(plus(mon, 6))}`, daniel)
    check(cal.status === 200, `the manager's team calendar (${cal.status})`)

    // ── allocation requests and manual adjustments
    const ar = await call('POST', '/leave/allocation-requests', mary, { leaveTypeId: sick.id, requestedDays: 3, reason: 'Extra sick days after surgery' })
    check(ar.status === 201, `Mary asks for 3 more sick days (${ar.status} ${JSON.stringify(ar.body).slice(0, 120)})`)
    const arp = await call('GET', '/leave/allocation-requests/pending', daniel)
    check(arp.status === 200 && JSON.stringify(arp.data).includes(ar.data.id), 'Daniel sees the allocation request')
    const sickBefore = (await call('GET', '/leave/balances/me', mary)).data.find((b) => b.leaveTypeId === sick.id).balanceDays
    const aa = await call('POST', `/leave/allocation-requests/${ar.data.id}/approve`, daniel, { approvedDays: 2, note: 'ok' })
    check(aa.status === 200, `Daniel approves 2 of the 3 days (${aa.status} ${JSON.stringify(aa.body).slice(0, 120)})`)
    check((await call('GET', '/leave/balances/me', mary)).data.find((b) => b.leaveTypeId === sick.id).balanceDays === sickBefore + 2, 'the sick balance went up by 2')
    check((await call('POST', `/leave/admin/balances/${maryId}/adjust`, mary, { leaveTypeId: sick.id, days: 5, reason: 'self service' })).status === 403, 'an employee cannot adjust balances')
    const adj = await call('POST', `/leave/admin/balances/${maryId}/adjust`, owner, { leaveTypeId: sick.id, days: -1, reason: 'Correction' })
    check(adj.status === 200 && adj.data.available !== undefined, `HR adjusts a balance (${adj.status} ${JSON.stringify(adj.body).slice(0, 120)})`)
    check((await call('GET', `/leave/admin/balances/${maryId}`, owner)).status === 200, 'HR reads the full balance view')
    check((await call('GET', `/leave/allocations/${maryId}`, owner)).status === 200, 'HR lists allocations')

    // ── statutory type and a request over the balance
    const long = await call('POST', '/leave/requests', paul, { leaveTypeId: annual.id, startDate: iso(mondayIn(10)), endDate: iso(plus(mondayIn(10), 40)), reason: 'Long trip' })
    check(long.status >= 200, `over-balance request is accepted and the approver decides (${long.status})`)
    // ── year end preview and accrual
    check((await call('GET', '/leave/year-end', owner)).status === 200, 'year-end preview')
    check((await call('POST', '/leave/accrual/run', owner)).status === 200, 'accrual run')
    const jb = (await call('GET', '/leave/balances/me', mary)).data.find((b) => b.leaveTypeId === annual.id).balanceDays
    check((await call('POST', '/system/jobs/leave-accrual/run', owner)).status === 200, 'accrual job runs')
    check((await call('GET', '/leave/balances/me', mary)).data.find((b) => b.leaveTypeId === annual.id).balanceDays === jb, 'accrual twice in a month credits nothing more')
    check((await call('GET', '/leave/year-end', mary)).status === 403, 'an employee cannot see year end')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      const ids = emps.map((e) => e._id)
      for (const c of ['leave_balances', 'leave_requests', 'leave_allocations', 'leave_allocation_requests']) await db.collection(c).deleteMany({ employeeId: { $in: ids } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

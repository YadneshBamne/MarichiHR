// Advanced performance management on the MongoDB API: a review cycle with competencies, self and manager appraisal, anonymous 360
// feedback, HR calibration, the rating distribution and 9-box, publishing and acknowledgement, and improvement plans.
// Removes its company at the end.
//   API=http://localhost:4236 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-appraisal.test.js
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
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`

;(async () => {
  const stamp = Date.now(), email = `ap${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Appraisal Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const ownerEmpId = su.data.user.employee?.id ?? (await db.collection('employees').findOne({ tenantId }))._id
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const danId = await mk('Dan', 'Zulu'), maryId = await mk('Mary', 'Banda'), paulId = await mk('Paul', 'Mwale')
    const peerIds = [await mk('Pia', 'One'), await mk('Pete', 'Two'), await mk('Pam', 'Three'), await mk('Pat', 'Four')]
    const dan = await login(owner, danId, `dan${stamp}@example.com`, ['manager'])
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    const peers = []
    for (const [i, pid] of peerIds.entries()) peers.push(await login(owner, pid, `${['pia', 'pete', 'pam', 'pat'][i]}${stamp}@example.com`, ['employee']))
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danId } })
    await db.collection('employees').updateOne({ _id: danId }, { $set: { managerId: ownerEmpId } })

    // ── plan gate and setup
    check((await call('GET', '/appraisal/competencies', owner)).status === 403, 'on the Growth plan the advanced tools are not included')
    await call('PUT', '/company/plan', owner, { plan: 'enterprise', addons: [] })
    const comps = await call('GET', '/appraisal/competencies', owner)
    check(comps.status === 200 && comps.data.length >= 6, `a starter competency framework is there (${comps.data?.length})`)
    check((await call('POST', '/appraisal/competencies', mary, { name: 'Innovation' })).status === 403, 'an employee cannot add competencies')
    const inno = await call('POST', '/appraisal/competencies', owner, { name: 'Innovation', description: 'New ideas that work' })
    check(inno.status === 201 && (await call('POST', '/appraisal/competencies', owner, { name: 'Innovation' })).status === 409, 'HR adds one; a duplicate is 409')
    const cids = [comps.data[0].id, comps.data[1].id, inno.data.id]
    const cyc = { name: 'Annual 2026', startDate: '2026-01-01', endDate: '2026-12-31', scaleMax: 5, goalsWeight: 50, competencyIds: cids, peerReview: true }
    check((await call('POST', '/appraisal/cycles', dan, cyc)).status === 403, 'a manager cannot create a cycle')
    check((await call('POST', '/appraisal/cycles', owner, { ...cyc, endDate: '2025-01-01' })).status === 400, 'a cycle must end after it starts')
    const cr = await call('POST', '/appraisal/cycles', owner, cyc)
    check(cr.status === 201 && cr.data.status === 'draft', 'HR creates the cycle')
    const cid = cr.data.id
    check((await call('POST', '/appraisal/cycles', owner, cyc)).status === 409, 'a duplicate name is refused')
    check((await call('GET', '/appraisal/cycles', mary)).data.length === 0, 'a draft cycle is invisible to employees')

    // ── launch for Mary only
    check((await call('POST', `/appraisal/cycles/${cid}/launch`, dan, {})).status === 403, 'only HR launches')
    const ln = await call('POST', `/appraisal/cycles/${cid}/launch`, owner, { employeeIds: [maryId] })
    check(ln.status === 200 && ln.data.participants === 1, `launched for one person (${short(ln).slice(0, 80)})`)
    check((await call('POST', `/appraisal/cycles/${cid}/launch`, owner, {})).status === 409, 'a cycle launches once')
    const mine = await call('GET', '/appraisal/appraisals?scope=mine', mary)
    check(mine.status === 200 && mine.data.length === 1 && mine.data[0].status === 'pending_self' && mine.data[0].manager === 'Dan Zulu', `Mary has an appraisal waiting, manager Dan (${short(mine).slice(0, 100)})`)
    const aid = mine.data[0].id
    check((await call('GET', `/appraisal/appraisals/${aid}`, paul)).status === 404, "Paul cannot see Mary's appraisal")
    check((await call('GET', '/appraisal/appraisals?scope=all', mary)).status === 403, 'only HR lists everyone')

    // ── self appraisal
    const rate = (n) => Object.fromEntries(cids.map((c) => [c, n]))
    check((await call('POST', `/appraisal/appraisals/${aid}/self`, dan, { ratings: rate(4) })).status === 403, 'only Mary writes her self appraisal')
    check((await call('POST', `/appraisal/appraisals/${aid}/self`, mary, { ratings: { [cids[0]]: 4 } })).status === 400, 'she must rate every competency')
    check((await call('POST', `/appraisal/appraisals/${aid}/self`, mary, { ratings: rate(6) })).status === 400, 'ratings stop at the scale maximum')
    check((await call('POST', `/appraisal/appraisals/${aid}/manager`, dan, { ratings: rate(4), potential: 2, comment: 'Too early' })).status === 400, 'the manager waits for the self appraisal')
    check((await call('POST', `/appraisal/appraisals/${aid}/self`, mary, { ratings: rate(5), comment: 'Strong year' })).status === 200, 'Mary submits her self appraisal')
    check((await call('POST', `/appraisal/appraisals/${aid}/self`, mary, { ratings: rate(5) })).status === 409, 'and cannot send it twice')

    // ── 360 feedback
    check((await call('POST', `/appraisal/appraisals/${aid}/peers`, mary, { employeeIds: [danId] })).status === 400, 'her manager cannot be a peer reviewer')
    check((await call('POST', `/appraisal/appraisals/${aid}/peers`, mary, { employeeIds: peerIds })).status === 201, 'Mary names four peers')
    check((await call('POST', `/appraisal/appraisals/${aid}/peers`, mary, { employeeIds: [paulId, ownerEmpId] })).status === 400, 'more than five in total is refused')
    const fb = await call('GET', '/appraisal/feedback/mine', peers[0])
    check(fb.status === 200 && fb.data.length === 1 && fb.data[0].subject === 'Mary Banda' && fb.data[0].competencies.length === 3, `a peer sees the request (${short(fb).slice(0, 100)})`)
    check((await call('POST', `/appraisal/feedback/${fb.data[0].id}`, peers[0], { ratings: rate(3), comment: 'Reliable' })).status === 200, 'peer 1 answers')
    check((await call('POST', `/appraisal/feedback/${fb.data[0].id}`, peers[0], { ratings: rate(3) })).status === 409, 'and cannot answer twice')
    const mid = await call('GET', `/appraisal/appraisals/${aid}`, dan)
    check(mid.data.peers.answered === 1 && mid.data.peers.averages === null && mid.data.peers.comments.length === 0, 'with fewer than three answers the manager sees no averages or comments (nobody can be identified)')
    for (const [i, p] of [peers[1], peers[2]].entries()) {
      const r = await call('GET', '/appraisal/feedback/mine', p)
      await call('POST', `/appraisal/feedback/${r.data[0].id}`, p, { ratings: rate(4 - i), comment: `Peer comment ${i}` })
    }
    const pm = await call('GET', `/appraisal/appraisals/${aid}`, dan)
    check(pm.data.peers.answered === 3 && pm.data.peers.averages && Object.values(pm.data.peers.averages).every((v) => v >= 2 && v <= 4) && pm.data.peers.comments.length === 3, 'after three answers the manager sees averages and unnamed comments')
    check(!/Pia|Pete|Pam|Pat/.test(JSON.stringify(pm.data.peers)), 'no reviewer name appears anywhere')
    const mm = await call('GET', `/appraisal/appraisals/${aid}`, mary)
    check(mm.data.peers.requested === 4 && mm.data.peers.answered === 3 && !mm.data.peers.averages && !mm.data.peers.comments, 'Mary only sees how many answered')

    // ── a reviewed goal in the cycle feeds the goals half of the score
    await db.collection('performance_goals').insertOne({ _id: crypto.randomUUID(), tenantId, employeeId: maryId, title: 'Close the books', status: 'reviewed', score: 100, reviewedAt: new Date() })

    // ── manager's review
    check((await call('POST', `/appraisal/appraisals/${aid}/manager`, mary, { ratings: rate(5), potential: 3, comment: 'Self-approved' })).status === 403, 'Mary cannot review herself')
    const mr = await call('POST', `/appraisal/appraisals/${aid}/manager`, dan, { ratings: rate(4), potential: 3, comment: 'Dependable, ready for more' })
    check(mr.status === 200 && mr.data.scores.competencyScore === 80 && mr.data.scores.goalScore === 100 && mr.data.scores.computed === 90, `score = half goals (100) + half competencies (80) = 90 (${short(mr).slice(0, 140)})`)
    const hidden = await call('GET', `/appraisal/appraisals/${aid}`, mary)
    check(hidden.data.managerReview === null && hidden.data.finalScore === null && hidden.data.scores === null, "until HR publishes, Mary sees neither the manager's review nor a score")
    const seen = await call('GET', `/appraisal/appraisals/${aid}`, dan)
    check(seen.data.finalScore === 90 && seen.data.rating === 'Meets expectations', 'her manager sees 90, Meets expectations')

    // ── calibration, summary, publishing
    check((await call('POST', `/appraisal/appraisals/${aid}/calibrate`, owner, { finalScore: 95, reason: 'Aligned with peers' })).status === 400, 'calibration waits for the calibration stage')
    check((await call('POST', `/appraisal/cycles/${cid}/status`, dan, { status: 'calibration' })).status === 403, 'a manager cannot move the cycle')
    check((await call('POST', `/appraisal/cycles/${cid}/status`, owner, { status: 'closed' })).status === 400, 'a cycle cannot skip stages')
    check((await call('POST', `/appraisal/cycles/${cid}/status`, owner, { status: 'calibration' })).status === 200, 'HR opens calibration')
    check((await call('POST', `/appraisal/appraisals/${aid}/calibrate`, dan, { finalScore: 95, reason: 'Nudge up' })).status === 403, 'a manager cannot calibrate')
    check((await call('POST', `/appraisal/appraisals/${aid}/calibrate`, owner, { finalScore: 95, reason: 'x' })).status === 400, 'a reason is required')
    check((await call('POST', `/appraisal/appraisals/${aid}/calibrate`, owner, { finalScore: 95, reason: 'Aligned with the rest of the team' })).status === 200, 'HR calibrates to 95 with a reason')
    const sum = await call('GET', `/appraisal/cycles/${cid}/summary`, owner)
    check(sum.status === 200 && sum.data.reviewed === 1 && sum.data.distribution['Meets expectations'] === 1 && JSON.stringify(sum.data.grid['medium:3']) === JSON.stringify(['Mary Banda']), `distribution and 9-box (${short(sum).slice(0, 160)})`)
    check((await call('GET', `/appraisal/cycles/${cid}/summary`, mary)).status === 403, 'an employee cannot see the summary')
    check((await call('GET', `/appraisal/cycles/${cid}/summary`, dan)).data.reviewed === 1, "a manager sees their team's")
    check((await call('POST', `/appraisal/cycles/${cid}/status`, owner, { status: 'published' })).status === 200, 'HR publishes')
    const pub = await call('GET', `/appraisal/appraisals/${aid}`, mary)
    check(pub.data.finalScore === 95 && pub.data.rating === 'Meets expectations' && pub.data.managerReview?.comment === 'Dependable, ready for more' && pub.data.calibration === null, 'now Mary sees the result and her manager review, but not the calibration notes')
    check(pub.data.can.acknowledge === true, 'she can acknowledge it')
    check((await call('POST', `/appraisal/appraisals/${aid}/acknowledge`, dan, {})).status === 403, 'only she can acknowledge')
    check((await call('POST', `/appraisal/appraisals/${aid}/acknowledge`, mary, { comment: 'Thank you' })).status === 200, 'Mary acknowledges')
    check((await call('POST', `/appraisal/appraisals/${aid}/acknowledge`, mary, {})).status === 400, 'once')
    check(JSON.stringify((await call('GET', '/notifications', mary)).body).includes('appraisal.published'), 'she was told when it was published')

    // ── improvement plans
    const plan = { employeeId: maryId, reason: 'Missed two month-end deadlines', endDate: '2027-02-28', objectives: ['Close the books by day 5', 'Weekly check-in with manager'] }
    check((await call('POST', '/appraisal/plans', mary, { ...plan, employeeId: maryId })).status === 403, 'Mary cannot start a plan for herself')
    check((await call('POST', '/appraisal/plans', paul, plan)).status === 404, 'someone outside her reporting line cannot')
    const pl = await call('POST', '/appraisal/plans', dan, plan)
    check(pl.status === 201 && pl.data.objectives.length === 2, `her manager starts a plan (${short(pl).slice(0, 80)})`)
    check((await call('POST', '/appraisal/plans', owner, plan)).status === 409, 'only one active plan at a time')
    const myPlans = await call('GET', '/appraisal/plans?scope=mine', mary)
    check(myPlans.data.length === 1 && myPlans.data[0].status === 'active', 'Mary sees her plan')
    check((await call('POST', `/appraisal/plans/${pl.data.id}/progress`, mary, { objectiveId: pl.data.objectives[0].id, done: true })).status === 403, 'she cannot tick her own objectives')
    check((await call('POST', `/appraisal/plans/${pl.data.id}/progress`, mary, { note: 'Started the weekly check-ins' })).status === 200, 'but she can add a note')
    check((await call('POST', `/appraisal/plans/${pl.data.id}/progress`, dan, { objectiveId: pl.data.objectives[0].id, done: true, note: 'First close on day 4' })).status === 200, 'her manager ticks an objective')
    check((await call('POST', `/appraisal/plans/${pl.data.id}/close`, mary, { outcome: 'successful', note: 'done' })).status === 404, 'she cannot close it')
    check((await call('POST', `/appraisal/plans/${pl.data.id}/close`, dan, { outcome: 'extended', note: 'More time' })).status === 400, 'an extension needs a new end date')
    check((await call('POST', `/appraisal/plans/${pl.data.id}/close`, dan, { outcome: 'successful', note: 'Objectives met' })).data?.status === 'closed', 'her manager closes it as successful')
    check((await call('POST', `/appraisal/plans/${pl.data.id}/progress`, dan, { note: 'late' })).status === 400, 'a closed plan takes no more changes')
    check((await call('GET', '/appraisal/plans?scope=all', owner)).data.length === 1, 'HR sees all plans')
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

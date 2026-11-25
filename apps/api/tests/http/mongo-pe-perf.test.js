// People fixes J to S on the MongoDB API: performance goals (drafts hidden, withdraw, reopen, progress, deadlines, reminders, system admin as HR, picker),
// appraisals (linked goal cycles, rating scale, own-appraisal rule, remove / late joiner / skip self, idempotent launch, recomputed scores, 360 rules and
// moderation, improvement plans), and confirmations (notifications, reminders, reassign, cancel, review on behalf, early confirmation, letters).
// Removes its company at the end. Start the API with STORAGE_PROVIDER=memory, then:
//   API=http://localhost:4272 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-pe-perf.test.js
process.env.STORAGE_PROVIDER = 'memory'
const mongoose = require('mongoose')
const API = (process.env.API || 'http://localhost:4200') + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data, code: json.code, message: json.message ?? '' }
}
async function raw(path, token) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } })
  const bytes = Buffer.from(await res.arrayBuffer())
  return { status: res.status, type: res.headers.get('content-type') ?? '', bytes }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const ymd = (d) => d.toISOString().slice(0, 10)
const inDays = (n) => ymd(new Date(Date.now() + n * 86400000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const stamp = Date.now(), email = `pe${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `PE Perf ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    const ownerEmp = (await db.collection('employees').findOne({ tenantId, userId: su.data.user.id }))._id
    await call('PUT', '/company/plan', owner, { plan: 'enterprise', addons: [] })
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const ids = {}
    for (const [n, w] of [['Dan', 'Zulu'], ['Meg', 'Phiri'], ['Mary', 'Banda'], ['Paul', 'Mwale'], ['Eve', 'Tembo'], ['Hugh', 'Second'], ['Sam', 'Admin'], ['Tom', 'Probation'], ['Ann', 'Soon'], ['Bob', 'Later'], ['Pia', 'One'], ['Pete', 'Two'], ['Pam', 'Three'], ['Pat', 'Four'], ['Pru', 'Five']]) ids[n.toLowerCase()] = await mk(n, w)
    const tok = {}
    for (const [n, roles] of [['dan', ['manager']], ['meg', ['manager']], ['mary', ['employee']], ['paul', ['employee']], ['eve', ['employee']], ['hugh', ['hr_admin']], ['sam', ['system_admin']], ['tom', ['employee']], ['pia', ['employee']], ['pete', ['employee']], ['pam', ['employee']], ['pat', ['employee']], ['pru', ['employee']]]) tok[n] = await login(owner, ids[n], `${n}${stamp}@example.com`, roles)
    const E = db.collection('employees')
    await E.updateMany({ _id: { $in: [ids.mary, ids.tom, ids.ann, ids.bob] } }, { $set: { managerId: ids.dan } })
    await E.updateOne({ _id: ids.dan }, { $set: { managerId: ownerEmp } })
    const uid = async (n) => (await E.findOne({ _id: ids[n] })).userId
    const count = async (n, type) => db.collection('notifications').countDocuments({ userId: await uid(n), type })
    const runJob = (name) => call('POST', `/system/jobs/${name}/run`, owner)

    // ═══════════ J. GOALS ═══════════
    check((await call('POST', '/performance/cycles/this-year', owner)).status === 201, 'HR adds this year\'s cycles')
    const cyc = (await call('GET', '/performance/cycles', owner)).data
    const year = cyc.find((c) => /^Year /.test(c.name))
    for (const q of cyc.filter((c) => /^Q\d /.test(c.name))) await call('POST', `/performance/cycles/${q.id}/status`, owner, { status: 'closed' })
    const kpi = [{ name: 'Revenue', target: 100, weight: 100 }]
    const goal = (extra = {}) => call('POST', '/performance/goals', tok.dan, { cycleId: year.id, employeeId: ids.mary, title: 'Close the books', kpis: kpi, ...extra })
    check((await call('POST', '/performance/goals', owner, { cycleId: year.id, employeeId: ownerEmp, title: 'My own goal', kpis: kpi })).status === 403, 'HR cannot set a goal for their own record')
    check(/yourself/.test((await call('POST', '/performance/goals', owner, { cycleId: year.id, employeeId: ownerEmp, title: 'My own goal', kpis: kpi })).message), 'and is told why')
    check((await goal({ deadline: inDays(-1) })).status === 400, 'a deadline in the past is refused')
    const g1 = await goal({ deadline: inDays(5) })
    check(g1.status === 201, `a manager sets a draft goal with a deadline (${g1.status})`)
    check((await call('GET', '/performance/goals?scope=mine', tok.mary)).data.length === 0, 'the unsent draft is invisible to the employee')
    check((await call('GET', '/performance/goals?scope=team', tok.dan)).data.some((g) => g.id === g1.data.id && g.deadline === inDays(5)), 'the manager sees it with the deadline')
    const pk = await call('GET', '/performance/people?q=mary', tok.dan)
    check(pk.status === 200 && pk.data.length === 1 && pk.data[0].name === 'Mary Banda', 'the picker finds people in the manager\'s team')
    check(!(await call('GET', '/performance/people?q=paul', tok.dan)).data.length, 'but not people outside it')
    check((await call('GET', '/performance/people?q=hana', owner)).data.length === 0, 'HR\'s picker never lists HR themselves')
    check((await call('GET', '/performance/people?q=pa', owner)).data.some((p) => p.name === 'Paul Mwale'), 'HR\'s picker finds anyone else')
    check((await call('GET', '/performance/people?q=x', tok.mary)).data.length === 0, 'an employee gets an empty picker')
    check((await call('POST', `/performance/goals/${g1.data.id}/send`, tok.dan)).status === 200 && (await call('GET', '/performance/goals?scope=mine', tok.mary)).data.length === 1, 'once sent, the employee sees it')
    // withdraw: no reason needed before acceptance
    check((await call('POST', `/performance/goals/${g1.data.id}/withdraw`, tok.paul, {})).status === 404, 'someone outside the line cannot even see it')
    check((await call('POST', `/performance/goals/${g1.data.id}/withdraw`, tok.mary, {})).status === 403, 'the employee cannot withdraw their own goal')
    check((await call('POST', `/performance/goals/${g1.data.id}/withdraw`, tok.dan, {})).data?.status === 'withdrawn', 'the manager withdraws a sent goal before it is accepted, no reason needed')
    check(await count('mary', 'performance.goal.withdrawn') === 1, 'the employee is told')
    check((await call('POST', `/performance/goals/${g1.data.id}/withdraw`, tok.dan, {})).status === 409, 'a goal is withdrawn once')
    // after acceptance a reason is needed
    const g2 = await goal({ title: 'Second goal' }); await call('POST', `/performance/goals/${g2.data.id}/send`, tok.dan); await call('POST', `/performance/goals/${g2.data.id}/accept`, tok.mary)
    check((await call('POST', `/performance/goals/${g2.data.id}/withdraw`, tok.dan, {})).status === 400, 'an accepted goal needs a reason to withdraw')
    check((await call('POST', `/performance/goals/${g2.data.id}/withdraw`, tok.dan, { reason: 'Priorities changed' })).status === 200 && await count('mary', 'performance.goal.withdrawn') === 2, 'with a reason it is withdrawn and the employee told')
    // progress
    const g3 = await goal({ title: 'Third goal', deadline: inDays(2) })
    await call('POST', `/performance/goals/${g3.data.id}/send`, tok.dan)
    check((await call('POST', `/performance/goals/${g3.data.id}/progress`, tok.mary, { percent: 10 })).status === 400, 'progress needs an accepted goal')
    await call('POST', `/performance/goals/${g3.data.id}/accept`, tok.mary)
    check((await call('POST', `/performance/goals/${g3.data.id}/progress`, tok.mary, { percent: 140 })).status === 400, 'progress above 100 is refused')
    check((await call('POST', `/performance/goals/${g3.data.id}/progress`, tok.dan, { percent: 50 })).status === 403, 'the manager cannot report the person\'s progress')
    check((await call('POST', `/performance/goals/${g3.data.id}/progress`, tok.mary, { percent: 40, note: 'Half the invoices done' })).data?.progress === 40, 'the employee reports 40%')
    check(await count('dan', 'performance.goal.progress') === 1, 'the manager is told')
    const mine = (await call('GET', '/performance/goals?scope=mine', tok.mary)).data.find((g) => g.id === g3.data.id)
    check(mine.progress === 40 && mine.progressLog.length === 1 && mine.progressLog[0].note === 'Half the invoices done', 'the progress and its history are on the goal')
    // reminders
    check((await runJob('goal-reminders')).status === 200 && await count('mary', 'performance.goal.due') === 1, 'a deadline within 3 days is reminded')
    await runJob('goal-reminders')
    check(await count('mary', 'performance.goal.due') === 1, 'and only once a day')
    await db.collection('performance_goal_meta').updateOne({ _id: g3.data.id }, { $set: { deadline: inDays(-2) } })
    await runJob('goal-reminders')
    check(await count('mary', 'performance.goal.overdue') === 1 && await count('dan', 'performance.goal.overdue') === 1, 'an overdue goal reminds the person and the manager')
    const g4 = await goal({ title: 'Waiting goal' }); await call('POST', `/performance/goals/${g4.data.id}/send`, tok.dan)
    await db.collection('performance_goals').updateOne({ _id: g4.data.id }, { $set: { sentAt: new Date(Date.now() - 4 * 86400000) } })
    await runJob('goal-reminders')
    check(await count('mary', 'performance.goal.unaccepted') === 1, 'a goal unaccepted for 3 days reminds the person')
    // review, closed cycle, reopen
    const kid = g3.data.kpis[0].id
    await call('POST', `/performance/cycles/${year.id}/status`, owner, { status: 'closed' })
    const rc = await call('POST', `/performance/goals/${g3.data.id}/review`, tok.dan, { achieved: { [kid]: 60 } })
    check(rc.status === 400 && /closed/.test(rc.message), 'reviewing in a closed cycle is refused with a clear message')
    await call('POST', `/performance/cycles/${year.id}/status`, owner, { status: 'open' })
    check((await call('POST', `/performance/goals/${g3.data.id}/review`, tok.dan, { achieved: { [kid]: 60 } })).data?.score === 60, 'in an open cycle the manager reviews (60%)')
    check((await call('POST', `/performance/goals/${g3.data.id}/reopen`, tok.dan, { reason: 'Please look again' })).status === 403, 'only HR reopens a review')
    check((await call('POST', `/performance/goals/${g3.data.id}/reopen`, owner, { reason: 'x' })).status === 400, 'reopening needs a proper reason')
    check((await call('POST', `/performance/goals/${g3.data.id}/reopen`, owner, { reason: 'The achieved figure was wrong' })).data?.status === 'accepted', 'HR reopens the reviewed goal')
    check(await count('mary', 'performance.goal.reopened') === 1 && await count('dan', 'performance.goal.reopened') === 1, 'both sides are told')
    check((await call('POST', `/performance/goals/${g3.data.id}/reopen`, owner, { reason: 'Again please' })).status === 400, 'only a reviewed goal can be reopened')
    const hist = (await call('GET', '/performance/goals?scope=team', tok.dan)).data.find((g) => g.id === g3.data.id)
    check(hist.history.some((h) => h.action === 'review reopened'), 'the history keeps it')
    // system admin counts as HR
    check((await call('GET', '/performance/goals?scope=all', tok.sam)).status === 200, 'a system admin sees every goal like HR does')
    check((await call('POST', '/performance/goals', tok.sam, { cycleId: year.id, employeeId: ids.paul, title: 'By the system admin', kpis: kpi })).status === 201, 'and can set goals for people')

    // ═══════════ K-Q. APPRAISALS ═══════════
    const comps = (await call('GET', '/appraisal/competencies', owner)).data
    const cids = comps.slice(0, 3).map((c) => c.id)
    const cyBody = { startDate: '2026-01-01', endDate: '2026-12-31', scaleMax: 5, goalsWeight: 50, competencyIds: cids, peerReview: true }
    for (const q of (await call('GET', '/performance/cycles', owner)).data.filter((c) => c.id !== year.id)) await call('POST', `/performance/cycles/${q.id}/status`, owner, { status: 'closed' })
    const dflt = await call('POST', '/appraisal/cycles', owner, { ...cyBody, name: 'Default link' })
    check(dflt.status === 201 && dflt.data.goalCycleId === year.id, 'with exactly one open goal cycle, a review cycle counts its goals by default')
    check((await call('POST', '/appraisal/cycles', owner, { ...cyBody, name: 'Bad link', goalCycleId: '00000000-0000-4000-8000-000000000000' })).status === 404, 'an unknown goal cycle is refused')
    check((await call('GET', '/appraisal/goal-cycles', owner)).data.some((c) => c.id === year.id), 'the screen can list goal cycles')
    const cr = await call('POST', '/appraisal/cycles', owner, { ...cyBody, name: 'Annual 2026 review', goalCycleId: year.id })
    check(cr.status === 201 && cr.data.goalCycleId === year.id, 'HR links the review cycle to a goal cycle')
    const cid = cr.data.id
    // idempotent launch
    const who = [ids.mary, ids.paul, ids.eve, ids.dan, ownerEmp]
    const both = await Promise.all([call('POST', `/appraisal/cycles/${cid}/launch`, owner, { employeeIds: who }), call('POST', `/appraisal/cycles/${cid}/launch`, owner, { employeeIds: who })])
    check(both.map((r) => r.status).sort().join() === '200,409', `two quick launches: one 200 and one clean 409 (${both.map((r) => r.status)})`)
    check(await db.collection('appraisals').countDocuments({ cycleId: cid }) === 5, 'five appraisals, no duplicates')
    const appr = async (n) => (await call('GET', '/appraisal/appraisals?scope=mine', tok[n] ?? owner)).data.find((a) => a.cycleId === cid)
    const mA = await appr('mary'), pA = await appr('paul'), eA = await appr('eve'), dA = await appr('dan'), oA = await appr(null)
    const rate = (n) => Object.fromEntries(cids.map((c) => [c, n]))
    // self appraisals
    await call('POST', `/appraisal/appraisals/${mA.id}/self`, tok.mary, { ratings: rate(5) })
    await call('POST', `/appraisal/appraisals/${pA.id}/self`, tok.paul, { ratings: rate(5) })
    // own-appraisal rule: Hana (HR) has another HR admin and a system admin, so she cannot review herself
    await call('POST', `/appraisal/appraisals/${oA.id}/self`, owner, { ratings: rate(4) })
    const own = await call('POST', `/appraisal/appraisals/${oA.id}/manager`, owner, { ratings: rate(5), potential: 3, comment: 'Self review' })
    check(own.status === 403 && /own appraisal/.test(own.message), 'HR cannot review their own appraisal')
    check((await call('GET', `/appraisal/appraisals/${oA.id}`, owner)).data.can.manager === false, 'the screen does not offer it')
    check((await call('POST', `/appraisal/appraisals/${oA.id}/manager`, tok.hugh, { ratings: rate(4), potential: 2, comment: 'Reviewed by another HR admin' })).status === 200, 'another HR admin reviews it')
    // scale: 5 out of 5 can exceed
    const pr = await call('POST', `/appraisal/appraisals/${pA.id}/manager`, owner, { ratings: rate(5), potential: 3, comment: 'Outstanding all year' })
    check(pr.status === 200 && pr.data.scores.competencyScore === 120 && pr.data.scores.scaleVersion === 2, `5 of 5 is 120% (${pr.data?.scores?.competencyScore})`)
    check((await call('GET', `/appraisal/appraisals/${pA.id}`, owner)).data.rating === 'Exceeds expectations', 'a perfect appraisal can be "Exceeds expectations"')
    check((await call('GET', `/appraisal/appraisals/${oA.id}`, tok.hugh)).data.rating === 'Meets expectations', '4 of 5 is "Meets expectations"')
    // skip self, exclude, late joiner (Eve reports to Dan for this part, so he is her manager and still may not skip her self appraisal)
    await E.updateOne({ _id: ids.eve }, { $set: { managerId: ids.dan } })
    check((await call('POST', `/appraisal/appraisals/${eA.id}/manager`, tok.dan, { ratings: rate(4), potential: 2, comment: 'Skip please', skipSelf: true, skipReason: 'On leave' })).status === 403, 'a manager cannot skip the self appraisal')
    check((await call('POST', `/appraisal/appraisals/${eA.id}/manager`, owner, { ratings: rate(4), potential: 2, comment: 'Skipping', skipSelf: true })).status === 400, 'skipping needs a reason')
    const sk = await call('POST', `/appraisal/appraisals/${eA.id}/manager`, owner, { ratings: rate(4), potential: 2, comment: 'Reviewed while Eve was on leave', skipSelf: true, skipReason: 'Eve is on long leave' })
    check(sk.status === 200 && (await call('GET', `/appraisal/appraisals/${eA.id}`, owner)).data.selfSkipped?.reason === 'Eve is on long leave', 'HR writes the review without the self appraisal, marked as skipped')
    const late = await call('POST', `/appraisal/cycles/${cid}/participants`, owner, { employeeIds: [ids.pru, ids.mary] })
    check(late.status === 201 && late.data.added === 1, 'HR adds a late joiner (Mary is already in, so only one is added)')
    const pruA = await appr('pru')
    check((await call('POST', `/appraisal/cycles/${cid}/participants`, tok.dan, { employeeIds: [ids.pete] })).status === 403, 'only HR adds people')
    // Mary's full flow with 360
    const nom2 = await call('POST', `/appraisal/appraisals/${mA.id}/peers`, tok.mary, { employeeIds: [ids.pia, ids.pete] })
    check(nom2.status === 400 && /3 to 5/.test(nom2.message), 'fewer than three peers is refused with the 3 to 5 rule')
    check((await call('POST', `/appraisal/appraisals/${mA.id}/peers`, tok.mary, { employeeIds: [ids.pia, ids.pete, ids.pam, ids.pat] })).status === 201, 'Mary names four peers')
    check(/3 to 5/.test(JSON.stringify((await call('GET', `/appraisal/appraisals/${mA.id}`, tok.mary)).data.peers)) === false, 'the subject sees only counts before publishing')
    const fbOf = async (n) => (await call('GET', '/appraisal/feedback/mine', tok[n])).data[0]
    const answer = async (n, c, comment) => call('POST', `/appraisal/feedback/${(await fbOf(n)).id}`, tok[n], { ratings: rate(c), comment })
    await answer('pia', 4, 'I am Pia from sales and Mary is great'); await answer('pete', 5, 'Dependable'); await answer('pam', 3, 'Helpful')
    const hrView = (await call('GET', `/appraisal/appraisals/${mA.id}`, owner)).data.peers
    check(hrView.answered === 3 && hrView.pending.length === 1 && hrView.commentItems.length === 3, 'HR sees three answers, one pending reviewer and the comments with ids')
    const mgrPeers = async () => (await call('GET', `/appraisal/appraisals/${mA.id}`, tok.dan)).data.peers
    check((await mgrPeers()).comments.length === 3 && JSON.stringify((await mgrPeers()).comments) === JSON.stringify((await mgrPeers()).comments), 'the manager sees three comments in a stable order')
    check(!(await mgrPeers()).commentItems, 'but not the moderation list')
    const piaItem = hrView.commentItems.find((c) => /Pia/.test(c.original))
    check((await call('POST', `/appraisal/appraisals/${mA.id}/peers/${piaItem.id}/moderate`, tok.dan, { action: 'hide', reason: 'Names the writer' })).status === 403, 'a manager cannot moderate')
    check((await call('POST', `/appraisal/appraisals/${mA.id}/peers/${piaItem.id}/moderate`, owner, { action: 'hide', reason: 'x' })).status === 400, 'moderation needs a reason')
    check((await call('POST', `/appraisal/appraisals/${mA.id}/peers/${piaItem.id}/moderate`, owner, { action: 'hide', reason: 'It names the writer' })).status === 200 && (await mgrPeers()).comments.length === 2 && !JSON.stringify(await mgrPeers()).includes('Pia'), 'HR hides a comment that names its writer; the manager no longer sees it')
    check((await call('POST', `/appraisal/appraisals/${mA.id}/peers/${piaItem.id}/moderate`, owner, { action: 'edit', text: 'Mary is great to work with', reason: 'Removed the name' })).status === 200 && (await mgrPeers()).comments.includes('Mary is great to work with'), 'or edits it')
    check(await db.collection('audit_logs').countDocuments({ tenantId, action: 'APPRAISAL_COMMENT_MODERATED' }) === 2, 'each moderation is audited')
    // replace and remind
    const pend = hrView.pending[0]
    check((await call('POST', `/appraisal/appraisals/${mA.id}/peers/${pend.id}/replace`, tok.dan, { employeeId: ids.pru })).status === 403, 'only HR replaces a reviewer')
    check((await call('POST', `/appraisal/appraisals/${mA.id}/peers/${pend.id}/replace`, owner, { employeeId: ids.pia })).status === 409, 'the new reviewer cannot already be one')
    check((await call('POST', `/appraisal/appraisals/${mA.id}/peers/${pend.id}/replace`, owner, { employeeId: ids.pru })).status === 200, 'HR swaps a reviewer who has not answered')
    check((await call('POST', `/appraisal/appraisals/${mA.id}/peers/${(await db.collection('appraisal_peer_feedback').findOne({ appraisalId: mA.id, reviewerEmployeeId: ids.pia }))._id}/replace`, owner, { employeeId: ids.hugh })).status === 400, 'a reviewer who already answered cannot be replaced')
    const rem = await call('POST', `/appraisal/appraisals/${mA.id}/peers/remind`, owner)
    check(rem.data?.reminded === 1 && await count('pru', 'appraisal.feedback_reminder') === 1, 'HR reminds the reviewer who has not answered')
    check((await call('POST', `/appraisal/appraisals/${mA.id}/peers/remind`, owner)).data?.reminded === 0, 'at most once a day')
    await db.collection('appraisal_peer_feedback').updateOne({ appraisalId: mA.id, reviewerEmployeeId: ids.pru }, { $set: { createdAt: new Date(Date.now() - 4 * 86400000) }, $unset: { remindedAt: '' } })
    check((await runJob('appraisal-reminders')).status === 200 && await count('pru', 'appraisal.feedback_reminder') === 2, 'the daily job nudges after 3 days')
    await runJob('appraisal-reminders')
    check(await count('pru', 'appraisal.feedback_reminder') === 2, 'once only')
    await answer('pru', 4, 'Good teammate')
    // scores follow the goals
    const mr = await call('POST', `/appraisal/appraisals/${mA.id}/manager`, tok.dan, { ratings: rate(5), potential: 3, comment: 'Excellent work' })
    check(mr.data?.scores.goalScore == null && mr.data.scores.computed === 120, `without a reviewed goal the score is the competency score, 120 (${JSON.stringify(mr.data?.scores)})`)
    check((await call('POST', `/performance/goals/${g3.data.id}/review`, tok.dan, { achieved: { [kid]: 60 } })).data?.score === 60, 'the manager reviews her goal later (60%)')
    const after = (await call('GET', `/appraisal/appraisals/${mA.id}`, tok.dan)).data
    check(after.scores.goalScore === 60 && after.scores.computed === 90 && after.rating === 'Meets expectations', `the appraisal follows the goal at once: (60 + 120) / 2 = 90 (${JSON.stringify(after.scores)})`)
    // settle the rest: Dan removed, Pru (late joiner) removed, then publish
    check((await call('POST', `/appraisal/appraisals/${dA.id}/exclude`, tok.dan, { reason: 'Not allowed' })).status === 403, 'only HR removes people')
    check((await call('POST', `/appraisal/cycles/${cid}/status`, owner, { status: 'calibration' })).status === 200, 'HR opens calibration (scores are worked out again)')
    check((await call('POST', `/appraisal/cycles/${cid}/status`, owner, { status: 'published' })).status === 409 && /remove someone/.test((await call('POST', `/appraisal/cycles/${cid}/status`, owner, { status: 'published' })).message), 'publishing is blocked while people are waiting, and the message says what HR can do')
    check((await call('POST', `/appraisal/cycles/${cid}/status`, owner, { status: 'active' })).status === 200, 'back to open')
    check((await call('POST', `/appraisal/appraisals/${dA.id}/exclude`, owner, { reason: 'x' })).status === 400, 'a removal needs a reason')
    check((await call('POST', `/appraisal/appraisals/${dA.id}/exclude`, owner, { reason: 'Dan is leaving the company' })).data?.status === 'excluded', 'HR removes a leaver from the cycle')
    check((await call('GET', '/appraisal/appraisals?scope=mine', tok.dan)).data.every((a) => a.cycleId !== cid), 'it disappears from their own list')
    check((await call('POST', `/appraisal/appraisals/${dA.id}/restore`, owner)).data?.status === 'pending_self', 'and can be restored')
    await call('POST', `/appraisal/appraisals/${dA.id}/exclude`, owner, { reason: 'Dan is leaving the company' })
    await call('POST', `/appraisal/appraisals/${pruA.id}/exclude`, owner, { reason: 'Joined too late for this cycle' })
    // goal changes behind the system's back are picked up when calibration opens
    await db.collection('performance_goals').updateOne({ _id: g3.data.id }, { $set: { score: 100 } })
    check((await call('POST', `/appraisal/cycles/${cid}/status`, owner, { status: 'calibration' })).status === 200, 'calibration opens')
    check((await call('GET', `/appraisal/appraisals/${mA.id}`, owner)).data.scores.computed === 110, 'the score was worked out again when calibration opened: (100 + 120) / 2 = 110')
    check((await call('POST', `/appraisal/appraisals/${oA.id}/calibrate`, owner, { finalScore: 120, reason: 'Trying my own' })).status === 403, 'HR cannot calibrate their own appraisal')
    check((await call('POST', `/appraisal/appraisals/${mA.id}/calibrate`, owner, { finalScore: 105, reason: 'Aligned with the team' })).data?.finalScore === 105, 'HR calibrates someone else')
    const sum = await call('GET', `/appraisal/cycles/${cid}/summary`, owner)
    check(sum.data.grid['high:3']?.includes('Paul Mwale'), 'the 9-box "high" column is reachable (Paul: 120% with high potential)')
    check((await call('POST', `/appraisal/cycles/${cid}/status`, owner, { status: 'published' })).status === 200, 'publishing works once nobody is waiting')
    await db.collection('performance_goals').updateOne({ _id: g3.data.id }, { $set: { score: 10 } })
    const pub = (await call('GET', `/appraisal/appraisals/${mA.id}`, tok.mary)).data
    check(pub.finalScore === 105 && pub.rating === 'Meets expectations', 'published scores stay frozen even if a goal changes afterwards')
    check(pub.peers.averages && pub.peers.comments.includes('Mary is great to work with') && !JSON.stringify(pub.peers).includes('Pia'), 'after publishing Mary sees the averages and the comments as HR left them')
    check((await call('POST', `/appraisal/appraisals/${mA.id}/peers/${piaItem.id}/moderate`, owner, { action: 'restore', reason: 'Changing my mind' })).status === 400, 'comments cannot change after publishing')
    // improvement plans
    const plan = { employeeId: ids.mary, reason: 'Missed two month-end deadlines', objectives: ['Close the books by day 5', 'Weekly check-in'] }
    check((await call('POST', '/appraisal/plans', tok.dan, { ...plan, endDate: inDays(-1) })).status === 400, 'a plan cannot end in the past')
    const pl = await call('POST', '/appraisal/plans', tok.dan, { ...plan, endDate: inDays(30) })
    check(pl.status === 201 && pl.data.notes.length === 1, 'the manager starts a plan with a first history line')
    await call('POST', `/appraisal/plans/${pl.data.id}/progress`, tok.dan, { objectiveId: pl.data.objectives[0].id, done: true })
    check((await call('POST', `/appraisal/plans/${pl.data.id}/close`, tok.dan, { outcome: 'extended', note: 'More time', endDate: inDays(-3) })).status === 400, 'an extension needs a future date')
    check((await call('POST', `/appraisal/plans/${pl.data.id}/close`, tok.dan, { outcome: 'extended', note: 'Two more weeks to finish', endDate: inDays(45) })).data?.status === 'active', 'the plan is extended with a note')
    const pm = (await call('GET', '/appraisal/plans?scope=team', tok.dan)).data[0]
    check(pm.notes.length === 3 && pm.notes.some((n) => /Done: Close the books/.test(n.text)) && pm.notes.some((n) => /Extended until/.test(n.text)), 'the history shows the start, the tick and the extension')
    check((await call('POST', `/appraisal/plans/${pl.data.id}/close`, tok.dan, { outcome: 'unsuccessful', note: 'Objectives were not met' })).data?.status === 'closed', 'closing records the outcome')
    check((await call('GET', '/appraisal/plans?scope=team', tok.dan)).data[0].notes.some((n) => /Closed \(objectives not met\): Objectives were not met/.test(n.text)), 'and the reason in the history')

    // ═══════════ R-S. CONFIRMATIONS ═══════════
    const setProb = (n, days) => E.updateOne({ _id: ids[n] }, { $set: { probationEndDate: new Date(`${inDays(days)}T00:00:00Z`) } })
    await setProb('tom', 10)
    const dueDan = await call('GET', '/confirmation/due', tok.dan)
    check(dueDan.status === 200 && dueDan.data.length === 1 && dueDan.data[0].name === 'Tom Probation' && dueDan.data[0].canStart === false, 'a manager sees their own people who are due, read only')
    check((await call('GET', '/confirmation/due', tok.mary)).status === 403, 'an ordinary employee does not')
    check((await call('GET', '/confirmation/due', owner)).data[0].canStart === true, 'HR sees everyone and can start')
    const c1 = await call('POST', '/confirmation/cases', owner, { employeeId: ids.tom })
    check(c1.status === 201 && await count('dan', 'confirmation.review_opened') === 1, 'opening a review tells the manager')
    // reassign
    check((await call('POST', `/confirmation/cases/${c1.data.id}/reassign`, owner, { managerEmployeeId: ids.meg, reason: 'x' })).status === 400, 'reassigning needs a reason')
    check((await call('POST', `/confirmation/cases/${c1.data.id}/reassign`, tok.dan, { managerEmployeeId: ids.meg, reason: 'Dan is away' })).status === 403, 'only HR reassigns')
    check((await call('POST', `/confirmation/cases/${c1.data.id}/reassign`, owner, { managerEmployeeId: ids.meg, reason: 'Dan is away for a month' })).status === 200 && await count('meg', 'confirmation.review_opened') === 1, 'HR hands the review to another manager, who is told')
    const rvBody = { rating: 3, strengths: 'Learning fast', concerns: 'Needs product knowledge', recommendation: 'extend', extensionMonths: 3 }
    check((await call('POST', `/confirmation/cases/${c1.data.id}/review`, tok.dan, rvBody)).status === 403, 'the old manager can no longer review it')
    // cancel, then open again
    check((await call('POST', `/confirmation/cases/${c1.data.id}/cancel`, owner, { reason: 'x' })).status === 400, 'cancelling needs a reason')
    check((await call('POST', `/confirmation/cases/${c1.data.id}/cancel`, owner, { reason: 'Opened by mistake' })).data?.status === 'closed', 'HR cancels a stuck case')
    check((await call('GET', `/confirmation/cases/${c1.data.id}`, tok.tom)).status === 404 && (await call('GET', '/confirmation/cases', tok.tom)).data.length === 0, 'the employee never sees a cancelled review')
    check((await call('GET', '/confirmation/due', owner)).data.some((d) => d.name === 'Tom Probation'), 'the person is due again')
    const c2 = await call('POST', '/confirmation/cases', owner, { employeeId: ids.tom })
    check(c2.status === 201, 'a new review can be opened')
    // review on behalf, suggested date, concerns hidden from the employee
    check((await call('POST', `/confirmation/cases/${c2.data.id}/review`, owner, rvBody)).status === 403, 'HR cannot review without saying why')
    const ob = await call('POST', `/confirmation/cases/${c2.data.id}/review`, owner, { ...rvBody, onBehalfReason: 'Dan is on leave and the date is close' })
    check(ob.status === 200 && ob.data.review.onBehalfOf.reason && ob.data.status === 'hr_decision', 'HR reviews on behalf of an absent manager with a reason')
    check(await count('hugh', 'confirmation.hr_waiting') >= 1, 'the other HR admins are told it is ready for a decision')
    const probEnd = (await E.findOne({ _id: ids.tom })).probationEndDate
    const want = new Date(probEnd.getTime()); want.setUTCMonth(want.getUTCMonth() + 3)
    check((await call('GET', `/confirmation/cases/${c2.data.id}`, owner)).data.suggestedEndDate === ymd(want), 'the recommended 3 months arrive in HR\'s date box as a date')
    check(!JSON.stringify((await call('GET', `/confirmation/cases/${c2.data.id}`, tok.tom)).data).includes('product knowledge'), 'the employee never sees the concerns')
    // early confirmation warning, decision, letter
    const early = await call('POST', `/confirmation/cases/${c2.data.id}/decide`, owner, { outcome: 'confirmed' })
    check(early.status === 409 && early.code === 'EARLY_CONFIRMATION' && /Confirm anyway/.test(early.message), 'confirming before the probation ends asks for a deliberate yes')
    const dec = await call('POST', `/confirmation/cases/${c2.data.id}/decide`, owner, { outcome: 'confirmed', ackEarly: true })
    check(dec.status === 200 && dec.data.decision.early === true && (await E.findOne({ _id: ids.tom })).confirmationDate, 'with the yes, the person is confirmed and their confirmation date is set')
    check(await db.collection('audit_logs').countDocuments({ tenantId, action: 'EMPLOYEE_CONFIRMED', entityId: ids.tom }) === 1, 'the confirmation is audited on the person')
    check(await count('tom', 'confirmation.decided') === 1, 'the employee is told the outcome')
    const tn = await db.collection('notifications').findOne({ userId: await uid('tom'), type: 'confirmation.decided' })
    check(!/product knowledge|concern/i.test(`${tn.title} ${tn.body}`), 'and the message carries no concerns')
    const letter = await raw(`/confirmation/cases/${c2.data.id}/letter`, owner)
    check(letter.status === 200 && /pdf/.test(letter.type) && letter.bytes.subarray(0, 4).toString() === '%PDF' && letter.bytes.length > 1500, `HR downloads the confirmation letter as a PDF (${letter.status} ${letter.type} ${letter.bytes.length} bytes)`)
    check((await raw(`/confirmation/cases/${c2.data.id}/letter`, tok.tom)).status === 200, 'the employee downloads their own letter')
    check((await raw(`/confirmation/cases/${c2.data.id}/letter`, tok.eve)).status === 404, 'someone else cannot')
    // templates
    check((await call('GET', '/confirmation/templates', tok.mary)).status === 403, 'only HR sees the templates')
    const tp = await call('GET', '/confirmation/templates', owner)
    check(tp.data.confirmed.includes('{name}') && tp.data.placeholders.includes('designation'), 'HR sees the default letters and the placeholders')
    check((await call('PUT', '/confirmation/templates', owner, { confirmed: 'Dear {name}, welcome aboard as {job} at {company}. Congratulations again.' })).status === 400, 'an unknown placeholder is refused and named')
    check((await call('PUT', '/confirmation/templates', owner, { confirmed: 'Dear {name}, you are now a confirmed {designation} at {company} from {date}. Congratulations!' })).data?.confirmed.startsWith('Dear {name}, you are now'), 'HR saves their own wording')
    const prev = await raw('/confirmation/templates/preview?kind=confirmed', owner)
    check(prev.status === 200 && prev.bytes.subarray(0, 4).toString() === '%PDF', 'and previews it as a PDF')
    // a not-confirmed case has no letter; the extension letter exists
    await setProb('ann', 40)
    const c3 = (await call('POST', '/confirmation/cases', owner, { employeeId: ids.ann })).data.id
    await call('POST', `/confirmation/cases/${c3}/review`, tok.dan, { rating: 2, strengths: 'Willing', concerns: 'Slow to learn', recommendation: 'extend', extensionMonths: 2 })
    const ext = await call('POST', `/confirmation/cases/${c3}/decide`, owner, { outcome: 'extended', note: 'Agree', newEndDate: inDays(100) })
    check(ext.status === 200 && (await raw(`/confirmation/cases/${c3}/letter`, owner)).bytes.subarray(0, 4).toString() === '%PDF', 'an extension has a letter too')
    await setProb('bob', 20); await setProb('ann', 5)
    const noLetter = (await call('POST', '/confirmation/cases', owner, { employeeId: ids.ann })).data.id
    await call('POST', `/confirmation/cases/${noLetter}/review`, tok.dan, { rating: 1, strengths: 'Tried', concerns: 'Not a fit', recommendation: 'not_confirm' })
    await call('POST', `/confirmation/cases/${noLetter}/decide`, owner, { outcome: 'not_confirmed', note: 'Not a fit' })
    check((await raw(`/confirmation/cases/${noLetter}/letter`, owner)).status === 404, 'a not-confirmed decision has no letter')
    // probation reminders: Bob (20 days) gets the 30-day mail, a person at 5 days the 7-day mail, once each; people with an open review are skipped
    await E.updateOne({ _id: ids.ann }, { $set: { probationEndDate: new Date(`${inDays(40)}T00:00:00Z`) } })
    await setProb('paul', 5); await E.updateOne({ _id: ids.paul }, { $set: { managerId: ids.dan } })
    await db.collection('notifications').deleteMany({ tenantId, type: 'confirmation.due' })
    check((await runJob('probation-reminders')).status === 200, 'the daily probation job runs')
    const dueN = await db.collection('notifications').find({ tenantId, type: 'confirmation.due' }).toArray()
    const danId = await uid('dan'), hughId = await uid('hugh')
    check(dueN.some((n) => n.userId === danId && /Bob/.test(n.title) && /within 30 days/.test(n.title)) && dueN.some((n) => n.userId === hughId && /Bob/.test(n.title)), 'Bob (20 days left): the manager and HR get the 30-day reminder')
    check(dueN.some((n) => n.userId === danId && /Paul/.test(n.title) && /within a week/.test(n.title)), 'Paul (5 days left): the 7-day reminder')
    const n1 = dueN.length
    await runJob('probation-reminders')
    check((await db.collection('notifications').countDocuments({ tenantId, type: 'confirmation.due' })) === n1, 'run again, nobody is told twice')
    check(!dueN.some((n) => /Tom/.test(n.title)), 'a confirmed person is not reminded')

    console.log(`${passed} passed, ${failed} failed`)
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      await db.collection('performance_goal_meta').deleteMany({ tenantId })
      await db.collection('confirmation_templates').deleteMany({ _id: tenantId })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    process.exit(failed ? 1 : 0)
  }
})()

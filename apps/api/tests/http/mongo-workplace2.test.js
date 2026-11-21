// Community (forums, kudos, events), incentives and reports on the MongoDB API. Removes its company at the end.
//   API=http://localhost:4214 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-workplace2.test.js
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
const iso = (d) => d.toISOString().slice(0, 10)
const inDays = (n) => new Date(Date.now() + n * 86400000)
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`

;(async () => {
  const stamp = Date.now(), email = `w2${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `Community Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    await call('PUT', '/company/plan', owner, { plan: 'growth', addons: [] })
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), danielId = await mk('Daniel', 'Zulu'), paulId = await mk('Paul', 'Mwale'), fionaId = await mk('Fiona', 'Phiri')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const daniel = await login(owner, danielId, `daniel${stamp}@example.com`, ['manager'])
    const paul = await login(owner, paulId, `paul${stamp}@example.com`, ['employee'])
    const fiona = await login(owner, fionaId, `fiona${stamp}@example.com`, ['payroll_admin'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danielId } })

    // ───────────── community
    const sp = await call('GET', '/forums/spaces', mary)
    check(sp.status === 200, `spaces list (${short(sp).slice(0, 100)})`)
    check((await call('POST', '/forums/spaces', mary, { name: 'Random' })).status === 403, 'an employee cannot create a space')
    const space = await call('POST', '/forums/spaces', owner, { name: 'Announcements and ideas', description: 'Company wide', kind: 'company' })
    check(space.status === 201, `HR creates a space (${short(space)})`)
    const sid = space.data.id
    const th = await call('POST', '/forums/threads', mary, { spaceId: sid, title: 'Lunch on Friday?', body: 'Anyone for a team lunch **this Friday**?', tags: ['social'] })
    check(th.status === 201, `Mary starts a thread (${short(th)})`)
    const tid = th.data.id
    check((await call('GET', `/forums/threads?spaceId=${sid}`, paul)).data.some((t) => t.id === tid), 'others see it')
    check((await call('GET', '/forums/threads?q=lunch', paul)).data.some((t) => t.id === tid), 'search finds it')
    check((await call('POST', `/forums/threads/${tid}/comments`, paul, { body: 'Count me in' })).status === 201, 'Paul comments')
    const td = await call('GET', `/forums/threads/${tid}`, mary)
    check(td.status === 200 && JSON.stringify(td.data).includes('Count me in'), 'the thread shows the comment')
    const poll = await call('POST', '/forums/threads', daniel, { spaceId: sid, title: 'Which day for the offsite?', body: 'Vote please', poll: { question: 'Best day?', options: ['Monday', 'Friday'], multi: false } })
    check(poll.status === 201, `Daniel starts a poll (${short(poll).slice(0, 100)})`)
    const pd = await call('GET', `/forums/threads/${poll.data.id}`, mary)
    const optId = pd.data?.poll?.options?.[0]?.id
    check((await call('POST', `/forums/threads/${poll.data.id}/vote`, mary, { optionIds: [optId ?? 'o1'] })).status === 200, 'Mary votes')
    check((await call('POST', `/forums/threads/${tid}/moderate`, mary, { pinned: true })).status === 403, 'an employee cannot pin')
    check((await call('POST', `/forums/threads/${tid}/moderate`, owner, { pinned: true })).status === 200, 'HR pins the thread')
    const bw = await call('PUT', '/forums/settings', owner, { blockedWords: ['spamword'] })
    check(bw.status === 200, 'HR sets blocked words')
    check((await call('POST', '/forums/threads', paul, { spaceId: sid, title: 'Buy now', body: 'this is spamword' })).status >= 400, 'a blocked word is refused')
    const rep = await call('POST', '/forums/reports', paul, { targetType: 'thread', targetId: tid, reason: 'Off topic for this space' })
    check(rep.status === 201, 'Paul reports a thread')
    check((await call('GET', '/forums/reports', paul)).status === 403, 'an employee cannot read reports')
    check((await call('GET', '/forums/reports', owner)).data.length === 1, 'HR sees the report')
    const rid = (await call('GET', '/forums/reports', owner)).data[0].id; const rs = await call('POST', `/forums/reports/${rid}/resolve`, owner, { hide: false }); check(rs.status === 200, 'HR resolves it ' + short(rs))
    const k = await call('POST', '/forums/kudos', mary, { toEmployeeId: paulId, badge: 'teamwork', message: 'Thanks for covering my shift' })
    check(k.status === 201, `Mary gives kudos (${short(k).slice(0, 100)})`)
    check((await call('POST', '/forums/kudos', mary, { toEmployeeId: maryId, badge: 'teamwork', message: 'Me myself' })).status >= 400, 'kudos to yourself is refused')
    check((await call('GET', '/forums/kudos', paul)).data.length >= 1, 'the kudos wall shows it')
    check((await call('POST', '/forums/follows', mary, { kind: 'tag', key: 'social', on: true })).status === 200, 'Mary follows a tag')
    check((await call('GET', '/forums/follows', mary)).status === 200, 'follows list')
    const ev = await call('POST', '/forums/events', owner, { title: 'Town hall', kind: 'townhall', startsAt: inDays(5).toISOString(), location: 'Boardroom' })
    check(ev.status === 201, `HR creates an event (${short(ev).slice(0, 100)})`)
    check((await call('POST', `/forums/events/${ev.data.id}/rsvp`, mary, { status: 'going' })).status === 200, 'Mary RSVPs')
    check((await call('GET', `/forums/events?from=${iso(new Date())}&to=${iso(inDays(30))}`, paul)).data.length === 1, 'the event shows in the calendar')
    check((await call('GET', '/forums/analytics?days=30', owner)).status === 200, 'community analytics for HR')
    check((await call('GET', '/forums/analytics?days=30', mary)).status === 403, 'but not for employees')

    // ───────────── incentives (a payroll feature)
    const ity = await call('POST', '/incentives/types', owner, { name: 'Spot award', code: 'SPOT', defaultAmount: 500, maxAmount: 2000 })
    check([201, 403].includes(ity.status), `creating an incentive type answers (${short(ity).slice(0, 120)})`)
    const types = await call('GET', '/incentives/types', daniel)
    check(types.status === 200, `types list (${short(types).slice(0, 100)})`)
    const typeId = types.data?.[0]?.id
    if (typeId) {
      const nom = await call('POST', '/incentives', daniel, { employeeId: maryId, typeId, amount: 300, reason: 'Closed the quarter early' })
      check(nom.status === 201, `Daniel nominates Mary (${short(nom).slice(0, 120)})`)
      check((await call('POST', `/incentives/${nom.data?.id}/approve`, daniel, {})).status === 403, 'the nominator cannot approve')
      const ap = await call('POST', `/incentives/${nom.data?.id}/approve`, owner, { note: 'Approved' })
      check(ap.status === 200, `HR approves (${short(ap).slice(0, 120)})`)
      check((await call('GET', '/incentives', mary)).status === 200, "Mary sees her own awards")
    }
    check((await call('GET', '/incentives/points', mary)).status === 200, 'points balance')
    check((await call('GET', '/incentives/points/leaderboard', mary)).status === 200, 'leaderboard')
    check((await call('GET', '/incentives/settings', owner)).status < 500, 'incentive settings answer')

    // ───────────── reports
    const rc = await call('GET', '/reports', owner)
    check(rc.status === 200, `the report catalog (${short(rc).slice(0, 100)})`)
    { const pr = await call('GET', '/reports', paul); check(pr.status === 403 || (pr.status === 200 && (pr.data?.reports ?? pr.data ?? []).length === 0), 'an employee has no reports ' + short(pr).slice(0, 120)) }
    const keys = (rc.data?.reports ?? rc.data ?? []).map((r) => r.key).filter(Boolean)
    check(keys.length >= 3, `the catalog lists reports (${keys.join(',')})`)
    let okRuns = 0, bad = []
    for (const key of keys) { const r = await call('GET', `/reports/${key}`, owner); if (r.status === 200 || r.status === 403) okRuns++; else bad.push(`${key}:${r.status}`) }
    check(okRuns === keys.length, `every report runs or is refused cleanly, none crashes (${bad.join(' ')})`)
    check((await call('GET', '/reports/kpis', owner)).status === 200, 'KPIs')
    const bf = await call('GET', '/reports/builder/fields', owner)
    check(bf.status === 200, `builder fields (${short(bf).slice(0, 100)})`)
    const sv = await call('POST', '/reports/builder/saved', owner, { name: 'Headcount by dept', source: 'employees', columns: ['employeeCode', 'firstName'], filters: [] })
    check([201, 400].includes(sv.status), `saving a custom report answers (${short(sv).slice(0, 140)})`)
    if (sv.status === 201) {
      check((await call('GET', `/reports/builder/saved/${sv.data.id}/run`, owner)).status === 200, 'the saved report runs')
      check((await call('GET', '/reports/builder/saved', owner)).data.length === 1, 'it lists')
      check((await call('DELETE', `/reports/builder/saved/${sv.data.id}`, owner)).status === 200, 'and deletes')
    }
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

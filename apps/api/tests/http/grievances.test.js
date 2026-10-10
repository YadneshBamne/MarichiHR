// Grievances: named and anonymous cases, HR-only handling, conversation and internal notes, resolution rules,
// deadlines by severity, notifications, anonymity guarantees and tenant isolation. Deletes what it creates.
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `gr${Date.now() % 1e6}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DAY = 86_400_000

;(async () => {
  const admin = await tokenFor('admin@marichihr.com') // hr_admin
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const john = await tokenFor('john.banda@marichihr.com') // manager
  const made = []

  // ─── Named case ────────────────────────────────────────────
  let r = await api(jane, 'POST', '/grievances', { category: 'Facilities', subject: `Broken AC ${TAG}`, description: 'The AC on floor 2 has been broken for two weeks.', severity: 'medium' })
  const named = r.body
  made.push(named?.id)
  check('an employee raises a named case and gets a ticket number', r.status === 201 && /^GRV-\d{4,}$/.test(named.ticketNo) && named.caseKey === null, r.data)
  check('a medium case is due in 7 days', Math.abs(new Date(named.dueAt) - Date.now() - 7 * DAY) < 60_000, named.dueAt)
  r = await api(jane, 'POST', '/grievances', { category: 'Nonsense', subject: 'x', description: 'too short' })
  check('invalid category / short text is refused (400)', r.status === 400, r.status)
  check('it is in her "My cases"', (await api(jane, 'GET', '/grievances/mine')).body.some((g) => g.id === named.id))

  r = await api(jane, 'GET', '/grievances')
  check('employees cannot see the case queue (403)', r.status === 403, r.status)
  r = await api(john, 'GET', '/grievances')
  check('managers cannot see the case queue (403)', r.status === 403, r.status)
  r = await api(john, 'GET', `/grievances/${named.id}`)
  check("a manager cannot open someone's case (403)", r.status === 403, r.status)
  r = await api(john, 'GET', `/grievances/mine/${named.id}`)
  check("…not even through 'mine' (404)", r.status === 404, r.status)

  let hrNote = null
  for (let i = 0; i < 20 && !hrNote; i++) { await sleep(1000); hrNote = await prisma.notification.findFirst({ where: { userId: admin.userId, entityId: named.id, type: 'grievance.raised' } }) }
  check('HR is notified of the new case', !!hrNote, hrNote)

  // ─── HR handles it ─────────────────────────────────────────
  r = await api(admin, 'GET', '/grievances?status=active')
  check('HR sees it in the active queue with the raiser', r.status === 200 && r.body.some((g) => g.id === named.id && g.raisedBy && !g.anonymous), r.data)
  r = await api(admin, 'POST', `/grievances/${named.id}/messages`, { body: 'Facilities is checking it today.' })
  r = await api(admin, 'POST', `/grievances/${named.id}/messages`, { body: 'Vendor quote pending.', internal: true })
  r = await api(admin, 'GET', `/grievances/${named.id}`)
  check('a reply moves it to in review and assigns the replying HR admin', r.body.status === 'in_review' && r.body.assignedToUserId === admin.userId, r.body)
  r = await api(jane, 'GET', `/grievances/mine/${named.id}`)
  check("the raiser sees HR's reply but not the internal note", r.body.messages.some((m) => m.from === 'HR' && /Facilities/.test(m.body)) && !r.body.messages.some((m) => /Vendor/.test(m.body)), r.body.messages)
  const janeUser = await prisma.user.findFirst({ where: { email: 'jane.mutale@marichihr.com' } })
  check('the raiser is notified of the reply', !!(await prisma.notification.findFirst({ where: { userId: janeUser.id, entityId: named.id, type: 'grievance.update' } })))
  r = await api(jane, 'POST', `/grievances/mine/${named.id}/messages`, { body: 'Thanks, it is still hot.' })
  check('the raiser replies', r.status === 201, r.data)
  r = await api(admin, 'PATCH', `/grievances/${named.id}`, { assignedToUserId: john.userId })
  check('a case cannot be assigned to a non-HR user (400)', r.status === 400, r.data)
  r = await api(admin, 'PATCH', `/grievances/${named.id}`, { status: 'resolved' })
  check('resolving without a resolution is refused (400)', r.status === 400, r.data)
  r = await api(admin, 'PATCH', `/grievances/${named.id}`, { status: 'resolved', resolution: 'AC repaired on 12 Oct.' })
  check('HR resolves it with a resolution', r.status === 200 && r.body.status === 'resolved' && r.body.resolvedAt, r.data)
  r = await api(jane, 'GET', `/grievances/mine/${named.id}`)
  check('the raiser sees the outcome', r.body.status === 'resolved' && r.body.resolution === 'AC repaired on 12 Oct.', r.body)
  await api(admin, 'PATCH', `/grievances/${named.id}`, { status: 'closed' })
  r = await api(jane, 'POST', `/grievances/mine/${named.id}/messages`, { body: 'one more thing' })
  check('a closed case takes no more messages (400)', r.status === 400, r.data)

  // ─── Anonymous case ────────────────────────────────────────
  r = await api(john, 'POST', '/grievances', { category: 'Harassment', subject: `Anon ${TAG}`, description: 'Something serious happened in the meeting room.', severity: 'critical', anonymous: true })
  const anon = r.body
  made.push(anon?.id)
  check('an anonymous case returns a case key and is due in 2 days', r.status === 201 && /^[0-9A-F]{8}-[0-9A-F]{8}-[0-9A-F]{8}$/.test(anon.caseKey) && Math.abs(new Date(anon.dueAt) - Date.now() - 2 * DAY) < 60_000, r.data)
  const row = await prisma.grievance.findUnique({ where: { id: anon.id } })
  check('no identity is stored, and the key itself is not stored (only its hash)', row.raisedByUserId === null && row.caseKeyHash && row.caseKeyHash !== anon.caseKey && !JSON.stringify(row).includes(anon.caseKey), row)
  check('no audit entry ties the raiser to it', !(await prisma.auditLog.findFirst({ where: { entityId: anon.id, userId: john.userId } })))
  const ev = await prisma.domainEvent.findFirst({ where: { eventType: 'grievance.raised', payload: { path: ['grievanceId'], equals: anon.id } } })
  check('the event carries only the case id', ev && Object.keys(ev.payload).join() === 'grievanceId', ev?.payload)
  check("it is not in the raiser's 'My cases'", !(await api(john, 'GET', '/grievances/mine')).body.some((g) => g.id === anon.id))
  r = await api(admin, 'GET', `/grievances/${anon.id}`)
  check('HR sees it as anonymous with no raiser', r.body.anonymous && r.body.raisedBy === null, r.body)
  r = await api(john, 'POST', '/grievances/anonymous/view', { caseKey: anon.caseKey })
  check('the raiser opens it with the key', r.status === 200 && r.body.id === anon.id, r.data)
  r = await api(john, 'POST', '/grievances/anonymous/view', { caseKey: 'AAAAAAAA-BBBBBBBB-CCCCCCCC' })
  check('a wrong key finds nothing (404)', r.status === 404, r.status)
  r = await api(john, 'POST', '/grievances/anonymous/messages', { caseKey: anon.caseKey, body: 'It happened on Tuesday.' })
  check('the anonymous raiser replies with the key', r.status === 201, r.data)
  const msg = await prisma.grievanceMessage.findFirst({ where: { grievanceId: anon.id, authorRole: 'raiser' } })
  check('…and the message stores no author', msg && msg.authorUserId === null, msg)
  await api(admin, 'POST', `/grievances/${anon.id}/messages`, { body: 'We are investigating.' })
  r = await api(john, 'POST', '/grievances/anonymous/view', { caseKey: anon.caseKey })
  check("the anonymous raiser sees HR's reply", r.body.messages.some((m) => m.from === 'HR'), r.body.messages)
  r = await api(admin, 'PATCH', `/grievances/${anon.id}`, { severity: 'low' })
  check('changing severity recomputes the due date', Math.abs(new Date(r.body.dueAt) - new Date(row.createdAt) - 14 * DAY) < 1000, r.body?.dueAt)

  // ─── Isolation ─────────────────────────────────────────────
  const otherTenant = await prisma.tenant.findFirst({ where: { slug: { not: 'marichi-labs' }, active: true } })
  const foreign = await prisma.grievance.create({ data: { tenantId: otherTenant.id, ticketNo: `GRV-X${TAG}`, category: 'Other', subject: 'x', description: 'x', dueAt: new Date(), caseKeyHash: row.caseKeyHash.replace(/.$/, '0'), anonymous: true } })
  r = await api(admin, 'GET', `/grievances/${foreign.id}`)
  check("another company's case is not found (404)", r.status === 404, r.status)
  r = await api(admin, 'PATCH', `/grievances/${foreign.id}`, { severity: 'low' })
  check('…and cannot be changed (404)', r.status === 404, r.status)
  check("…and is not in this company's queue", !(await api(admin, 'GET', '/grievances')).body.some((g) => g.id === foreign.id))

  // ─── Cleanup (test data only) ──────────────────────────────
  const ids = [...made.filter(Boolean), foreign.id]
  await prisma.grievanceMessage.deleteMany({ where: { grievanceId: { in: ids } } })
  await prisma.notification.deleteMany({ where: { entityId: { in: ids } } })
  await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } })
  await prisma.grievance.deleteMany({ where: { id: { in: ids } } })
  await done()
})()

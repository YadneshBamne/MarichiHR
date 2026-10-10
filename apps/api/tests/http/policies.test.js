// Policies: drafts are private to HR; publishing asks the audience to accept; a new version asks again and keeps
// history; targeting; overdue status; reminders; notifications; tenant isolation. Archives everything it creates.
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `po${Date.now() % 1e6}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const admin = await tokenFor('admin@marichihr.com')
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const john = await tokenFor('john.banda@marichihr.com')
  const made = []
  const mine = async (who) => (await api(who, 'GET', '/policies')).body || []

  let r = await api(jane, 'POST', '/policies', { title: 'x', body: 'y' })
  check('an employee cannot create a policy (403)', r.status === 403, r.status)
  r = await api(admin, 'POST', '/policies', { title: `Conduct ${TAG}`, category: 'Code of conduct', body: 'Be kind. Be honest.', acceptWithinDays: 5 })
  const pol = r.body
  made.push(pol?.id)
  check('HR creates a policy (as a draft)', r.status === 201 && pol.id, r.data)
  check('a draft is invisible to employees', !(await mine(jane)).some((p) => p.id === pol.id))
  r = await api(jane, 'GET', `/policies/${pol.id}`)
  check('…even by its id (404)', r.status === 404, r.status)
  r = await api(admin, 'GET', `/policies/${pol.id}`)
  check('HR sees the draft v1', r.status === 200 && r.body.draft?.version === 1 && !r.body.current, r.body)

  // ─── Publish v1 ────────────────────────────────────────────
  r = await api(admin, 'POST', `/policies/${pol.id}/publish`, {})
  check('HR publishes v1', r.status === 200 && r.body.version === 1, r.data)
  r = await api(admin, 'POST', `/policies/${pol.id}/publish`, {})
  check('publishing again without a new draft is refused (400)', r.status === 400, r.data)
  let p = (await mine(jane)).find((x) => x.id === pol.id)
  check('employee sees it as "to accept" with a due date 5 days out', p?.status === 'pending' && p.version === 1 && !!p.dueDate, p)
  const counts = (await api(jane, 'GET', '/dashboard/counts')).body.policies
  check('sidebar count includes it', counts >= 1, counts)
  let note = null
  const janeUser = await prisma.user.findFirst({ where: { email: 'jane.mutale@marichihr.com' } })
  for (let i = 0; i < 20 && !note; i++) { await sleep(1000); note = await prisma.notification.findFirst({ where: { userId: janeUser.id, entityId: pol.id, type: 'policy.published' } }) }
  check('the audience is notified', !!note, note)

  r = await api(jane, 'POST', `/policies/${pol.id}/accept`)
  check('employee accepts v1', r.status === 200 && r.body.version === 1, r.data)
  r = await api(jane, 'POST', `/policies/${pol.id}/accept`)
  check('accepting twice is harmless', r.status === 200, r.data)
  p = (await mine(jane)).find((x) => x.id === pol.id)
  check('…and it shows as accepted', p?.status === 'accepted' && !!p.acceptedAt, p)
  check('sidebar count goes down', (await api(jane, 'GET', '/dashboard/counts')).body.policies === counts - 1)

  // ─── New version ───────────────────────────────────────────
  r = await api(admin, 'PUT', `/policies/${pol.id}/draft`, { body: 'Be kind. Be honest. Be on time.', changeNote: 'Added punctuality' })
  check('HR writes a v2 draft', r.status === 200 && r.body.version === 2, r.data)
  check('v1 stays in force while v2 is a draft', (await mine(jane)).find((x) => x.id === pol.id)?.version === 1)
  r = await api(admin, 'POST', `/policies/${pol.id}/publish`, { effectiveFrom: '2026-11-01' })
  p = (await mine(jane)).find((x) => x.id === pol.id)
  check('publishing v2 asks for acceptance again', p?.version === 2 && p.status === 'pending' && p.effectiveFrom === '2026-11-01', p)
  r = await api(jane, 'GET', `/policies/${pol.id}`)
  check('the change note and v1 history are visible', r.body.current.changeNote === 'Added punctuality' && r.body.history.some((h) => h.version === 1 && h.status === 'superseded') && !r.body.draft, r.body)

  // ─── Overdue, acceptances, reminders ───────────────────────
  await prisma.policyVersion.updateMany({ where: { policyId: pol.id, status: 'published' }, data: { publishedAt: new Date(Date.now() - 10 * 86_400_000) } })
  check('past the deadline it shows as overdue', (await mine(jane)).find((x) => x.id === pol.id)?.status === 'overdue')
  r = await api(admin, 'GET', '/policies/manage')
  const m = r.body.find((x) => x.id === pol.id)
  check('manage view: v2, accepted 0 of audience, overdue', m?.version === 2 && m.accepted === 0 && m.audience > 0 && m.overdue, m)
  r = await api(admin, 'GET', `/policies/${pol.id}/acceptances`)
  check('HR sees who has not accepted v2', r.status === 200 && r.body.some((x) => x.userId === jane.userId && !x.acceptedAt), r.data)
  r = await api(jane, 'GET', `/policies/${pol.id}/acceptances`)
  check('employees cannot see the acceptance list (403)', r.status === 403, r.status)
  r = await api(admin, 'POST', `/policies/${pol.id}/remind`)
  const reminder = await prisma.notification.findFirst({ where: { userId: janeUser.id, entityId: pol.id, type: 'policy.reminder' } })
  check('HR sends a reminder to everyone pending', r.status === 200 && r.body.reminded >= 1 && !!reminder, r.data)

  // ─── Targeting & info-only ─────────────────────────────────
  const unit = await prisma.orgUnit.create({ data: { tenantId: admin.tenantId, name: `Drivers ${TAG}`, type: 'team' } })
  r = await api(admin, 'POST', '/policies', { title: `Driving ${TAG}`, body: 'Licence on you at all times.', departmentIds: [unit.id] })
  made.push(r.body?.id)
  await api(admin, 'POST', `/policies/${r.body.id}/publish`, {})
  check('a policy for another team is invisible to Jane', !(await mine(jane)).some((x) => x.id === r.body.id))
  const targeted = r.body.id
  r = await api(jane, 'POST', `/policies/${targeted}/accept`)
  check('…and cannot be accepted by her (404)', r.status === 404, r.status)
  r = await api(admin, 'POST', '/policies', { title: `Info ${TAG}`, body: 'FYI', requiresAcceptance: false })
  made.push(r.body?.id)
  await api(admin, 'POST', `/policies/${r.body.id}/publish`, {})
  const info = (await mine(john)).find((x) => x.id === r.body.id)
  check('an info-only policy needs no acceptance', info?.status === 'info', info)
  r = await api(john, 'POST', `/policies/${info.id}/accept`)
  check('…and accepting it is refused (400)', r.status === 400, r.data)

  // ─── Isolation & archive ───────────────────────────────────
  const otherTenant = await prisma.tenant.findFirst({ where: { slug: { not: 'marichi-labs' }, active: true } })
  const foreign = await prisma.policy.create({ data: { tenantId: otherTenant.id, title: `Foreign ${TAG}`, createdById: admin.userId, versions: { create: { version: 1, body: 'x', status: 'published', publishedAt: new Date() } } } })
  r = await api(admin, 'GET', `/policies/${foreign.id}`)
  check("another company's policy is not found (404)", r.status === 404, r.status)
  r = await api(jane, 'POST', `/policies/${foreign.id}/accept`)
  check('…and cannot be accepted (404)', r.status === 404, r.status)
  for (const id of made.filter(Boolean)) await api(admin, 'POST', `/policies/${id}/archive`)
  check('archived policies disappear', !(await mine(jane)).some((x) => made.includes(x.id)))
  await prisma.policy.update({ where: { id: foreign.id }, data: { active: false } })
  await prisma.orgUnit.update({ where: { id: unit.id }, data: { active: false } })
  await done()
})()

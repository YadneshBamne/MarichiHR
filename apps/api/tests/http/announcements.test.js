// Announcements: HR publishes; audience targeting by department/office; scheduled publishing via the events sweep;
// read and acknowledge tracking; expiry; notifications; tenant isolation. Archives everything it creates.
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `an${Date.now() % 1e6}`
const later = (min) => new Date(Date.now() + min * 60_000).toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const admin = await tokenFor('admin@marichihr.com')
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const finance = await tokenFor('finance@marichihr.com')
  const made = []
  const post = async (body) => { const r = await api(admin, 'POST', '/announcements', body); if (r.body?.id) made.push(r.body.id); return r }
  const feed = async (who) => (await api(who, 'GET', '/announcements')).body || []

  let r = await api(jane, 'POST', '/announcements', { title: 'x', body: 'y' })
  check('an employee cannot publish (403)', r.status === 403, r.status)
  r = await post({ title: `Bad ${TAG}`, body: 'x', publishAt: later(60), expiresAt: later(30) })
  check('an end before the publish time is refused (400)', r.status === 400, r.data)
  r = await post({ title: `T ${TAG}`, body: 'x', departmentIds: ['00000000-0000-0000-0000-000000000000'] })
  check('an unknown department is refused (404)', r.status === 404, r.data)

  // ─── Everyone ──────────────────────────────────────────────
  r = await post({ title: `All hands ${TAG}`, body: 'Friday 4pm in the big room.\nBring questions.', pinned: true, requiresAck: true })
  const all = r.body
  check('HR publishes to everyone', r.status === 201 && all.id, r.data)
  let f = await feed(jane)
  const janeAll = f.find((a) => a.id === all.id)
  check('employee sees it, pinned, unread, needing acknowledgement', janeAll?.pinned && !janeAll.read && janeAll.requiresAck && !janeAll.acknowledged, janeAll)
  check('a login without an employee record sees company-wide news', (await feed(finance)).some((a) => a.id === all.id))
  const before = (await api(jane, 'GET', '/dashboard/counts')).body.announcements
  check('sidebar count includes it', before >= 1, before)

  // notification reaches Jane (via the event worker)
  let note = null
  for (let i = 0; i < 15 && !note; i++) { await sleep(1000); note = await prisma.notification.findFirst({ where: { userId: (await prisma.user.findFirst({ where: { email: 'jane.mutale@marichihr.com' } })).id, entityId: all.id } }) }
  check('the audience gets a notification', !!note && note.type === 'announcement', note)
  check('the author does not notify themselves', !(await prisma.notification.findFirst({ where: { userId: admin.userId, entityId: all.id } })))

  // ─── Read & acknowledge ────────────────────────────────────
  r = await api(jane, 'POST', `/announcements/${all.id}/read`, {})
  check('opening marks it read', r.status === 200 && r.body.read && !r.body.acknowledged, r.data)
  r = await api(jane, 'POST', `/announcements/${all.id}/read`, { acknowledge: true })
  check('employee acknowledges', r.status === 200 && r.body.acknowledged, r.data)
  const after = (await api(jane, 'GET', '/dashboard/counts')).body.announcements
  check('sidebar count goes down once read and acknowledged', after === before - 1, { before, after })
  r = await api(admin, 'GET', `/announcements/${all.id}/readers`)
  check("HR sees Jane read and acknowledged it", r.status === 200 && r.body.some((x) => x.userId === jane.userId && x.readAt && x.acknowledgedAt), r.data)
  r = await api(jane, 'GET', `/announcements/${all.id}/readers`)
  check('employees cannot see who read it (403)', r.status === 403, r.status)

  // ─── Targeting ─────────────────────────────────────────────
  const janeEmp = await prisma.employee.findUnique({ where: { id: jane.employeeId }, select: { orgUnitId: true } })
  const otherUnit = await prisma.orgUnit.create({ data: { tenantId: admin.tenantId, name: `Elsewhere ${TAG}`, type: 'team' } })
  r = await post({ title: `Other team ${TAG}`, body: 'x', departmentIds: [otherUnit.id] })
  const other = r.body
  r = await post({ title: `Jane team ${TAG}`, body: 'x', departmentIds: [janeEmp.orgUnitId], requiresAck: false })
  const mine = r.body
  f = await feed(jane)
  check("a department-targeted post reaches that department only", f.some((a) => a.id === mine.id) && !f.some((a) => a.id === other.id))
  r = await api(jane, 'POST', `/announcements/${other.id}/read`, {})
  check("outside the audience it can't even be marked read (404)", r.status === 404, r.status)
  r = await api(jane, 'POST', `/announcements/${mine.id}/read`, { acknowledge: true })
  check('acknowledging one that does not ask for it is refused (400)', r.status === 400, r.data)
  check('finance (no department) does not see department-targeted news', !(await feed(finance)).some((a) => a.id === mine.id))
  r = await api(admin, 'GET', '/announcements/manage')
  const m = r.body?.find((x) => x.id === other.id)
  check('manage view: a team with nobody in it has an audience of 0', m && m.audience === 0, m)

  // ─── Scheduling & expiry ───────────────────────────────────
  r = await post({ title: `Later ${TAG}`, body: 'x', publishAt: later(120) })
  const sched = r.body
  check('scheduled news is not in the feed yet', !(await feed(jane)).some((a) => a.id === sched.id))
  check('manage view shows it as scheduled', (await api(admin, 'GET', '/announcements/manage')).body.find((x) => x.id === sched.id)?.status === 'scheduled')
  await prisma.announcement.update({ where: { id: sched.id }, data: { publishAt: new Date(Date.now() - 1000) } })
  r = await api(admin, 'POST', '/system/jobs/events-sweep/run')
  const s = await prisma.announcement.findUnique({ where: { id: sched.id } })
  check('the events sweep publishes it once its time comes', r.status === 200 && !!s.notifiedAt, { status: r.status, notifiedAt: s.notifiedAt })
  check('…and it appears in the feed', (await feed(jane)).some((a) => a.id === sched.id))
  r = await api(admin, 'PATCH', `/announcements/${sched.id}`, { publishAt: later(10) })
  check('the publish time of a published one cannot change (400)', r.status === 400, r.data)
  await prisma.announcement.update({ where: { id: mine.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
  check('expired news leaves the feed', !(await feed(jane)).some((a) => a.id === mine.id))

  // ─── Edit, archive, isolation ──────────────────────────────
  r = await api(admin, 'PATCH', `/announcements/${all.id}`, { title: `All hands moved ${TAG}`, pinned: false })
  check('HR edits it', r.status === 200 && r.body.title === `All hands moved ${TAG}` && !r.body.pinned, r.data)
  const otherTenant = await prisma.tenant.findFirst({ where: { slug: { not: 'marichi-labs' }, active: true } })
  const foreign = await prisma.announcement.create({ data: { tenantId: otherTenant.id, title: `Foreign ${TAG}`, body: 'x', createdById: admin.userId } })
  r = await api(admin, 'PATCH', `/announcements/${foreign.id}`, { title: 'hijack' })
  check("another company's announcement cannot be edited (404)", r.status === 404, r.status)
  r = await api(jane, 'POST', `/announcements/${foreign.id}/read`, {})
  check("…or read (404)", r.status === 404, r.status)
  check("…and never shows in this company's feed", !(await feed(jane)).some((a) => a.id === foreign.id))

  for (const id of made) await api(admin, 'POST', `/announcements/${id}/archive`)
  check('archived news disappears', !(await feed(jane)).some((a) => made.includes(a.id)))
  await prisma.announcement.update({ where: { id: foreign.id }, data: { active: false } })
  await prisma.orgUnit.update({ where: { id: otherUnit.id }, data: { active: false } })
  await done()
})()

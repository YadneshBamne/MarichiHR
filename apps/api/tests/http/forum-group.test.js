// Community: team spaces scoped to the reporting line and moderated by the manager, blocked words, tags and follows,
// attachments, events with RSVPs, moderation notices, analytics, news posted when a policy is published.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `fg${Date.now() % 1e7}`
const BASE = (process.env.API_URL || 'http://localhost:4000') + '/api/v1'
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `ForG ${TAG}`, fullName: 'Hal Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const hr = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  const as = (emp, roleIds = ['employee']) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, managerId) => {
    const x = await api(hr, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time', ...(managerId && { managerId }) })
    const id = (x.body.employee ?? x.body).id
    await api(hr, 'PUT', `/employees/${id}/access`, { roles: ['employee'], password: 'generate', loginEnabled: true })
    return prisma.employee.findUnique({ where: { id } })
  }
  const mgr = await add('Maya'), e1 = await add('Eli', mgr.id), out = await add('Otto')
  const asM = as(mgr, ['employee', 'manager']), asE = as(e1), asO = as(out)
  const general = (await api(asE, 'GET', '/forums/spaces')).body.find((s) => s.name === 'General')
  const note = (userId, type) => prisma.notification.findFirst({ where: { tenantId: tenant.id, userId, type }, orderBy: { createdAt: 'desc' } })

  // ─── Team space ─────────────────────────────────────────
  r = await api(asO, 'POST', '/forums/spaces', { name: 'Otto team', kind: 'team' })
  check('someone who is not a manager cannot make a team space (403)', r.status === 403, r.status)
  r = await api(asM, 'POST', '/forums/spaces', { name: 'Maya team', kind: 'team' })
  const team = r.body
  check('a manager makes a space for their team and moderates it', r.status === 201 && team.kind === 'team' && team.moderatorUserIds.includes(mgr.userId), r.data)
  r = await api(asM, 'POST', '/forums/spaces', { name: 'Maya team 2', kind: 'team' })
  check('one team space per manager (409)', r.status === 409, r.status)
  const sees = async (who) => (await api(who, 'GET', '/forums/spaces')).body.some((s) => s.id === team.id)
  check('her report sees it; someone outside her team does not', (await sees(asE)) && !(await sees(asO)), null)
  r = await api(asE, 'POST', '/forums/threads', { spaceId: team.id, title: 'Sprint retro notes', body: 'What went **well** and what did not.', tags: ['Retro', '#Team Notes'] })
  const tt = r.body
  check('Eli posts in the team space; tags are tidied', r.status === 201 && JSON.stringify(tt.tags) === JSON.stringify(['retro', 'team-notes']), r.data)
  r = await api(asO, 'GET', `/forums/threads/${tt.id}`)
  check('Otto cannot open a team thread (404)', r.status === 404, r.status)
  r = await api(asO, 'POST', `/forums/threads/${tt.id}/moderate`, { hidden: true })
  check('Otto cannot moderate it (403/404)', [403, 404].includes(r.status), r.status)
  r = await api(asM, 'POST', `/forums/threads/${tt.id}/moderate`, { hidden: true, reason: 'Moved to the wiki' })
  const hidden = await note(e1.userId, 'forum.moderated')
  check('the manager hides it and Eli is told why', r.status === 200 && hidden?.body === 'Moved to the wiki', hidden)
  await api(asM, 'POST', `/forums/threads/${tt.id}/moderate`, { hidden: false })

  // ─── Blocked words ──────────────────────────────────────
  r = await api(asE, 'PUT', '/forums/settings', { blockedWords: ['rubbish'] })
  check('only HR sets blocked words (403)', r.status === 403, r.status)
  await api(hr, 'PUT', '/forums/settings', { blockedWords: ['Rubbish'] })
  r = await api(asE, 'POST', '/forums/threads', { spaceId: general.id, title: 'Canteen', body: 'The food is RUBBISH today' })
  check('a post with a blocked word is refused, naming it (400)', r.status === 400 && /Rubbish/.test(r.data.message), r.data)
  r = await api(asE, 'POST', '/forums/threads', { spaceId: general.id, title: 'Canteen', body: 'Rubbishing aside, lunch was fine' })
  check('…but only the whole word', r.status === 201, r.data)

  // ─── Follows ────────────────────────────────────────────
  await api(asO, 'POST', '/forums/follows', { kind: 'tag', key: 'Travel', on: true })
  r = await api(asE, 'POST', '/forums/threads', { spaceId: general.id, title: 'Visa tips for Nairobi', body: 'Share yours', tags: ['travel'] })
  const travel = r.body
  const followed = await note(out.userId, 'forum.followed')
  check('Otto follows #travel and hears about the new thread', followed?.entityId === travel.id, followed)
  r = await api(asO, 'GET', '/forums/threads?feed=following')
  check('his Following feed has it (and not the canteen thread)', r.body.length === 1 && r.body[0].id === travel.id, r.body?.map((t) => t.title))

  // ─── Attachments ────────────────────────────────────────
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'board.png')
  const up = await fetch(`${BASE}/forums/attachments`, { method: 'POST', headers: { authorization: `Bearer ${asE.token}` }, body: fd })
  const att = (await up.json()).data
  if (up.status === 503) console.log('SKIP attachments: storage not configured')
  else {
    check('Eli uploads an image', up.status === 201 && att.mimeType === 'image/png', att)
    r = await api(asE, 'POST', `/forums/threads/${tt.id}/comments`, { body: 'Whiteboard photo attached', attachmentIds: [att.id] })
    check('…and attaches it to a reply in the team space', r.status === 201, r.data)
    r = await api(asO, 'POST', `/forums/threads/${travel.id}/comments`, { body: 'Stealing that file', attachmentIds: [att.id] })
    check('nobody else can attach someone else’s file (404)', r.status === 404, r.status)
    r = await api(asO, 'GET', `/forums/attachments/${att.id}`)
    check('Otto cannot download a file from the team space (404)', r.status === 404, r.status)
    r = await api(asM, 'GET', `/forums/attachments/${att.id}`)
    check('the manager can (signed link)', r.status === 200 && /^https?:/.test(r.body.url), r.status)
  }

  // ─── Events ─────────────────────────────────────────────
  const at = new Date(Date.now() + 7 * 86_400_000).toISOString()
  r = await api(asE, 'POST', '/forums/events', { title: 'Townhall', startsAt: at })
  check('only HR adds company events (403)', r.status === 403, r.status)
  r = await api(hr, 'POST', '/forums/events', { title: 'Q4 townhall', startsAt: at, location: 'Main hall', kind: 'townhall' })
  const ev = r.body
  check('HR adds a townhall and everyone is told', r.status === 201 && !!(await note(out.userId, 'forum.event')), r.data)
  r = await api(asM, 'POST', '/forums/events', { title: 'Team lunch', startsAt: at, spaceId: team.id, kind: 'celebration' })
  const lunch = r.body
  check('the manager adds a team lunch to the team space', r.status === 201, r.data)
  await api(asE, 'POST', `/forums/events/${ev.id}/rsvp`, { status: 'going' })
  const day = at.slice(0, 10)
  r = await api(asE, 'GET', `/forums/events?from=${day}&to=${day}`)
  check('Eli sees both; the townhall shows 1 going (him)', r.body.length === 2 && r.body.find((x) => x.id === ev.id).going === 1 && r.body.find((x) => x.id === ev.id).myRsvp === 'going', r.body)
  r = await api(asO, 'GET', `/forums/events?from=${day}&to=${day}`)
  check('Otto sees only the townhall', r.body.length === 1 && r.body[0].id === ev.id, r.body?.map((x) => x.title))
  r = await api(asO, 'POST', `/forums/events/${lunch.id}/rsvp`, { status: 'going' })
  check('…and cannot answer the team lunch (404)', r.status === 404, r.status)

  // ─── Reports and analytics ──────────────────────────────
  await api(asE, 'POST', '/forums/reports', { targetType: 'thread', targetId: travel.id, reason: 'Testing reports' })
  const rep = (await api(hr, 'GET', '/forums/reports')).body[0]
  await api(hr, 'POST', `/forums/reports/${rep.id}/resolve`, { hide: false })
  const thanks = await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId: e1.userId, type: 'forum.moderated', title: 'Thanks for your report' } })
  check('the reporter hears the outcome', !!thanks && /keep/.test(thanks.body), thanks)
  r = await api(asE, 'GET', '/forums/analytics')
  check('only HR sees Community analytics (403)', r.status === 403, r.status)
  r = await api(hr, 'GET', '/forums/analytics?days=30')
  check('HR sees threads, active people and top tags', r.status === 200 && r.body.threads >= 3 && r.body.activePeople >= 1 && r.body.topTags.some((t) => t.tag === 'travel'), r.body)

  // ─── News ───────────────────────────────────────────────
  const pol = (await api(hr, 'POST', '/policies', { title: 'Dress code', body: 'Smart casual.', requiresAcceptance: false })).body
  await api(hr, 'POST', `/policies/${pol.id}/publish`, {})
  let news = null
  for (let i = 0; i < 15 && !news; i++) { await sleep(1000); news = await prisma.forumThread.findFirst({ where: { tenantId: tenant.id, title: 'New policy: Dress code' } }) }
  const newsSpace = news && await prisma.forumSpace.findFirst({ where: { id: news.spaceId } })
  check('publishing a company-wide policy posts it in News', !!news && newsSpace.kind === 'news', news)
  r = await api(asE, 'POST', '/forums/threads', { spaceId: newsSpace?.id, title: 'My own news', body: 'hello' })
  check('only HR posts in News (403)', r.status === 403, r.status)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

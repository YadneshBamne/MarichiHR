// Goals & appraisal: cycles, a manager sets weighted KPIs, the person accepts or sends back, review → weighted % met.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `pf${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Perf ${TAG}`, fullName: 'Pia Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first) => { const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time' }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }
  const boss = await add('Boss'), lead = await add('Lead'), member = await add('Member'), other = await add('Other')
  await prisma.employee.update({ where: { id: lead.id }, data: { managerId: boss.id } })
  await prisma.employee.update({ where: { id: member.id }, data: { managerId: lead.id } })
  for (const e of [boss, lead, member, other]) if (!e.userId) { const u = await prisma.user.create({ data: { tenantId: tenant.id, email: `${e.id}@x.test` } }); await prisma.employee.update({ where: { id: e.id }, data: { userId: u.id } }); e.userId = u.id }
  const asLead = as(lead, ['employee', 'manager']), asMember = as(member, ['employee']), asOther = as(other, ['employee', 'manager'])

  // ─── Cycles ────────────────────────────────────────────────
  r = await api(asLead, 'POST', '/performance/cycles/this-year')
  check('only HR creates review cycles (403)', r.status === 403, r.status)
  r = await api(owner, 'POST', '/performance/cycles/this-year')
  check('HR adds this year’s four quarters and the full year in one click', r.status === 201 && r.body.created === 5, r.data)
  r = await api(owner, 'POST', '/performance/cycles/this-year')
  check('…once (nothing new the second time)', r.body.created === 0, r.body)
  r = await api(asMember, 'GET', '/performance/cycles')
  const q = r.body.find((c) => c.period === 'quarterly'), yearCycle = r.body.find((c) => c.period === 'yearly')
  check('everyone sees the cycles, quarterly and yearly', r.status === 200 && q && yearCycle && q.startDate.endsWith('-01'), r.body)

  // ─── Setting a goal ────────────────────────────────────────
  const kpis = [{ name: 'Revenue', target: 10000000, unit: 'ZMW', weight: 60 }, { name: 'New clients', target: 10, weight: 40 }]
  const goal = { cycleId: q.id, employeeId: member.id, title: 'Grow regional revenue', kpis }
  r = await api(asLead, 'POST', '/performance/goals', { ...goal, kpis: [{ ...kpis[0], weight: 50 }, kpis[1]] })
  check('KPI weights must add up to 100 (400)', r.status === 400, r.status)
  r = await api(asLead, 'POST', '/performance/goals', { ...goal, kpis: Array(6).fill({ name: 'KPI', target: 1, weight: 100 / 6 }) })
  check('…and there are at most 5 KPIs (400)', r.status === 400, r.status)
  r = await api(asOther, 'POST', '/performance/goals', goal)
  check('a manager from another line cannot set goals for this person (403)', r.status === 403, r.status)
  r = await api(asMember, 'POST', '/performance/goals', { ...goal, employeeId: member.id })
  check('nobody sets their own goal (403)', r.status === 403, r.status)
  r = await api(asLead, 'POST', '/performance/goals', goal)
  const g = r.body
  check('the direct manager sets a goal with weighted KPIs (as a draft)', r.status === 201 && g.status === 'draft' && g.kpis.length === 2, r.data)
  r = await api(asMember, 'GET', '/performance/goals?scope=mine')
  check('…the person sees it', r.body.some((x) => x.id === g.id), r.body)
  r = await api(asMember, 'POST', `/performance/goals/${g.id}/accept`)
  check('a draft cannot be accepted yet (400)', r.status === 400, r.status)
  r = await api(asLead, 'POST', `/performance/goals/${g.id}/send`)
  check('the manager sends it', r.status === 200, r.data)
  const n = await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId: member.userId, type: 'performance.goal.sent' } })
  check('…and the person gets a notification', !!n, n)

  // ─── Send back, edit, accept ───────────────────────────────
  r = await api(asMember, 'POST', `/performance/goals/${g.id}/return`, { note: 'Ten new clients is too many for one quarter' })
  check('the person sends it back with a note', r.status === 200 && r.body.status === 'returned', r.data)
  r = await api(asLead, 'PUT', `/performance/goals/${g.id}`, { title: goal.title, kpis: [kpis[0], { ...kpis[1], target: 6 }], send: true })
  check('the manager changes the target and sends it again', r.status === 200 && r.body.status === 'sent' && r.body.kpis[1].target === 6, r.data)
  r = await api(asLead, 'POST', `/performance/goals/${g.id}/accept`)
  check('only the person can accept their goal (403)', r.status === 403, r.status)
  r = await api(asMember, 'POST', `/performance/goals/${g.id}/accept`)
  check('the person accepts', r.status === 200 && r.body.status === 'accepted', r.data)
  r = await api(asLead, 'PUT', `/performance/goals/${g.id}`, { title: 'Changed', kpis })
  check('an agreed goal cannot be changed (400)', r.status === 400, r.status)

  // ─── Review ────────────────────────────────────────────────
  const [rev, cli] = (await api(asLead, 'GET', '/performance/goals?scope=team')).body.find((x) => x.id === g.id).kpis
  r = await api(as(boss, ['employee', 'manager']), 'GET', '/performance/goals?scope=team')
  check('the manager two levels up sees it under My team', r.body.some((x) => x.id === g.id), r.body?.length)
  r = await api(asLead, 'POST', `/performance/goals/${g.id}/review`, { achieved: { [rev.id]: 8000000 } })
  check('every KPI needs an achievement (400)', r.status === 400, r.data)
  // 60% × 80% + 40% × min(150%, 9/6) = 48 + 60 = 108
  r = await api(asLead, 'POST', `/performance/goals/${g.id}/review`, { achieved: { [rev.id]: 8000000, [cli.id]: 9 }, comment: 'Strong client growth' })
  check('the weighted result is the % of the expectation met (108%, Meets)', r.status === 200 && r.body.score === 108 && r.body.rating === 'Meets expectations', r.body)
  r = await api(asMember, 'POST', `/performance/goals/${g.id}/acknowledge`, { comment: 'Thanks' })
  check('the person acknowledges the review', r.status === 200 && r.body.status === 'acknowledged', r.data)
  r = await api(asOther, 'GET', '/performance/goals?scope=all')
  check('only HR sees everyone’s goals (403)', r.status === 403, r.status)
  r = await api(owner, 'GET', `/performance/goals?scope=all&cycleId=${q.id}`)
  check('HR sees it with the score', r.body.some((x) => x.id === g.id && x.score === 108 && x.status === 'acknowledged'), r.body)
  const audits = await prisma.auditLog.count({ where: { tenantId: tenant.id, entityType: 'performance_goal', entityId: g.id } })
  check('each step is in the audit log', audits >= 6, audits)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

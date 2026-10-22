// Compensation review cycles: budgets per manager, recommendations with totals only, small teams hidden, Payroll
// approves and applies as salary revisions; manager team cost (totals only).
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `cr${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Review ${TAG}`, fullName: 'Rae Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { primaryCountry: 'ZM', baseCurrency: 'ZMW', modules: { set: [...new Set([...(tenant.modules ?? []), 'payroll'])] } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, managerId) => { const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time', ...(managerId && { managerId }) }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }
  const p1 = await add('Payone'), p2 = await add('Paytwo'), mgr = await add('Mona'), solo = await add('Sol')
  const [a, b, c] = [await add('Ann', mgr.id), await add('Ben', mgr.id), await add('Cat', mgr.id)]
  const d = await add('Dan', solo.id)
  const asP1 = as(p1, ['employee', 'payroll_admin']), asP2 = as(p2, ['employee', 'payroll_admin']), asMgr = as(mgr, ['employee', 'manager']), asSolo = as(solo, ['employee', 'manager'])

  const structure = (await api(asP1, 'POST', '/salary/structures/starter')).body
  const wages = { [a.id]: 10000, [b.id]: 20000, [c.id]: 30000, [d.id]: 15000 }
  for (const [id, wage] of Object.entries(wages)) {
    const k = await api(asP1, 'POST', '/leave/contracts', { employeeId: id, ctcAnnual: wage * 12, wageMonthly: wage, currency: 'ZMW', effectiveFrom: '2025-01-06', salaryStructureId: structure.id })
    for (const s of ['draft', 'confirm', 'activate']) await api(asP1, 'POST', `/leave/contracts/${k.body.id}/${s}`, {})
  }

  // ─── Cycle ────────────────────────────────────────────────
  r = await api(asMgr, 'POST', '/comp-reviews', { name: `FY ${TAG}`, effectiveFrom: '2027-01-01', budgetPercent: 5 })
  check('only Payroll opens a review (403)', r.status === 403, r.status)
  r = await api(asP1, 'POST', '/comp-reviews', { name: `FY ${TAG}`, effectiveFrom: '2027-01-15', budgetPercent: 5 })
  check('a review starts on the 1st of a month (400)', r.status === 400, r.status)
  r = await api(asP1, 'POST', '/comp-reviews', { name: `FY ${TAG}`, effectiveFrom: '2027-01-01', budgetPercent: 5 })
  const cycle = r.body
  check('Payroll opens a 5% review', r.status === 201, r.data)

  // ─── Manager sees totals only ─────────────────────────────
  r = await api(asMgr, 'GET', `/comp-reviews/${cycle.id}/my-team`)
  const team = r.body
  check('the manager sees her three reports', r.status === 200 && team.people.length === 3, r.data)
  check('…but no one\'s salary', !JSON.stringify(team.people).match(/120000|240000|360000|10000|20000|30000/), team.people)
  check('…and the team totals: budget is 5% of 720,000 = 36,000', team.totals.totalAnnualCtc === 720000 && team.totals.budget === 36000 && team.totals.hiddenBecauseSmallTeam === false, team.totals)
  r = await api(asSolo, 'GET', `/comp-reviews/${cycle.id}/my-team`)
  check('a one-person team sees no amounts (they would reveal the salary)', r.body.totals.hiddenBecauseSmallTeam === true && r.body.totals.budget === null && r.body.totals.totalAnnualCtc === null, r.body.totals)
  r = await api(asMgr, 'POST', `/comp-reviews/${cycle.id}/recommend`, { items: [{ employeeId: d.id, increasePercent: 10 }] })
  check('a manager recommends only for their own reports (403)', r.status === 403, r.status)
  r = await api(asMgr, 'POST', `/comp-reviews/${cycle.id}/recommend`, { items: [{ employeeId: a.id, increasePercent: 10 }, { employeeId: b.id, increasePercent: 5 }, { employeeId: c.id, increasePercent: 3, note: 'Steady' }] })
  // used = 120000*10% + 240000*5% + 360000*3% = 12000 + 12000 + 10800 = 34800 of 36000
  check('she recommends; the budget used shows as a total and a share', r.status === 200 && r.body.totals.used === 34800 && r.body.totals.usedOfBudgetPercent === 96.67 && !r.body.totals.overBudget, r.body?.totals)
  r = await api(asMgr, 'POST', `/comp-reviews/${cycle.id}/recommend`, { items: [{ employeeId: c.id, increasePercent: 8 }] })
  check('going over budget is flagged', r.body.totals.overBudget === true, r.body?.totals)
  await api(asMgr, 'POST', `/comp-reviews/${cycle.id}/recommend`, { items: [{ employeeId: c.id, increasePercent: 3 }] })

  // ─── Payroll decides and applies ──────────────────────────
  r = await api(asMgr, 'GET', `/comp-reviews/${cycle.id}/review`)
  check('managers cannot open the Payroll review (403)', r.status === 403, r.status)
  r = await api(asP1, 'GET', `/comp-reviews/${cycle.id}/review`)
  const recs = r.body.recommendations
  const recOf = (id) => recs.find((x) => x.employeeId === id)
  check('Payroll sees each recommendation with current and proposed pay', recOf(a.id).currentCtc === 120000 && recOf(a.id).proposedCtc === 132000, recOf(a.id))
  check('…and the manager budget', r.body.budgets.some((x) => x.managerEmployeeId === mgr.id && x.budget === 36000 && x.used === 34800), r.body.budgets)
  await api(asP1, 'POST', `/comp-reviews/recommendations/${recOf(a.id).id}/decide`, { approve: true })
  await api(asP1, 'POST', `/comp-reviews/recommendations/${recOf(b.id).id}/decide`, { approve: true })
  r = await api(asP1, 'POST', `/comp-reviews/recommendations/${recOf(c.id).id}/decide`, { approve: false })
  check('Payroll approves two and rejects one', r.status === 200 && r.body.status === 'rejected', r.data)
  r = await api(asP1, 'POST', `/comp-reviews/${cycle.id}/apply`)
  check('applying turns approved ones into salary revisions', r.status === 200 && r.body.revisions === 2, r.data)
  const revs = await prisma.salaryRevision.findMany({ where: { tenantId: tenant.id, status: 'pending' } })
  check('…pending, waiting for a second Payroll admin, at the new pay from the review date', revs.length === 2 && revs.some((x) => x.employeeId === a.id && Number(x.newWageMonthly) === 11000 && x.effectiveFrom.toISOString().startsWith('2027-01-01') && x.requestedBy === p1.userId), revs.map((x) => [Number(x.newWageMonthly), x.requestedBy]))
  r = await api(asMgr, 'POST', `/comp-reviews/${cycle.id}/recommend`, { items: [{ employeeId: a.id, increasePercent: 1 }] })
  check('an applied review is closed to new recommendations (400)', r.status === 400, r.status)

  // ─── Team cost ────────────────────────────────────────────
  r = await api(asMgr, 'GET', '/comp-reviews/team-cost')
  check('the manager sees her team cost as totals', r.status === 200 && r.body.withContract === 3 && r.body.annualCtc === 720000 && r.body.monthlyWages === 60000, r.body)
  r = await api(asSolo, 'GET', '/comp-reviews/team-cost')
  check('a one-person team cost is hidden', r.body.hiddenBecauseSmallTeam === true && r.body.annualCtc === null, r.body)
  r = await api(as(a, ['employee']), 'GET', '/comp-reviews/team-cost')
  check('employees have no team cost (403)', r.status === 403, r.status)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

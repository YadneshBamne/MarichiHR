// Incentives: manager budgets (blocked over budget, 80% alert), schemes with formulas (and their working shown),
// ratings -> suggested variable pay (Payroll only, no salary in the working), kudos points (earn, farm limit, redeem,
// refund on rejection, leaderboard).
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `ig${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `IncG ${TAG}`, fullName: 'Olu Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { modules: { set: [...new Set([...(tenant.modules ?? []), 'payroll'])] } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, managerId) => {
    const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time', ...(managerId && { managerId }) })
    const e = await prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } })
    await api(owner, 'PUT', `/employees/${e.id}/access`, { roles: ['employee'], password: 'generate', loginEnabled: true })
    return prisma.employee.findUnique({ where: { id: e.id } })
  }
  const mgr = await add('Mulenga'), hr2 = await add('Hana'), pay = await add('Pita')
  const e1 = await add('Ellen', mgr.id), e2 = await add('Emeka', mgr.id)
  const asM = as(mgr, ['employee', 'manager']), asHR2 = as(hr2, ['employee', 'hr_admin']), asP = as(pay, ['employee', 'payroll_admin']), asE1 = as(e1, ['employee']), asE2 = as(e2, ['employee'])
  const types = (await api(owner, 'GET', '/incentives/types')).body
  const spot = types.find((t) => t.code === 'SPOT')

  // ─── Budgets ────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10)
  r = await api(asM, 'POST', '/incentives/budgets', { managerEmployeeId: mgr.id, periodStart: `${today.slice(0, 7)}-01`, periodEnd: '2099-12-31', amount: 1000 })
  check('a manager cannot set their own budget (403)', r.status === 403, r.status)
  r = await api(owner, 'POST', '/incentives/budgets', { managerEmployeeId: mgr.id, periodStart: `${today.slice(0, 7)}-01`, periodEnd: '2099-12-31', amount: 1000 })
  check('HR gives the manager a 1,000 budget', r.status === 201, r.data)
  r = await api(asM, 'POST', '/incentives', { employeeId: e1.id, typeId: spot.id, amount: 600, reason: 'Closed the big deal' })
  check('the manager nominates 600 (60%)', r.status === 201, r.data)
  r = await api(asM, 'POST', '/incentives', { employeeId: e2.id, typeId: spot.id, amount: 300, reason: 'Covered the night shift' })
  const alert = await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId: mgr.userId, type: 'incentive.budget_alert' } })
  check('at 90% the manager (and HR) get the 80% alert', r.status === 201 && !!alert && /80%/.test(alert.title), alert?.title)
  r = await api(asM, 'POST', '/incentives', { employeeId: e1.id, typeId: spot.id, amount: 200, reason: 'Another great week' })
  check('going over the budget is refused, saying what is left (100)', r.status === 400 && /100 left/.test(r.data.message), r.data)
  r = await api(asM, 'GET', '/incentives/budgets')
  check('the manager sees the budget: 900 used, 100 left, 90%', r.body.length === 1 && r.body[0].used === 900 && r.body[0].left === 100 && r.body[0].pct === 90, r.body)

  // ─── Schemes ────────────────────────────────────────────
  r = await api(owner, 'POST', '/incentives/schemes', { name: 'Sales commission', kind: 'commission', formula: 'max(0, sales - target) *', variables: [{ key: 'sales', label: 'Sales' }, { key: 'target', label: 'Target' }], typeId: spot.id })
  check('a broken formula is refused (400)', r.status === 400, r.data)
  r = await api(owner, 'POST', '/incentives/schemes', { name: 'Sales commission', kind: 'commission', formula: 'max(0, sales - target) * 0.05', variables: [{ key: 'sales', label: 'Sales' }, { key: 'target', label: 'Target' }], typeId: spot.id })
  const scheme = r.body
  check('HR builds a commission scheme: 5% above target', r.status === 201, r.data)
  const rows = [{ employeeId: e1.id, values: { sales: 100000, target: 60000 } }, { employeeId: e2.id, values: { sales: 50000, target: 60000 } }]
  r = await api(owner, 'POST', `/incentives/schemes/${scheme.id}/run`, { period: 'October 2026', rows, dryRun: true })
  check('a dry run shows 2,000 for Ellen and nothing earned for Emeka, creating nothing', r.body.created === 0 && r.body.rows[0].amount === 2000 && r.body.rows[1].skipped === 'nothing earned', r.body)
  r = await api(owner, 'POST', `/incentives/schemes/${scheme.id}/run`, { period: 'October 2026', rows })
  check('the run creates one nomination', r.body.created === 1, r.body)
  const commission = await prisma.incentive.findFirst({ where: { tenantId: tenant.id, schemeId: scheme.id } })
  r = await api(asHR2, 'POST', `/incentives/${commission.id}/approve`, {})
  r = await api(asE1, 'GET', '/incentives')
  const mine = r.body.find((i) => i.id === commission.id)
  check('Ellen sees why: the formula with her sales and target', !!mine && /Sales 100000/.test(mine.formula) && /Target 60000/.test(mine.formula), mine?.formula)

  // ─── Ratings -> variable pay ────────────────────────────
  const structure = (await api(asP, 'POST', '/salary/structures/starter')).body
  const k = await api(asP, 'POST', '/leave/contracts', { employeeId: e1.id, ctcAnnual: 120000, wageMonthly: 10000, currency: tenant.baseCurrency, effectiveFrom: '2025-01-06', salaryStructureId: structure.id, variablePayPercent: 10 })
  for (const s of ['draft', 'confirm', 'activate']) await api(asP, 'POST', `/leave/contracts/${k.body.id}/${s}`, {})
  await prisma.employeeContract.update({ where: { id: k.body.id }, data: { variablePayPercent: 10 } })
  const pc = await prisma.performanceCycle.create({ data: { tenantId: tenant.id, name: `Q3 ${TAG}`, period: 'quarterly', startDate: new Date('2026-07-01'), endDate: new Date('2026-09-30'), createdBy: owner.token.slice(0, 8) } })
  await prisma.performanceGoal.create({ data: { tenantId: tenant.id, cycleId: pc.id, employeeId: e1.id, setByUserId: mgr.userId, title: 'Grow sales', status: 'reviewed', score: 115, rating: 'Exceeds expectations' } })
  r = await api(owner, 'GET', `/incentives/ratings/${pc.id}`)
  check('HR cannot see rating-based pay suggestions (they read salaries) (403)', r.status === 403, r.status)
  r = await api(asP, 'GET', `/incentives/ratings/${pc.id}`)
  const sug = r.body?.find((x) => x.employeeId === e1.id)
  check('Payroll sees Ellen: Exceeds expectations, 120% of 3,000 variable pay = 3,600', sug?.rating === 'Exceeds expectations' && sug.variablePay === 3000 && sug.suggested === 3600, sug)
  r = await api(asP, 'POST', `/incentives/ratings/${pc.id}/nominate`, { employeeIds: [e1.id] })
  const vp = await prisma.incentive.findFirst({ where: { tenantId: tenant.id, reason: { startsWith: 'Variable pay' } } })
  check('it becomes a nomination whose working names the rating, never the salary', r.body.created === 1 && Number(vp.amount) === 3600 && /120%/.test(vp.formula) && !/120000|120,000|3,000|3000/.test(vp.formula), vp?.formula)

  // ─── Kudos points ───────────────────────────────────────
  await api(owner, 'PUT', '/incentives/settings', { kudosPoints: 60, minRedeem: 50, pointValue: 2 })
  await api(asE2, 'POST', '/forums/kudos', { toEmployeeId: e1.id, badge: 'teamwork', message: 'Thanks for the handover' })
  await api(asE2, 'POST', '/forums/kudos', { toEmployeeId: e1.id, badge: 'teamwork', message: 'And again, thanks!' })
  await api(asM, 'POST', '/forums/kudos', { toEmployeeId: e1.id, badge: 'leadership', message: 'Great leadership this week' })
  r = await api(asE1, 'GET', '/incentives/points')
  check('Ellen has 120 points: the second kudos from the same person within 30 days earns none', r.body.balance === 120, r.body)
  r = await api(asE1, 'POST', '/incentives/points/redeem', { points: 20 })
  check('redeeming below the minimum is refused (400)', r.status === 400, r.data)
  r = await api(asE1, 'POST', '/incentives/points/redeem', { points: 100 })
  const red = r.body
  check('she redeems 100 points = 200 (2 per point), waiting for HR', r.status === 201 && red.amount === 200, r.data)
  r = await api(asE1, 'GET', '/incentives/points')
  check('20 points left', r.body.balance === 20, r.body.balance)
  r = await api(asHR2, 'POST', `/incentives/${red.incentiveId}/reject`, { note: 'Redeem at year end please' })
  r = await api(asE1, 'GET', '/incentives/points')
  check('HR rejects it and the points come back', r.body.balance === 120, r.body.balance)
  r = await api(asE2, 'GET', '/incentives/points/leaderboard')
  check('the leaderboard shows Ellen first', r.body[0]?.employeeId === e1.id && r.body[0].points === 120, r.body)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

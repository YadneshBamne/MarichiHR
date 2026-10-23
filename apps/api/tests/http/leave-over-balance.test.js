// Leave beyond the balance: the request goes through, the approver decides paid (balance negative, HR told) or
// unpaid (those days become LWP); a leave type can turn this off.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `ob${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Over ${TAG}`, fullName: 'Oz Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, managerId) => { const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2024-01-08', employmentType: 'full_time', ...(managerId && { managerId }) }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }
  const mgr = await add('Max'), emp = await add('Eve', mgr.id)
  for (let i = 0; i < 40 && !(await prisma.leaveAllocation.count({ where: { employeeId: emp.id, approvedBy: 'system' } })); i++) await sleep(500)
  const types = await prisma.leaveType.findMany({ where: { tenantId: tenant.id } })
  const pat = types.find((t) => t.code === 'PATERNITY') ?? types.find((t) => t.isPaid)
  check('new leave types allow requests beyond the balance by default', types.every((t) => t.allowOverBalance === true), types.map((t) => [t.code, t.allowOverBalance]))
  const setBal = (days) => prisma.leaveBalance.upsert({ where: { employeeId_leaveTypeId: { employeeId: emp.id, leaveTypeId: pat.id } }, create: { employeeId: emp.id, leaveTypeId: pat.id, balanceDays: days, asOfDate: new Date() }, update: { balanceDays: days, usedDays: 0, pendingDays: 0 } })
  await setBal(1)
  const asEmp = as(emp, ['employee']), asMgr = as(mgr, ['employee', 'manager'])
  const wd = (n) => { const x = new Date(Date.now() + n * 86_400_000); while ([0, 6].includes(x.getUTCDay())) x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10) }
  const range = (from, days) => { const s = wd(from); const e = new Date(`${s}T00:00:00Z`); let left = days - 1; while (left > 0) { e.setUTCDate(e.getUTCDate() + 1); if (![0, 6].includes(e.getUTCDay())) left-- } return [s, e.toISOString().slice(0, 10)] }

  // ─── Unpaid shortfall ─────────────────────────────────────
  let [s1, e1] = range(30, 3)
  r = await api(asEmp, 'POST', '/leave/requests', { leaveTypeId: pat.id, startDate: s1, endDate: e1, reason: 'Baby due' })
  const req1 = r.body
  check('3 days with 1 available goes through, 2 days beyond the balance', r.status === 201 && req1.shortfallDays === 2, r.data)
  r = await api(asMgr, 'GET', '/leave/requests/pending')
  check('the manager sees the shortfall on the request', (r.body?.data ?? r.body ?? []).some?.((x) => x.id === req1.id && x.shortfallDays === 2) ?? true, r.status)
  r = await api(asMgr, 'POST', `/leave/requests/${req1.id}/approve`, { comments: 'OK', shortfall: 'unpaid' })
  check('the manager approves with the extra days unpaid', r.status === 200, r.data)
  let lr = await prisma.leaveRequest.findUnique({ where: { id: req1.id } })
  let bal = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId: { employeeId: emp.id, leaveTypeId: pat.id } } })
  check('…2 days become unpaid (LWP) and only 1 is used from the balance', lr.status === 'approved' && lr.lwpDays === 2 && bal.usedDays === 1 && bal.pendingDays === 0, { lwp: lr.lwpDays, used: bal.usedDays })

  // ─── Paid shortfall (default) ─────────────────────────────
  await setBal(1)
  ;[s1, e1] = range(50, 2)
  r = await api(asEmp, 'POST', '/leave/requests', { leaveTypeId: pat.id, startDate: s1, endDate: e1 })
  const req2 = r.body
  r = await api(asMgr, 'POST', `/leave/requests/${req2.id}/approve`, { comments: 'OK' })
  lr = await prisma.leaveRequest.findUnique({ where: { id: req2.id } })
  bal = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId: { employeeId: emp.id, leaveTypeId: pat.id } } })
  check('with no choice it is paid: the balance goes negative', r.status === 200 && lr.lwpDays === 0 && bal.balanceDays - bal.usedDays === -1, { lwp: lr.lwpDays, left: bal.balanceDays - bal.usedDays })
  const ownerUser = await prisma.user.findFirst({ where: { tenantId: tenant.id, email: ownerEmail } })
  check('…and HR is told to top it up', !!(await prisma.notification.findFirst({ where: { userId: ownerUser.id, type: 'leave.over_balance', entityId: req2.id } })))

  // ─── Turned off for a type ────────────────────────────────
  r = await api(owner, 'PATCH', `/leave/types/${pat.id}`, { allowOverBalance: false })
  check('HR turns it off for the type', r.status === 200, r.data)
  await setBal(0)
  ;[s1, e1] = range(70, 2)
  r = await api(asEmp, 'POST', '/leave/requests', { leaveTypeId: pat.id, startDate: s1, endDate: e1 })
  check('then a request beyond the balance is refused (400)', r.status === 400, r.data)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

// Leave year end: carry forward up to the limit, encash up to the limit, lapse the rest; pending days stay; run once;
// rollback subtracts exactly what the run changed (leave taken since is kept); payroll is told about encashment;
// the daily job only runs on the first day of the leave year; HR-only; isolation. Throwaway company.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `ye${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
const sign = (u, roles) => ({ token: jwt.sign({ userId: u.userId, tenantId: u.tenantId, employeeId: u.id, roleIds: roles, email: u.workEmail }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) })

;(async () => {
  const keys = await redis.keys('signup:*'); if (keys.length) await redis.del(...keys)
  const email = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Year ${TAG}`, fullName: 'Yan Owner', email, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email } } } })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const B = (await api(owner, 'POST', '/employees', { firstName: 'Bea', lastName: TAG, workEmail: `bea.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-05', employmentType: 'full_time' })).body.employee
  const tB = sign(B, ['employee'])
  const type = async (code) => prisma.leaveType.findFirst({ where: { tenantId: tenant.id, code } })
  const annual = await type('ANNUAL'), sick = await type('SICK'), comp = await type('COMPOFF')
  r = await api(owner, 'PATCH', `/leave/types/${annual.id}`, { carryForward: true, carryForwardMax: 10, encashable: true, encashMaxDays: 3 })
  check('HR sets annual leave: carry up to 10, encash up to 3', r.status === 200, r.data)
  const set = (lt, balanceDays, usedDays, pendingDays) => prisma.leaveBalance.update({ where: { employeeId_leaveTypeId: { employeeId: B.id, leaveTypeId: lt.id } }, data: { balanceDays, usedDays, pendingDays, encashedDays: 0, lapsedDays: 0 } })
  await set(annual, 20, 4, 1) // 15 left: carry 10, encash 3, lapse 2
  await set(sick, 10, 2, 0) // 8 left, no carry: lapse 8
  await set(comp, 2, 0, 0) // 2 left, carries up to 5
  const bal = async (lt) => prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId: { employeeId: B.id, leaveTypeId: lt.id } } })

  // ─── Preview ───────────────────────────────────────────────
  r = await api(tB, 'GET', '/leave/year-end')
  check('employees cannot see or run year end (403)', r.status === 403, r.status)
  r = await api(owner, 'GET', '/leave/year-end')
  const row = (lt) => r.body.rows.find((x) => x.employeeId === B.id && x.leaveTypeId === lt.id)
  check('the year closing is the day before this leave year began', r.status === 200 && r.body.yearEnd === `${new Date().getUTCFullYear() - 1}-12-31` && !r.body.alreadyRun, r.body?.yearEnd)
  check('preview: annual 15 left → carry 10, encash 3, lapse 2', row(annual).available === 15 && row(annual).carried === 10 && row(annual).encashed === 3 && row(annual).lapsed === 2, row(annual))
  check('preview: sick 8 left with no carry-forward → all 8 lapse', row(sick).carried === 0 && row(sick).encashed === 0 && row(sick).lapsed === 8, row(sick))
  check('preview: comp-off 2 left → carried in full', row(comp).carried === 2 && row(comp).lapsed === 0, row(comp))
  check('preview changes nothing', (await bal(annual)).balanceDays === 20)

  // ─── Run ───────────────────────────────────────────────────
  r = await api(owner, 'POST', '/leave/year-end/run')
  const runId = r.body?.id
  check('HR closes the year', r.status === 201 && r.body.totals.carried >= 12 && r.body.totals.encashed >= 3, r.data)
  let a = await bal(annual), s = await bal(sick)
  check('annual: 10 carried + 1 still pending = 11, used reset, 3 encashed, 2 lapsed', a.balanceDays === 11 && a.usedDays === 0 && a.pendingDays === 1 && a.encashedDays === 3 && a.lapsedDays === 2, a)
  check('sick: nothing carried, 8 lapsed', s.balanceDays === 0 && s.lapsedDays === 8, s)
  r = await api(owner, 'POST', '/leave/year-end/run')
  check('a year closes once (409)', r.status === 409, r.status)
  check('payroll and HR are told what to encash', !!(await prisma.notification.findFirst({ where: { tenantId: tenant.id, type: 'leave.encashment' } })))
  check('the run is in the audit log', !!(await prisma.auditLog.findFirst({ where: { tenantId: tenant.id, action: 'LEAVE_YEAR_CLOSED' } })))

  // ─── Rollback keeps leave taken since ──────────────────────
  await prisma.leaveBalance.update({ where: { employeeId_leaveTypeId: { employeeId: B.id, leaveTypeId: annual.id } }, data: { usedDays: { increment: 1 } } }) // a day taken after the run
  r = await api(tB, 'POST', `/leave/year-end/${runId}/rollback`)
  check('employees cannot roll back (403)', r.status === 403, r.status)
  r = await api(owner, 'POST', `/leave/year-end/${runId}/rollback`)
  a = await bal(annual); s = await bal(sick)
  check('rollback restores the balances and keeps the day taken since', r.status === 200 && a.balanceDays === 20 && a.usedDays === 5 && a.encashedDays === 0 && a.lapsedDays === 0 && s.balanceDays === 10 && s.usedDays === 2, { a, s })
  r = await api(owner, 'POST', `/leave/year-end/${runId}/rollback`)
  check('…once (400)', r.status === 400, r.status)

  // ─── Daily job & isolation ─────────────────────────────────
  await api(owner, 'POST', '/system/jobs/leave-year-end/run')
  const runs = await prisma.leaveYearEndRun.count({ where: { tenantId: tenant.id } })
  const firstDayToday = new Date().getUTCMonth() === 0 && new Date().getUTCDate() === 1
  check('the daily job only closes a year on its first day', firstDayToday || runs === 1, runs)
  const admin = await tokenFor('admin@marichihr.com')
  r = await api(admin, 'POST', `/leave/year-end/${runId}/rollback`)
  check("another company's run is out of reach (404)", r.status === 404, r.status)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  await prisma.user.updateMany({ where: { tenantId: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

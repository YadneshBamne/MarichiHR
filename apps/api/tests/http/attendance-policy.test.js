// Attendance policies: which policy governs whom, office hours with grace (late/early minutes), penalties beyond the
// monthly allowance, web/geofence rules, regularisation limits, overtime rules and rate, comp-off for working a
// holiday (granted once), isolation. Throwaway company; times are set relative to "now" so it runs any day.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `ap${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
const sign = (u, roles) => ({ token: jwt.sign({ userId: u.userId, tenantId: u.tenantId, employeeId: u.id, roleIds: roles, email: u.workEmail }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) })
const ymd = (d) => d.toISOString().slice(0, 10)

;(async () => {
  const keys = await redis.keys('signup:*'); if (keys.length) await redis.del(...keys)
  const email = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Att ${TAG}`, fullName: 'Ava Owner', email, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email } } } }) // timezone UTC
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, managerId) => (await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2026-01-05', employmentType: 'full_time', ...(managerId && { managerId }) })).body.employee
  const M = await add('Max'), B = await add('Bea', M.id), C = await add('Cal', M.id)
  const tM = sign(M, ['employee', 'manager']), tB = sign(B, ['employee']), tC = sign(C, ['employee'])
  const today = new Date(`${ymd(new Date())}T00:00:00.000Z`)
  const compType = await prisma.leaveType.findFirst({ where: { tenantId: tenant.id, code: 'COMPOFF' } })
  const balance = async () => Number((await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId: { employeeId: B.id, leaveTypeId: compType.id } } }))?.balanceDays ?? 0)
  const before = await balance() // before Bea works today at all
  const recordOf = (e) => prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: e.id, date: today } } })

  // ─── Policies & who they cover ─────────────────────────────
  r = await api(owner, 'GET', '/attendance/policies')
  check('no policies yet: built-in rules apply to everyone', r.status === 200 && r.body.policies.length === 0 && r.body.uncovered === 4 && r.body.builtIn.fullDayHours === 8, r.body)
  r = await api(tB, 'GET', '/attendance/policies')
  check('employees cannot manage policies (403)', r.status === 403, r.status)
  r = await api(owner, 'POST', '/attendance/policies', { name: 'Office', startTime: '17:00', endTime: '09:00' })
  check('office hours must end after they start (400)', r.status === 400, r.data)
  // Day starts at 00:00 with no grace, so any clock-in now is late; ends 23:59, so any clock-out now is early
  r = await api(owner, 'POST', '/attendance/policies', { name: 'Office', startTime: '00:00', endTime: '23:59', graceInMinutes: 0, graceOutMinutes: 0, halfDayHours: 0, fullDayHours: 0, lateEarlyAllowedPerMonth: 0, latePenalty: 'half_day_lop', regularisationDaysBack: 2, regularisationPerMonth: 1, overtimeEnabled: true, overtimeAfterHours: 9, overtimeRate: 2, overtimeMaxHoursPerMonth: 2, compOffEnabled: true, compOffHalfDayHours: 0, compOffFullDayHours: 0 })
  const office = r.body
  check('the first policy becomes the company default', r.status === 201 && office.isDefault, r.data)
  await api(owner, 'POST', `/employees/${C.id}/position`, { effectiveFrom: ymd(new Date()), employeeCategory: 'management', reason: 'Promotion' })
  r = await api(owner, 'POST', '/attendance/policies', { name: 'Managers', priority: 10, employeeCategories: ['management'], flexible: true, allowWeb: false })
  check('a group policy for one employee category', r.status === 201 && !r.body.isDefault, r.data)
  r = await api(owner, 'POST', '/attendance/policies', { name: 'Bad', employeeCategories: ['astronaut'] })
  check('filters must use master values (400)', r.status === 400, r.status)
  r = await api(owner, 'GET', '/attendance/policies')
  const count = (n) => r.body.policies.find((p) => p.name === n)?.people
  check('each person is counted under the policy that governs them', count('Office') === 3 && count('Managers') === 1 && r.body.uncovered === 0, r.body.policies.map((p) => [p.name, p.people]))
  r = await api(tC, 'GET', '/attendance/policies/mine')
  check('a person can see their own rules', r.body.name === 'Managers' && r.body.flexible === true, r.body)

  // ─── Clock-in rules, late/early, penalty ───────────────────
  r = await api(tC, 'POST', '/attendance/clock-in', { method: 'web' })
  check("a policy can forbid clocking in from the web (403)", r.status === 403, r.data)
  r = await api(tB, 'POST', '/attendance/clock-in', { method: 'web' })
  let rec = await recordOf(B)
  check('clocking in after start + grace records minutes late', [200, 201].includes(r.status) && rec.lateMinutes > 0, { status: r.status, late: rec?.lateMinutes })
  r = await api(tB, 'POST', '/attendance/clock-out', { method: 'web' })
  rec = await recordOf(B)
  check('clocking out before end − grace records minutes early', r.status === 200 && rec.earlyOutMinutes > 0, rec)
  check('with no allowance left the day becomes a half day (loss of pay)', rec.penalty === 'half_day_lop' && rec.status === 'half_day', { penalty: rec.penalty, status: rec.status })
  await api(owner, 'PATCH', `/attendance/policies/${office.id}`, { lateEarlyAllowedPerMonth: 5, requireGeofence: true })
  r = await api(tB, 'POST', '/attendance/clock-in', { method: 'web' })
  check('a policy can require the location to clock in (400)', r.status === 400 && /location/.test(r.data.message), r.data)
  await api(owner, 'PATCH', `/attendance/policies/${office.id}`, { requireGeofence: false })
  await api(tB, 'POST', '/attendance/clock-in', { method: 'web' })
  await api(tB, 'POST', '/attendance/clock-out', { method: 'web' })
  rec = await recordOf(B)
  check('within the allowance there is no penalty', rec.penalty === null && rec.status === 'present', { penalty: rec.penalty, status: rec.status })

  // ─── Comp-off for working a holiday ────────────────────────
  const cal = (await api(owner, 'POST', '/holidays/calendars', { name: `Hol ${TAG}`, year: today.getUTCFullYear(), holidays: [{ name: 'Test holiday', date: ymd(today), type: 'company' }] })).body
  await api(tB, 'POST', '/attendance/clock-in', { method: 'web' }); await api(tB, 'POST', '/attendance/clock-out', { method: 'web' })
  const once = await balance()
  await api(tB, 'POST', '/attendance/clock-in', { method: 'web' }); await api(tB, 'POST', '/attendance/clock-out', { method: 'web' })
  check('working a holiday (or a weekly off) earns one comp-off day', once - before === 1 && (await recordOf(B)).compOffDays === 1, { before, once })
  check('…once, however many times you clock out', (await balance()) === once)

  // ─── Regularisation limits ─────────────────────────────────
  const daysAgo = (n) => ymd(new Date(today.getTime() - n * 86400000))
  r = await api(tB, 'POST', '/attendance/regularisations', { date: daysAgo(10), actualIn: '09:00', actualOut: '17:00', reason: 'Forgot' })
  check('regularising further back than the policy allows is refused (400)', r.status === 400 && /2 days back/.test(r.data.message), r.data)
  if (today.getUTCDate() > 2) {
    r = await api(tB, 'POST', '/attendance/regularisations', { date: daysAgo(1), actualIn: '09:00', actualOut: '17:00', reason: 'Forgot' })
    const second = await api(tB, 'POST', '/attendance/regularisations', { date: daysAgo(2), actualIn: '09:00', actualOut: '17:00', reason: 'Forgot' })
    check('the monthly regularisation limit holds', r.status === 201 && second.status === 400 && /1 regularisations a month/.test(second.data.message), { first: r.status, second: second.data })
  }

  // ─── Overtime ──────────────────────────────────────────────
  r = await api(tB, 'POST', '/attendance/overtime', { date: daysAgo(1), overtimeHours: 1.5, reason: 'Release' })
  const ot = r.body
  check('overtime within the monthly cap is accepted', r.status === 201, r.data)
  r = await api(tB, 'POST', '/attendance/overtime', { date: daysAgo(1), overtimeHours: 1, reason: 'More' })
  check('…above the cap it is refused (400)', r.status === 400 && /2 hours a month/.test(r.data.message), r.data)
  r = await api(tM, 'POST', `/attendance/overtime/${ot.id}/approve`, {})
  check("the manager's approval uses the policy's rate (2×)", r.status === 200 && (await prisma.overtimeRequest.findUnique({ where: { id: ot.id } })).approvedRate === 2, r.data)
  await api(owner, 'PATCH', `/attendance/policies/${office.id}`, { overtimeEnabled: false })
  r = await api(tB, 'POST', '/attendance/overtime', { date: daysAgo(1), overtimeHours: 0.5, reason: 'x' })
  check('a policy without overtime refuses requests (400)', r.status === 400, r.status)

  // ─── Default rules & isolation ─────────────────────────────
  r = await api(owner, 'PATCH', `/attendance/policies/${office.id}`, { active: false })
  check('the default policy cannot be retired (400)', r.status === 400, r.status)
  const admin = await tokenFor('admin@marichihr.com')
  r = await api(admin, 'PATCH', `/attendance/policies/${office.id}`, { name: 'Hijack' })
  check("another company's policy is out of reach (404)", r.status === 404, r.status)

  await prisma.holidayCalendar.update({ where: { id: cal.id }, data: { active: false } }).catch(() => {})
  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  await prisma.user.updateMany({ where: { tenantId: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

// Leave: statutory minimums, tenure slabs, hourly leave, send back for changes, leave vs attendance mismatch tasks.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `lg${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `LeaveG ${TAG}`, fullName: 'Gia Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const type = async (code) => prisma.leaveType.findFirst({ where: { tenantId: tenant.id, code } })

  // ─── Statutory minimums ───────────────────────────────────
  r = await api(owner, 'PATCH', '/company', { primaryCountry: 'ZM', baseCurrency: 'ZMW' })
  const mat = await type('MATERNITY')
  check('setting the country to Zambia raises maternity leave to the legal 98 days', r.status === 200 && mat.accrualAmount === 98, mat.accrualAmount)
  r = await api(owner, 'PATCH', `/leave/types/${mat.id}`, { accrualAmount: 60 })
  check('it cannot be set below the legal minimum (400)', r.status === 400 && /98/.test(r.data.message), r.data)
  r = await api(owner, 'GET', '/leave/types/all')
  check('the leave policies list shows the legal minimum', r.body.find((t) => t.id === mat.id)?.statutoryMinimum?.days === 98, r.body?.find?.((t) => t.id === mat.id)?.statutoryMinimum)

  // ─── Tenure slabs ─────────────────────────────────────────
  const annual = await type('ANNUAL')
  r = await api(owner, 'PATCH', `/leave/types/${annual.id}`, { tenureSlabs: [{ fromYears: 5, amount: 2.5 }] })
  check('HR adds a service step: 2.5 days a month from 5 years', r.status === 200, r.data)
  const add = async (first, hireDate, managerId) => { const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate, employmentType: 'full_time', ...(managerId && { managerId }) }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }
  const mgr = await add('Mo', '2015-01-05'), senior = await add('Sid', '2018-01-08', mgr.id), junior = await add('Jo', '2025-06-02', mgr.id)
  const credit = async (e) => { for (let i = 0; i < 40; i++) { const a = await prisma.leaveAllocation.findFirst({ where: { employeeId: e.id, leaveTypeId: annual.id, allocationType: 'accrual' } }); if (a) return a.daysAllocated; await sleep(500) } return null }
  check('someone with 8 years of service gets 2.5 days this month', (await credit(senior)) === 2.5)
  check('a new joiner gets the normal 1.67', (await credit(junior)) === 1.67)

  // ─── Hourly leave ─────────────────────────────────────────
  const casual = await type('CASUAL')
  await prisma.leaveType.update({ where: { id: casual.id }, data: { hourlyAllowed: true } })
  await prisma.leaveBalance.upsert({ where: { employeeId_leaveTypeId: { employeeId: junior.id, leaveTypeId: casual.id } }, create: { employeeId: junior.id, leaveTypeId: casual.id, balanceDays: 5, asOfDate: new Date() }, update: { balanceDays: 5, usedDays: 0, pendingDays: 0 } })
  const wd = (n) => { const x = new Date(Date.now() + n * 86_400_000); while ([0, 6].includes(x.getUTCDay())) x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10) }
  const asJo = as(junior, ['employee']), asMo = as(mgr, ['employee', 'manager'])
  r = await api(asJo, 'POST', '/leave/requests', { leaveTypeId: casual.id, startDate: wd(20), endDate: wd(20), hours: 4, reason: 'Dentist' })
  check('4 hours of casual leave count as half a day', r.status === 201 && r.body.totalDays === 0.5 && r.body.hours === 4, r.data)
  r = await api(asJo, 'POST', '/leave/requests', { leaveTypeId: annual.id, startDate: wd(22), endDate: wd(22), hours: 2 })
  check('a type that is not hourly refuses hours (400)', r.status === 400, r.data)

  // ─── Send back for changes ────────────────────────────────
  r = await api(asJo, 'POST', '/leave/requests', { leaveTypeId: casual.id, startDate: wd(30), endDate: wd(30), reason: 'Errand' })
  const req = r.body
  r = await api(asMo, 'POST', `/leave/requests/${req.id}/return`, { note: 'Can you take Thursday instead?' })
  const back = await prisma.leaveRequest.findUnique({ where: { id: req.id } })
  check('the manager sends it back with a note', r.status === 200 && back.status === 'returned' && /Thursday/.test(back.returnNote), r.data)
  check('…Jo is told', !!(await prisma.notification.findFirst({ where: { userId: junior.userId, type: 'leave.returned', entityId: req.id } })))
  r = await api(asJo, 'POST', `/leave/requests/${req.id}/resubmit`, { leaveTypeId: casual.id, startDate: wd(31), endDate: wd(31), reason: 'Errand, moved' })
  check('Jo edits the date and sends it again as a new request', r.status === 201 && r.body.status === 'pending' && (await prisma.leaveRequest.findUnique({ where: { id: req.id } })).status === 'resubmitted', r.data)

  // ─── Leave and attendance disagree ────────────────────────
  const past = new Date(Date.now() - 3 * 86_400_000); while ([0, 6].includes(past.getUTCDay())) past.setUTCDate(past.getUTCDate() - 1)
  const day = new Date(`${past.toISOString().slice(0, 10)}T00:00:00Z`)
  const lr = await prisma.leaveRequest.create({ data: { employeeId: senior.id, leaveTypeId: annual.id, startDate: day, endDate: day, totalDays: 1, lwpDays: 0, status: 'approved' } })
  await prisma.attendanceRecord.create({ data: { employeeId: senior.id, date: day, status: 'present', checkInTime: new Date(day.getTime() + 9 * 3_600_000) } })
  r = await api(owner, 'POST', '/system/jobs/leave-attendance-check/run')
  let task = null
  for (let i = 0; i < 30 && !task; i++) { task = await prisma.activity.findFirst({ where: { tenantId: tenant.id, entityType: 'leave_request', entityId: lr.id } }); if (!task) await sleep(500) }
  check('leave on a day Sid clocked in becomes a task for his manager', !!task && task.assignedToId === mgr.id, task)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

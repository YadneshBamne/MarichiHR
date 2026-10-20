// Leave credits on a fresh company: yearly lump sums (pro-rated for joiners, once per leave year, held until the
// year end closes the old year), monthly accrual once a month, HR adjustments (reason, audit, notification, negative
// guard) and employees' allocation requests reaching their manager / HR (approve once, reject, validation).
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `lc${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Credits ${TAG}`, fullName: 'Credit Owner', email: ownerEmail, password: 'Owner-pass-123' })
  check('a fresh company signs up', r.status === 201, r.data)
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const types = Object.fromEntries((await prisma.leaveType.findMany({ where: { tenantId: tenant.id } })).map((t) => [t.code, t]))
  check('new companies get Sick (10/year) and Casual (6/year) as yearly lump sums', types.SICK.accrualType === 'annual_lumpsum' && types.SICK.accrualAmount === 10 && types.CASUAL.accrualAmount === 6)
  const token = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })

  const fy = tenant.fiscalYearStart.getUTCMonth()
  const now = new Date(); const startYear = now.getUTCMonth() >= fy ? now.getUTCFullYear() : now.getUTCFullYear() - 1
  const yearStart = new Date(Date.UTC(startYear, fy, 1))
  const add = async (first, hire, managerId) => { const res = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: hire, employmentType: 'full_time', ...(managerId && { managerId }) }); if (res.status !== 201) throw new Error(`add ${first}: ${res.status} ${JSON.stringify(res.data)}`); return res.body.employee ?? res.body }
  // A joiner 6 months before the leave year ends gets half; someone hired before the year started gets all of it
  const sixLeft = new Date(Date.UTC(startYear, fy + 6, 15)).toISOString().slice(0, 10)
  const lead = await add('Lead', '2020-03-01')
  const member = await add('Member', sixLeft <= now.toISOString().slice(0, 10) ? sixLeft : now.toISOString().slice(0, 10), lead.id)
  const leadEmp = await prisma.employee.findUnique({ where: { id: lead.id } }), memberEmp = await prisma.employee.findUnique({ where: { id: member.id } })

  r = await api(owner, 'POST', '/system/jobs/leave-accrual/run')
  const bal = async (emp, code) => prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId: { employeeId: emp.id, leaveTypeId: types[code].id } } })
  const monthsLeft = 12 - ((new Date(memberEmp.hireDate).getUTCFullYear() - startYear) * 12 + new Date(memberEmp.hireDate).getUTCMonth() - fy)
  const share = (n) => Math.round((n * Math.min(12, monthsLeft)) / 12 * 2) / 2
  check('a long-serving person gets the full 10 days of Sick leave', (await bal(leadEmp, 'SICK'))?.balanceDays === 10, await bal(leadEmp, 'SICK'))
  check(`a joiner gets the share of months left (${monthsLeft}): Sick ${share(10)}, Casual ${share(6)}`, (await bal(memberEmp, 'SICK'))?.balanceDays === share(10) && (await bal(memberEmp, 'CASUAL'))?.balanceDays === share(6), [await bal(memberEmp, 'SICK'), await bal(memberEmp, 'CASUAL')])
  check('this month\'s Annual Leave accrual is credited too', (await bal(leadEmp, 'ANNUAL'))?.balanceDays === types.ANNUAL.accrualAmount, await bal(leadEmp, 'ANNUAL'))
  r = await api(owner, 'POST', '/system/jobs/leave-accrual/run')
  check('running it again credits nothing', r.status === 200 && r.body[tenant.id] === 0, r.data)
  check('…and balances are unchanged', (await bal(leadEmp, 'SICK')).balanceDays === 10 && (await bal(leadEmp, 'ANNUAL')).balanceDays === types.ANNUAL.accrualAmount)

  // A company that existed last year waits for the year end before this year's lump sums
  await prisma.tenant.update({ where: { id: tenant.id }, data: { createdAt: new Date('2020-01-01') } })
  const late = await add('Late', '2021-01-01')
  await api(owner, 'POST', '/system/jobs/leave-accrual/run')
  check('an older company holds new-year lump sums until the year end has run', !(await prisma.leaveAllocation.findFirst({ where: { employeeId: late.id, allocationType: 'annual' } })))
  await prisma.leaveYearEndRun.create({ data: { tenantId: tenant.id, yearEnd: new Date(yearStart.getTime() - 86_400_000), automatic: true, rows: [], totals: {} } })
  await api(owner, 'POST', '/system/jobs/leave-accrual/run')
  check('…and credits them once it has', (await prisma.leaveAllocation.count({ where: { employeeId: late.id, allocationType: 'annual' } })) === 2)

  // ─── HR adjustments ────────────────────────────────────────
  r = await api(owner, 'GET', `/leave/admin/balances/${lead.id}`)
  check('HR sees every leave type for a person, with how it is credited', r.status === 200 && r.body.balances.length === Object.keys(types).length && r.body.balances.find((b) => b.code === 'SICK').creditMethod === 'annual_lumpsum', r.data)
  r = await api(owner, 'POST', `/leave/admin/balances/${lead.id}/adjust`, { leaveTypeId: types.SICK.id, days: 3, reason: 'Opening balance' })
  check('HR adds 3 days with a reason', r.status === 200 && r.body.available === 13, r.data)
  check('…recorded in the audit log', !!(await prisma.auditLog.findFirst({ where: { tenantId: tenant.id, action: 'LEAVE_BALANCE_ADJUSTED', entityId: lead.id } })))
  r = await api(owner, 'POST', `/leave/admin/balances/${lead.id}/adjust`, { leaveTypeId: types.SICK.id, days: -20, reason: 'Correction' })
  check('removing more than is available needs confirmation (409)', r.status === 409 && /negative/.test(r.data.message), r.data)
  r = await api(owner, 'POST', `/leave/admin/balances/${lead.id}/adjust`, { leaveTypeId: types.SICK.id, days: 2, reason: 'x' })
  check('a reason is required (400)', r.status === 400, r.status)
  r = await api(token(leadEmp, ['employee', 'manager']), 'POST', `/leave/admin/balances/${lead.id}/adjust`, { leaveTypeId: types.SICK.id, days: 5, reason: 'Self top-up' })
  check('a manager cannot adjust balances (403)', r.status === 403, r.status)

  // ─── Allocation requests ───────────────────────────────────
  const asMember = token(memberEmp, ['employee']), asLead = token(leadEmp, ['employee', 'manager'])
  r = await api(asMember, 'POST', '/leave/allocation-requests', { leaveTypeId: types.SICK.id, requestedDays: -1, reason: 'oops' })
  check('negative requests are refused (400)', r.status === 400, r.status)
  r = await api(asMember, 'POST', '/leave/allocation-requests', { leaveTypeId: types.SICK.id, requestedDays: 2, reason: 'Medical procedure' })
  const reqId = r.body?.id
  check('the employee requests 2 extra sick days', r.status === 201, r.data)
  r = await api(asLead, 'GET', '/leave/allocation-requests/pending')
  check('their manager sees the request in Approvals', r.status === 200 && r.body.some((x) => x.id === reqId), r.body)
  r = await api(owner, 'GET', '/leave/allocation-requests/pending')
  check('HR sees it too', r.body.some((x) => x.id === reqId))
  r = await api(asMember, 'GET', '/leave/allocation-requests/pending')
  check('the employee cannot see the approval queue (403)', r.status === 403, r.status)
  const before = (await bal(memberEmp, 'SICK')).balanceDays
  r = await api(asLead, 'POST', `/leave/allocation-requests/${reqId}/approve`, { approvedDays: 2 })
  check('the manager approves; 2 days are added', r.status === 200 && (await bal(memberEmp, 'SICK')).balanceDays === before + 2, r.data)
  r = await api(owner, 'POST', `/leave/allocation-requests/${reqId}/approve`, { approvedDays: 2 })
  check('approving it again is refused', r.status === 400 && (await bal(memberEmp, 'SICK')).balanceDays === before + 2, r.data)
  check('the employee is told', !!(await prisma.notification.findFirst({ where: { userId: memberEmp.userId, type: 'leave.allocation.approved' } })))
  r = await api(asMember, 'POST', '/leave/allocation-requests', { leaveTypeId: types.CASUAL.id, requestedDays: 5, reason: 'Festival' })
  r = await api(asLead, 'POST', `/leave/allocation-requests/${r.body.id}/reject`, { note: 'Use annual leave' })
  check('a rejection is recorded and the employee told', r.status === 200 && r.body.status === 'rejected' && !!(await prisma.notification.findFirst({ where: { userId: memberEmp.userId, type: 'leave.allocation.rejected' } })), r.data)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

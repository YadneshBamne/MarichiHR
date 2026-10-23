// Leave extras: blackout periods, teammates-off warning, medical certificate attachment, carry-forward expiry, liability.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `lx${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `LeaveX ${TAG}`, fullName: 'Lee Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken } // hr_admin + system_admin
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { primaryCountry: 'ZM', baseCurrency: 'ZMW', modules: { set: [...new Set([...(tenant.modules ?? []), 'leave', 'payroll'])] } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, managerId) => { const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2024-01-08', employmentType: 'full_time', ...(managerId && { managerId }) }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }
  const mgr = await add('Mia'), ann = await add('Ann'), bob = await add('Bob'), pay = await add('Pat')
  await prisma.employee.updateMany({ where: { id: { in: [ann.id, bob.id] } }, data: { managerId: mgr.id } })
  const asAnn = as(ann, ['employee']), asBob = as(bob, ['employee']), asMgr = as(mgr, ['employee', 'manager']), asPay = as(pay, ['employee', 'payroll_admin'])
  const types = await prisma.leaveType.findMany({ where: { tenantId: tenant.id, active: true } })
  const annual = types.find((t) => t.code === 'ANNUAL') ?? types[0], sick = types.find((t) => t.code === 'SICK') ?? types[1]
  for (const e of [ann, bob]) for (const t of [annual, sick]) await prisma.leaveBalance.upsert({ where: { employeeId_leaveTypeId: { employeeId: e.id, leaveTypeId: t.id } }, create: { employeeId: e.id, leaveTypeId: t.id, balanceDays: 20, asOfDate: new Date() }, update: { balanceDays: 20, usedDays: 0, pendingDays: 0 } })
  const next = (d) => { const x = new Date(Date.now() + d * 86_400_000); while ([0, 6].includes(x.getUTCDay())) x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10) }

  // ─── Strict body ──────────────────────────────────────────
  r = await api(asAnn, 'POST', '/leave/requests', { leaveTypeId: annual.id, startDate: next(20), endDate: next(20), status: 'approved' })
  check('the leave request body is strict (400)', r.status === 400, r.status)

  // ─── Overlap warning ──────────────────────────────────────
  const d1 = next(20)
  r = await api(asAnn, 'POST', '/leave/requests', { leaveTypeId: annual.id, startDate: d1, endDate: d1, reason: 'Trip' })
  check('Ann applies; nobody else is off', r.status === 201 && r.body.overlaps.length === 0, r.data)
  r = await api(asBob, 'GET', `/leave/overlap?startDate=${d1}&endDate=${d1}`)
  check('Bob sees Ann is off that day before applying', r.status === 200 && r.body.some((o) => /Ann/.test(o.name)), r.body)
  r = await api(asBob, 'POST', '/leave/requests', { leaveTypeId: annual.id, startDate: d1, endDate: d1 })
  check('…and can still apply (a warning, not a block)', r.status === 201 && r.body.overlaps.some((o) => /Ann/.test(o.name)), r.data)

  // ─── Blackouts ────────────────────────────────────────────
  const b1 = next(40), b2 = next(44)
  r = await api(asAnn, 'POST', '/leave/blackouts', { name: 'Year-end close', startDate: b1, endDate: b2 })
  check('only HR sets blackouts (403)', r.status === 403, r.status)
  r = await api(owner, 'POST', '/leave/blackouts', { name: 'Year-end close', startDate: b1, endDate: b2, leaveTypeIds: [annual.id] })
  check('HR sets an annual-leave blackout', r.status === 201, r.data)
  r = await api(asAnn, 'POST', '/leave/requests', { leaveTypeId: annual.id, startDate: b1, endDate: b1 })
  check('annual leave inside the blackout is refused (400)', r.status === 400 && /blackout/.test(r.data.message), r.data)
  r = await api(asAnn, 'GET', '/leave/blackouts')
  check('everyone sees the blackout dates', r.body.some((b) => b.startDate === b1), r.body)

  // ─── Medical certificate ──────────────────────────────────
  await prisma.leaveType.update({ where: { id: sick.id }, data: { attachmentRequiredAfterDays: 1 } })
  const s1 = next(60), s2 = next(61)
  r = await api(asAnn, 'POST', '/leave/requests', { leaveTypeId: sick.id, startDate: s1, endDate: s2 })
  check('two sick days without a certificate are refused (400)', r.status === 400 && /certificate/.test(r.data.message), r.data)
  const doc = await prisma.employeeDocument.create({ data: { tenantId: tenant.id, employeeId: ann.id, category: 'medical', title: 'Medical certificate', fileName: 'cert.pdf', fileKey: `${tenant.id}/employees/${ann.id}/cert.pdf`, mimeType: 'application/pdf', size: 100, visibility: 'employee', uploadedBy: ann.userId } })
  const bobDoc = await prisma.employeeDocument.create({ data: { tenantId: tenant.id, employeeId: bob.id, category: 'medical', title: 'x', fileName: 'x.pdf', fileKey: `${tenant.id}/x.pdf`, mimeType: 'application/pdf', size: 1, visibility: 'employee', uploadedBy: bob.userId } })
  r = await api(asAnn, 'POST', '/leave/requests', { leaveTypeId: sick.id, startDate: s1, endDate: s2, attachmentDocumentId: bobDoc.id })
  check("someone else's document cannot be attached (404)", r.status === 404, r.status)
  r = await api(asAnn, 'POST', '/leave/requests', { leaveTypeId: sick.id, startDate: s1, endDate: s2, attachmentDocumentId: doc.id })
  const sickReq = r.body
  check('with her certificate attached it goes through', r.status === 201, r.data)
  r = await api(asBob, 'GET', `/leave/requests/${sickReq.id}/attachment`)
  check('a colleague cannot open it (404)', r.status === 404, r.status)
  r = await api(asMgr, 'GET', `/leave/requests/${sickReq.id}/attachment`)
  check('her manager can (a short-lived link)', r.status === 200 || r.status === 500 && /storage|configured/i.test(r.data?.message ?? ''), r.status)

  // ─── Carry-forward expiry ─────────────────────────────────
  await prisma.leaveType.update({ where: { id: annual.id }, data: { carryForward: true, carryForwardExpiryMonths: 3 } })
  await prisma.leaveBalance.update({ where: { employeeId_leaveTypeId: { employeeId: bob.id, leaveTypeId: annual.id } }, data: { balanceDays: 25, usedDays: 2, pendingDays: 0 } })
  await prisma.leaveYearEndRun.create({ data: { tenantId: tenant.id, yearEnd: new Date('2025-12-31T00:00:00Z'), rows: [{ employeeId: bob.id, leaveTypeId: annual.id, available: 7, carried: 5, encashed: 0, lapsed: 2, dBalance: 0, dUsed: 0 }], totals: {} } })
  await prisma.leaveRequest.updateMany({ where: { employeeId: bob.id }, data: { status: 'cancelled' } })
  r = await api(owner, 'POST', '/system/jobs/carry-forward-expiry/run')
  check('the expiry job can be run by hand', r.status === 200 || r.status === 202, r.data)
  let exp = null
  for (let i = 0; i < 30 && !exp; i++) { exp = await prisma.leaveAllocation.findFirst({ where: { employeeId: bob.id, allocationType: 'carry_forward_expiry' } }); if (!exp) await sleep(500) }
  const bal = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId: { employeeId: bob.id, leaveTypeId: annual.id } } })
  check('3 of 5 carried days lapse (2 were used first), on the ledger', exp && exp.daysAllocated === -3 && bal.balanceDays === 22 && bal.lapsedDays === 3, { exp: exp?.daysAllocated, bal: bal.balanceDays, lapsed: bal.lapsedDays })
  r = await api(owner, 'POST', '/system/jobs/carry-forward-expiry/run')
  await sleep(3000)
  check('…only once', (await prisma.leaveAllocation.count({ where: { employeeId: bob.id, allocationType: 'carry_forward_expiry' } })) === 1)

  // ─── Liability ────────────────────────────────────────────
  await prisma.leaveType.update({ where: { id: annual.id }, data: { encashable: true } })
  const structure = (await api(asPay, 'POST', '/salary/structures/starter')).body
  const k = await api(asPay, 'POST', '/leave/contracts', { employeeId: bob.id, ctcAnnual: 360000, wageMonthly: 30000, currency: 'ZMW', effectiveFrom: '2024-01-08', salaryStructureId: structure.id })
  for (const s of ['draft', 'confirm', 'activate']) await api(asPay, 'POST', `/leave/contracts/${k.body.id}/${s}`, {})
  r = await api(owner, 'GET', '/reports/leave_liability')
  check('HR cannot see the leave liability (it is pay) (403)', r.status === 403, r.status)
  r = await api(asPay, 'GET', '/reports/leave_liability')
  const bobRow = r.body?.rows?.find((x) => x.employeeCode === bob.employeeCode)
  check('Payroll sees it: 20 days × 30,000/30 = 20,000 for Bob', r.status === 200 && bobRow && bobRow.days === 20 && bobRow.liability === 20000, bobRow ?? r.data)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

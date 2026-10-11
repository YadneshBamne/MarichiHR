// Approval chains: the old single-step rule without a chain, a 3-level chain (manager → manager's manager → HR)
// moving step by step, rejection ending it, delegation, the "waiting for me" list and HR's monitor, override,
// nobody approving themselves, chains for overtime, delegation without a chain, isolation. Throwaway company.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `ac${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
const sign = (u, roles) => ({ token: jwt.sign({ userId: u.userId, tenantId: u.tenantId, employeeId: u.id, roleIds: roles, email: u.workEmail }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) })
const ymd = (d) => d.toISOString().slice(0, 10)
// Monday-Tuesday of the n-th week from now (always working days, never overlapping)
const week = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7) + 7 * n); const t = new Date(d); t.setUTCDate(t.getUTCDate() + 1); return { startDate: ymd(d), endDate: ymd(t) } }

;(async () => {
  const keys = await redis.keys('signup:*'); if (keys.length) await redis.del(...keys)
  const email = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Appr ${TAG}`, fullName: 'Oli Owner', email, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email } } } })
  const ownerEmp = await prisma.employee.findFirst({ where: { tenantId: tenant.id } })
  const ownerUser = await prisma.user.findFirst({ where: { email } })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, managerId) => (await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2026-01-05', employmentType: 'full_time', ...(managerId && { managerId }) })).body.employee
  const S = await add('Sam'), M = await add('Mia', S.id), B = await add('Ben', M.id), D = await add('Dan')
  const tS = sign(S, ['employee', 'manager']), tM = sign(M, ['employee', 'manager']), tB = sign(B, ['employee']), tD = sign(D, ['employee'])
  const lwp = await prisma.leaveType.findFirst({ where: { tenantId: tenant.id, code: 'LWP' } })
  const apply = async (who, n) => (await api(who, 'POST', '/leave/requests', { leaveTypeId: lwp.id, ...week(n), reason: 'Personal' })).body
  const status = async (id) => (await prisma.leaveRequest.findUnique({ where: { id } })).status

  // ─── No chain: the old rule ────────────────────────────────
  let lr = await apply(tB, 1)
  r = await api(tD, 'POST', `/approvals/leave/${lr.id}/approve`, {})
  check('without a chain, a stranger cannot approve (403)', r.status === 403, r.data)
  r = await api(tM, 'POST', `/approvals/leave/${lr.id}/approve`, {})
  check('…the direct manager approves in one step', r.status === 200 && (await status(lr.id)) === 'approved', r.data)

  // ─── A 3-level chain ───────────────────────────────────────
  r = await api(tB, 'POST', '/approvals/chains', { requestType: 'leave', name: 'x', levels: [{ kind: 'hr' }] })
  check('only HR sets up chains (403)', r.status === 403, r.status)
  r = await api(owner, 'POST', '/approvals/chains', { requestType: 'leave', name: 'Three levels', levels: [{ kind: 'manager' }, { kind: 'skip_manager' }, { kind: 'hr' }] })
  const chain = r.body
  check('HR creates a leave chain: manager → manager’s manager → HR', r.status === 201, r.data)
  r = await api(owner, 'POST', '/approvals/chains', { requestType: 'leave', name: 'x', levels: [{ kind: 'hr' }, { kind: 'hr' }, { kind: 'hr' }, { kind: 'hr' }, { kind: 'hr' }, { kind: 'hr' }] })
  check('at most 5 levels (400)', r.status === 400, r.status)
  lr = await apply(tB, 2)
  check('a new request gets its three steps', (await prisma.approvalStep.count({ where: { requestId: lr.id } })) === 3)
  check('Mia sees it waiting for her; Sam does not yet', (await api(tM, 'GET', '/approvals/pending')).body.some((x) => x.requestId === lr.id) && !(await api(tS, 'GET', '/approvals/pending')).body.some((x) => x.requestId === lr.id))
  r = await api(owner, 'POST', `/approvals/leave/${lr.id}/approve`, {})
  check('HR cannot jump the queue (403)', r.status === 403 && /level 1/.test(r.data.message), r.data)
  r = await api(tM, 'POST', `/approvals/leave/${lr.id}/approve`, { comments: 'Fine by me' })
  check('level 1 approves; the request stays pending', r.status === 200 && (await status(lr.id)) === 'pending', r.data)
  check("…and moves to Sam (the manager's manager)", (await api(tS, 'GET', '/approvals/pending')).body.some((x) => x.requestId === lr.id && x.level === 2 && x.of === 3))
  r = await api(tS, 'POST', `/approvals/leave/${lr.id}/approve`, {})
  r = await api(owner, 'POST', `/approvals/leave/${lr.id}/approve`, {})
  check('the last level makes it approved', r.status === 200 && (await status(lr.id)) === 'approved', r.data)
  const trail = (await api(tB, 'GET', `/approvals/leave/${lr.id}/trail`)).body
  check('the trail shows who approved each level', trail.length === 3 && trail.every((s) => s.status === 'approved' && s.by) && trail[0].comments === 'Fine by me', trail)

  lr = await apply(tB, 3)
  r = await api(tM, 'POST', `/approvals/leave/${lr.id}/reject`, {})
  check('rejecting needs a reason (400)', r.status === 400, r.status)
  r = await api(tM, 'POST', `/approvals/leave/${lr.id}/reject`, { comments: 'Release week' })
  check('a rejection at any level ends it', r.status === 200 && (await status(lr.id)) === 'rejected' && (await prisma.approvalStep.count({ where: { requestId: lr.id, status: 'skipped' } })) === 2, r.data)

  // ─── Delegation ────────────────────────────────────────────
  r = await api(tS, 'POST', '/approvals/delegations', { toUserId: S.userId, startDate: ymd(new Date()), endDate: ymd(new Date()) })
  check('you cannot delegate to yourself (400)', r.status === 400, r.status)
  r = await api(tS, 'POST', '/approvals/delegations', { toUserId: D.userId, startDate: ymd(new Date()), endDate: ymd(new Date(Date.now() + 3 * 86400000)), reason: 'On leave' })
  check('Sam hands his approvals to Dan while away', r.status === 201, r.data)
  lr = await apply(tB, 4)
  await api(tM, 'POST', `/approvals/leave/${lr.id}/approve`, {})
  check("Dan sees Sam's step in his list", (await api(tD, 'GET', '/approvals/pending')).body.some((x) => x.requestId === lr.id))
  r = await api(tD, 'POST', `/approvals/leave/${lr.id}/approve`, {})
  const step2 = (await api(owner, 'GET', `/approvals/leave/${lr.id}/trail`)).body[1]
  check('…approves it, recorded as acting for Sam', r.status === 200 && step2.status === 'approved' && step2.by?.startsWith('Dan') && step2.onBehalfOf?.startsWith('Sam'), step2)

  // ─── Monitor and override ──────────────────────────────────
  r = await api(owner, 'GET', '/approvals/monitor')
  const row = r.body.find((x) => x.requestId === lr.id)
  check('HR’s monitor lists every pending approval with who it waits for', r.status === 200 && row && row.level === 3 && row.approvers.length >= 1, row)
  r = await api(tB, 'GET', '/approvals/monitor')
  check('employees cannot open the monitor (403)', r.status === 403, r.status)
  const lr2 = await apply(tB, 5)
  r = await api(owner, 'POST', `/approvals/leave/${lr2.id}/override`, { approve: true })
  check('an override needs a reason (400)', r.status === 400, r.status)
  r = await api(owner, 'POST', `/approvals/leave/${lr2.id}/override`, { approve: true, comments: 'Urgent family matter' })
  check('HR can override the chain and decide outright', r.status === 200 && (await status(lr2.id)) === 'approved' && (await prisma.approvalStep.count({ where: { requestId: lr2.id, status: 'skipped' } })) === 2, r.data)
  check('…which is audit-logged', !!(await prisma.auditLog.findFirst({ where: { tenantId: tenant.id, action: 'APPROVAL_OVERRIDDEN', entityId: lr2.id } })))
  r = await api(owner, 'POST', `/approvals/leave/${lr.id}/approve`, {})
  check('HR finishes the delegated one at level 3', r.status === 200 && (await status(lr.id)) === 'approved', r.data)

  // ─── Nobody approves themselves ────────────────────────────
  await api(owner, 'PATCH', `/approvals/chains/${chain.id}`, { levels: [{ kind: 'hr' }] })
  const own = (await api(owner, 'POST', '/leave/requests', { leaveTypeId: lwp.id, ...week(6), reason: 'Mine' })).body
  r = await api(owner, 'POST', `/approvals/leave/${own.id}/approve`, {})
  check('the only HR person cannot approve their own leave (403)', r.status === 403, r.data)

  // ─── Overtime chain; legacy delegation for regularisation ──
  await api(owner, 'POST', '/approvals/chains', { requestType: 'overtime', name: 'OT', levels: [{ kind: 'skip_manager' }] })
  const yesterday = ymd(new Date(Date.now() - 86400000))
  const ot = (await api(tB, 'POST', '/attendance/overtime', { date: yesterday, overtimeHours: 1, reason: 'Deploy' })).body
  r = await api(tM, 'POST', `/attendance/overtime/${ot.id}/approve`, {})
  check("an overtime chain can skip the direct manager (403 for Mia)", r.status === 403, r.data)
  r = await api(tS, 'POST', `/attendance/overtime/${ot.id}/approve`, {})
  check('…Sam approves it', r.status === 200 && (await prisma.overtimeRequest.findUnique({ where: { id: ot.id } })).status === 'approved', r.data)
  await api(tM, 'POST', '/approvals/delegations', { toUserId: D.userId, startDate: ymd(new Date()), endDate: ymd(new Date()) })
  const reg = (await api(tB, 'POST', '/attendance/regularisations', { date: yesterday, actualIn: '09:00', actualOut: '17:00', reason: 'Forgot' })).body
  r = await api(tD, 'POST', `/approvals/regularisation/${reg.id}/approve`, {})
  check("without a chain, a delegate can still stand in for the manager", r.status === 200 && (await prisma.attendanceRegularisation.findUnique({ where: { id: reg.id } })).status === 'approved', r.data)

  // ─── Isolation ─────────────────────────────────────────────
  const admin = await tokenFor('admin@marichihr.com')
  r = await api(admin, 'PATCH', `/approvals/chains/${chain.id}`, { name: 'Hijack' })
  check("another company's chain is out of reach (404)", r.status === 404, r.status)
  r = await api(admin, 'POST', `/approvals/leave/${own.id}/approve`, {})
  check("…and so are its requests", r.status === 404 || r.status === 403, r.status)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  await prisma.user.updateMany({ where: { tenantId: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

// Pre-approval requests: money / travel / accommodation asked before spending, up the reporting line (or a chain),
// visible to Finance once approved, bills submitted against it as claims, Finance closes it.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `pa${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `PreApp ${TAG}`, fullName: 'Pat Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { modules: { set: [...new Set([...(tenant.modules ?? []), 'expenses'])] } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first) => { const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time' }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }
  const boss = await add('Boss'), lead = await add('Lead'), member = await add('Member'), fin = await add('Fin')
  await prisma.employee.update({ where: { id: lead.id }, data: { managerId: boss.id } })
  await prisma.employee.update({ where: { id: member.id }, data: { managerId: lead.id } })
  for (const e of [boss, lead, member, fin]) if (!e.userId) { const u = await prisma.user.create({ data: { tenantId: tenant.id, email: `${e.id}@x.test` } }); await prisma.employee.update({ where: { id: e.id }, data: { userId: u.id } }); e.userId = u.id }
  const finRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, name: 'payroll_admin' } })
  await prisma.userRole.create({ data: { userId: fin.userId, roleId: finRole.id } })
  const asMember = as(member, ['employee']), asLead = as(lead, ['employee', 'manager']), asBoss = as(boss, ['employee', 'manager']), asFin = as(fin, ['employee', 'payroll_admin'])

  // ─── Raise ─────────────────────────────────────────────────
  r = await api(asMember, 'POST', '/expenses/requests', { kind: 'travel', purpose: 'Client visit in Ndola', justification: 'Signing the annual contract on site', amount: 4500 })
  check('travel needs a destination and dates (400)', r.status === 400, r.data)
  r = await api(asMember, 'POST', '/expenses/requests', { kind: 'travel', purpose: 'Client visit in Ndola', justification: 'Signing the annual contract on site', amount: 4500, destination: 'Ndola', startDate: '2026-11-10', endDate: '2026-11-12' })
  const req = r.body
  check('an employee asks for travel money before spending', r.status === 201 && req.status === 'pending' && req.currency, r.data)
  const steps = await prisma.approvalStep.findMany({ where: { tenantId: tenant.id, requestType: 'pre_approval', requestId: req.id }, orderBy: { level: 'asc' } })
  check('it goes up the line: manager, then their manager', steps.map((s) => s.kind).join() === 'manager,skip_manager' && steps[0].status === 'pending', steps.map((s) => s.kind))
  check('…and the manager is notified', !!(await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId: lead.userId, type: 'approval.waiting' } })))

  r = await api(asMember, 'POST', '/expenses/claims', { claimType: 'actual', categoryId: (await prisma.expenseCategory.findFirst({ where: { tenantId: tenant.id, active: true } })).id, expenseDate: new Date().toISOString().slice(0, 10), description: 'Bus', expenseCurrency: tenant.baseCurrency || 'ZMW', expenseAmount: 100, expenseRequestId: req.id })
  check('bills cannot be submitted before approval (400)', r.status === 400, r.data)

  // ─── Approve up the chain ──────────────────────────────────
  r = await api(asBoss, 'POST', `/approvals/pre_approval/${req.id}/approve`, {})
  check('the second level cannot act before the first (403)', r.status === 403, r.data)
  r = await api(asMember, 'POST', `/approvals/pre_approval/${req.id}/approve`, {})
  check('nobody approves their own request (403)', r.status === 403, r.data)
  r = await api(asLead, 'GET', '/approvals/pending')
  check('the manager sees it waiting, with amount and purpose', r.body.some((p) => p.requestId === req.id && /Ndola/.test(p.summary) && /4,500/.test(p.summary)), r.body)
  r = await api(asLead, 'POST', `/approvals/pre_approval/${req.id}/approve`, { comments: 'OK from me' })
  check('the manager approves level 1; it stays pending for level 2', r.status === 200 && (await prisma.expenseRequest.findUnique({ where: { id: req.id } })).status === 'pending', r.data)
  r = await api(asFin, 'GET', '/expenses/requests?scope=finance')
  check('Finance does not see it until it is fully approved', r.status === 200 && !r.body.some((x) => x.id === req.id), r.body)
  r = await api(asBoss, 'POST', `/approvals/pre_approval/${req.id}/approve`, {})
  check('the manager’s manager approves: the request is approved', r.status === 200 && (await prisma.expenseRequest.findUnique({ where: { id: req.id } })).status === 'approved', r.data)
  check('…the employee and Finance are notified', !!(await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId: member.userId, type: 'pre_approval.approved' } })) && !!(await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId: fin.userId, type: 'pre_approval.for_finance' } })))
  r = await api(asFin, 'GET', '/expenses/requests?scope=finance')
  check('Finance now sees it', r.body.some((x) => x.id === req.id && x.amount === 4500), r.body)
  r = await api(asMember, 'GET', '/expenses/requests?scope=all')
  check('an employee cannot list everyone’s requests (403)', r.status === 403, r.status)

  // ─── Bills against it ──────────────────────────────────────
  const cat = await prisma.expenseCategory.findFirst({ where: { tenantId: tenant.id, active: true, OR: [{ maxAmount: null }, { maxAmount: { gte: 2000 } }] } })
  r = await api(asMember, 'POST', '/expenses/claims', { claimType: 'actual', categoryId: cat.id, expenseDate: new Date().toISOString().slice(0, 10), description: 'Hotel Ndola', expenseCurrency: tenant.baseCurrency || 'ZMW', expenseAmount: 1800, receiptNumber: 'H-1', expenseRequestId: req.id })
  check('the bill is submitted against the approved request', r.status === 201 && r.body.expenseRequest?.id === req.id, r.data)
  r = await api(as(fin, ['employee']), 'POST', '/expenses/claims', { claimType: 'actual', categoryId: cat.id, expenseDate: new Date().toISOString().slice(0, 10), description: 'x', expenseCurrency: 'ZMW', expenseAmount: 10, expenseRequestId: req.id })
  check('nobody else can bill against it (404)', r.status === 404, r.data)
  r = await api(asMember, 'GET', '/expenses/requests')
  check('the request shows what has been billed so far', r.body.find((x) => x.id === req.id)?.claimed === 1800, r.body)

  // ─── Close, reject, withdraw, money with no manager ────────
  r = await api(asMember, 'POST', `/expenses/requests/${req.id}/close`, {})
  check('only Finance closes a request (403)', r.status === 403, r.status)
  r = await api(asFin, 'POST', `/expenses/requests/${req.id}/close`, { note: 'Settled' })
  check('Finance marks it settled', r.status === 200 && r.body.status === 'closed', r.data)

  r = await api(asMember, 'POST', '/expenses/requests', { kind: 'money', purpose: 'Advance for samples', justification: 'Supplier wants cash on delivery', amount: 900 })
  const second = r.body
  r = await api(asLead, 'POST', `/approvals/pre_approval/${second.id}/reject`, {})
  check('rejecting needs a reason (400)', r.status === 400, r.data)
  r = await api(asLead, 'POST', `/approvals/pre_approval/${second.id}/reject`, { comments: 'Use the company card' })
  check('the manager rejects; later levels are skipped', r.status === 200 && (await prisma.expenseRequest.findUnique({ where: { id: second.id } })).status === 'rejected' && (await prisma.approvalStep.count({ where: { requestId: second.id, status: 'skipped' } })) === 1, r.data)

  r = await api(asMember, 'POST', '/expenses/requests', { kind: 'accommodation', purpose: 'Training in Lusaka', justification: 'Two-day course, no office nearby', amount: 1500, destination: 'Lusaka', startDate: '2026-12-01', endDate: '2026-12-02' })
  r = await api(asMember, 'POST', `/expenses/requests/${r.body.id}/withdraw`)
  check('the employee withdraws a pending request', r.status === 200 && r.body.status === 'withdrawn', r.data)

  r = await api(as(boss, ['employee']), 'POST', '/expenses/requests', { kind: 'money', purpose: 'Team lunch', justification: 'Quarterly team lunch for eight people', amount: 1200 })
  const top = await prisma.approvalStep.findMany({ where: { requestId: r.body.id } })
  check('someone with no manager goes to HR', top.length === 1 && top[0].kind === 'hr', top.map((s) => s.kind))

  // A chain set by HR replaces the default route
  await api(owner, 'POST', '/approvals/chains', { requestType: 'pre_approval', name: 'Spend: Finance only', levels: [{ kind: 'user', userId: fin.userId }] })
  r = await api(asMember, 'POST', '/expenses/requests', { kind: 'money', purpose: 'Conference ticket', justification: 'Industry conference, good leads', amount: 2500 })
  const chained = await prisma.approvalStep.findMany({ where: { requestId: r.body.id } })
  check('HR can set a chain for pre-approvals (here: one named Finance approver)', chained.length === 1 && chained[0].kind === 'user' && chained[0].userId === fin.userId, chained)
  r = await api(asFin, 'POST', `/approvals/pre_approval/${r.body.id}/approve`, {})
  check('…who approves it', r.status === 200, r.data)

  const audits = await prisma.auditLog.count({ where: { tenantId: tenant.id, entityType: 'expense_request', entityId: req.id } })
  check('the request’s steps are in the audit log', audits >= 3, audits)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

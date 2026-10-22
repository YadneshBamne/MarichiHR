// Policy queries (question → HR answer, with a response target) and policy exceptions (through the approval chain).
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `pq${Date.now() % 1e7}`

;(async () => {
  const admin = await tokenFor('admin@marichihr.com')
  const john = await tokenFor('john.banda@marichihr.com') // Jane's manager
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const policy = await prisma.policy.findFirst({ where: { tenantId: admin.tenantId, active: true } })
    ?? await prisma.policy.create({ data: { tenantId: admin.tenantId, title: `Remote work ${TAG}`, createdById: admin.userId } })

  // ─── Queries ──────────────────────────────────────────────
  let r = await api(jane, 'POST', '/policies/queries', { policyId: policy.id, question: `Can I work from home on Fridays? ${TAG}` })
  const q = r.body
  check('Jane asks HR a policy question', r.status === 201 && q.status === 'open' && new Date(q.dueAt) > new Date(), r.data)
  check('…HR is notified', !!(await prisma.notification.findFirst({ where: { userId: admin.userId, type: 'policy.query', entityId: q.id } })))
  r = await api(jane, 'GET', '/policies/queries?scope=all')
  check('only HR sees every question (403)', r.status === 403, r.status)
  r = await api(admin, 'GET', '/policies/queries?scope=all')
  check('HR sees it with the policy title and due time', r.body.some((x) => x.id === q.id && x.policy === policy.title && x.overdue === false), r.body?.slice(0, 2))
  r = await api(jane, 'POST', `/policies/queries/${q.id}/answer`, { answer: 'Yes' })
  check('only HR answers (403)', r.status === 403, r.status)
  r = await api(admin, 'POST', `/policies/queries/${q.id}/answer`, { answer: 'Yes, with your manager\'s agreement.', close: true })
  check('HR answers and closes it', r.status === 200 && r.body.status === 'closed', r.data)
  r = await api(jane, 'GET', '/policies/queries')
  check('Jane sees the answer', r.body.some((x) => x.id === q.id && /agreement/.test(x.answer)), r.body?.slice(0, 1))

  // ─── Exceptions ───────────────────────────────────────────
  r = await api(jane, 'POST', '/policies/exceptions', { policyId: policy.id, request: `Work from home every Friday ${TAG}`, reason: 'Long commute; I will stay reachable all day', startDate: '2026-11-01', endDate: '2026-12-31' })
  const x = r.body
  check('Jane asks for an exception', r.status === 201 && x.status === 'pending', r.data)
  const steps = await prisma.approvalStep.findMany({ where: { requestType: 'policy_exception', requestId: x.id }, orderBy: { level: 'asc' } })
  check('it goes to her manager, then HR', steps.map((s) => s.kind).join() === 'manager,hr', steps.map((s) => s.kind))
  r = await api(john, 'GET', '/approvals/pending')
  check('John sees it under Approvals', r.body.some((p) => p.requestId === x.id && /Policy exception/.test(p.summary)), r.body)
  r = await api(jane, 'POST', `/approvals/policy_exception/${x.id}/approve`, {})
  check('nobody approves their own exception (403)', r.status === 403, r.status)
  r = await api(john, 'POST', `/approvals/policy_exception/${x.id}/approve`, { comments: 'Fine by me' })
  check('John approves level 1; still pending', r.status === 200 && (await prisma.policyException.findUnique({ where: { id: x.id } })).status === 'pending', r.data)
  r = await api(admin, 'POST', `/approvals/policy_exception/${x.id}/approve`, {})
  check('HR approves: the exception is granted', r.status === 200 && (await prisma.policyException.findUnique({ where: { id: x.id } })).status === 'approved', r.data)
  check('…Jane is notified', !!(await prisma.notification.findFirst({ where: { userId: jane.userId, type: 'policy.exception.approved', entityId: x.id } })))
  r = await api(jane, 'GET', '/policies/exceptions')
  check('Jane sees it approved, with the trail', r.body.some((e) => e.id === x.id && e.status === 'approved' && e.trail.length === 2), r.body?.slice(0, 1))

  r = await api(jane, 'POST', '/policies/exceptions', { policyId: policy.id, request: `Second ${TAG}`, reason: 'Testing withdrawal of a request' })
  r = await api(jane, 'POST', `/policies/exceptions/${r.body.id}/withdraw`)
  check('Jane withdraws a pending one', r.status === 200 && r.body.status === 'withdrawn', r.data)

  await prisma.policyQuery.deleteMany({ where: { question: { contains: TAG } } })
  await done()
})()

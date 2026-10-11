// Recruitment: hiring requests and approval, the internal job board and referrals, who sees which candidate,
// interviews and feedback by the assigned interviewer only, offers, hiring into an employee record, isolation.
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `rc${Date.now() % 1e6}`

;(async () => {
  const admin = await tokenFor('admin@marichihr.com') // hr_admin
  const john = await tokenFor('john.banda@marichihr.com') // manager
  const jane = await tokenFor('jane.mutale@marichihr.com') // employee
  const johnEmp = await prisma.employee.findUnique({ where: { id: john.employeeId } })
  const johnUser = await prisma.user.findFirst({ where: { email: 'john.banda@marichihr.com' } })
  const janeUser = await prisma.user.findFirst({ where: { email: 'jane.mutale@marichihr.com' } })
  const openings = [], hiredEmployees = []

  // ─── Openings ──────────────────────────────────────────────
  let r = await api(jane, 'POST', '/recruitment/openings', { title: `Analyst ${TAG}`, orgUnitId: johnEmp.orgUnitId })
  check('an employee cannot open a position (403)', r.status === 403, r.status)
  r = await api(john, 'POST', '/recruitment/openings', { title: `Engineer ${TAG}`, orgUnitId: johnEmp.orgUnitId, openings: 1, salaryMin: 9000, salaryMax: 5000 })
  check('an upside-down salary range is refused (400)', r.status === 400, r.data)
  r = await api(john, 'POST', '/recruitment/openings', { title: `Engineer ${TAG}`, orgUnitId: johnEmp.orgUnitId, openings: 1, salaryMin: 5000, salaryMax: 9000 })
  const req = r.body
  openings.push(req?.id)
  check("a manager's request waits for HR approval, with them as hiring manager", r.status === 201 && req.status === 'pending_approval' && req.hiringManagerId === john.employeeId, r.data)
  check('…and HR is notified', !!(await prisma.notification.findFirst({ where: { entityId: req.id, type: 'recruitment.opening_requested' } })))
  r = await api(jane, 'GET', '/recruitment/openings')
  check('a pending request is not on the job board', !r.body.some((o) => o.id === req.id), r.body?.length)
  r = await api(john, 'POST', `/recruitment/openings/${req.id}/approve`, {})
  check('a manager cannot approve (403)', r.status === 403, r.status)
  r = await api(admin, 'POST', `/recruitment/openings/${req.id}/approve`, {})
  check('HR approves the request; it opens', r.status === 200 && r.body.status === 'open', r.data)
  r = await api(jane, 'GET', '/recruitment/openings')
  const board = r.body.find((o) => o.id === req.id)
  check('everyone sees open positions, without the pipeline', !!board && board.pipeline === null && board.canManage === false, board)

  r = await api(admin, 'POST', '/recruitment/openings', { title: `Designer ${TAG}`, orgUnitId: johnEmp.orgUnitId })
  const own = r.body
  openings.push(own?.id)
  check('HR creates an opening that is open straight away', r.status === 201 && own.status === 'open', r.data)

  // ─── Candidates & referrals ────────────────────────────────
  r = await api(jane, 'POST', `/recruitment/openings/${req.id}/candidates`, { firstName: 'Ann', lastName: 'Phiri', email: `ann.${TAG}@example.com` })
  check('an employee cannot add candidates directly (403)', r.status === 403, r.status)
  r = await api(jane, 'POST', `/recruitment/openings/${req.id}/refer`, { firstName: 'Ann', lastName: 'Phiri', email: `Ann.${TAG}@Example.com`, resumeUrl: 'https://example.com/ann.pdf' })
  const ann = r.body
  check('…but can refer someone', r.status === 201 && ann.source === 'referral' && ann.referredByEmployeeId === jane.employeeId, r.data)
  check('the hiring manager hears about the referral', !!(await prisma.notification.findFirst({ where: { entityId: ann.id, userId: johnUser.id, type: 'recruitment.referral' } })))
  r = await api(john, 'POST', `/recruitment/openings/${req.id}/candidates`, { firstName: 'Ann', lastName: 'Phiri', email: `ann.${TAG}@example.com` })
  check('the same person twice for one opening is refused (409)', r.status === 409, r.status)
  r = await api(jane, 'POST', `/recruitment/openings/${req.id}/refer`, { firstName: 'X', lastName: 'Y', email: `x.${TAG}@example.com`, resumeUrl: 'javascript:alert(1)' })
  check('a non-http resume link is refused (400)', r.status === 400, r.status)
  r = await api(john, 'POST', `/recruitment/openings/${req.id}/candidates`, { firstName: 'Ben', lastName: 'Zulu', email: `ben.${TAG}@example.com`, source: 'job_board' })
  const ben = r.body
  check('the hiring manager adds a candidate', r.status === 201 && ben.stage === 'applied', r.data)
  r = await api(jane, 'GET', '/recruitment/referrals/mine')
  check('the referrer tracks their referral', r.body.some((x) => x.id === ann.id && x.stage === 'applied'), r.body)
  r = await api(jane, 'GET', `/recruitment/candidates/${ben.id}`)
  check("an employee cannot open someone else's candidate (404)", r.status === 404, r.status)
  r = await api(admin, 'GET', `/recruitment/openings/${req.id}`)
  check('HR sees the pipeline with contact details', r.body.candidates.length === 2 && r.body.candidates.every((c) => c.email), r.body?.candidates)

  // ─── Stages & interviews ───────────────────────────────────
  r = await api(john, 'PATCH', `/recruitment/candidates/${ben.id}`, { stage: 'rejected' })
  check('rejecting needs a reason (400)', r.status === 400, r.status)
  r = await api(john, 'PATCH', `/recruitment/candidates/${ben.id}`, { stage: 'rejected', rejectionReason: 'Not enough experience' })
  check('the hiring manager rejects with a reason', r.status === 200 && r.body.stage === 'rejected', r.data)
  r = await api(john, 'PATCH', `/recruitment/candidates/${ben.id}`, { stage: 'screening' })
  check('only HR can bring a rejected candidate back (400)', r.status === 400, r.status)
  r = await api(john, 'PATCH', `/recruitment/candidates/${ann.id}`, { stage: 'hired' })
  check('hiring is not a stage you can just set (400)', r.status === 400, r.status)
  r = await api(john, 'POST', `/recruitment/candidates/${ann.id}/interviews`, { interviewerUserId: janeUser.id, scheduledAt: '2026-11-02T09:00:00Z', mode: 'video' })
  const iv = r.body
  check('the hiring manager schedules an interview; the candidate moves to interview', r.status === 201 && (await prisma.candidate.findUnique({ where: { id: ann.id } })).stage === 'interview', r.data)
  check('…and the interviewer is notified', !!(await prisma.notification.findFirst({ where: { entityId: iv.id, userId: janeUser.id, type: 'recruitment.interview' } })))
  r = await api(jane, 'GET', '/recruitment/interviews/mine')
  check('the interviewer sees it in their interviews', r.body.some((x) => x.id === iv.id), r.body)
  r = await api(jane, 'GET', `/recruitment/candidates/${ann.id}`)
  check('the interviewer can open the candidate, without contact details or offer terms', r.status === 200 && !r.body.email && r.body.offerCtcAnnual === undefined && r.body.interviews.length === 1, r.body)
  r = await api(admin, 'POST', `/recruitment/interviews/${iv.id}/feedback`, { rating: 5, recommendation: 'hire', feedback: 'Writing for someone else' })
  check('only the assigned interviewer gives feedback (404)', r.status === 404, r.status)
  r = await api(jane, 'POST', `/recruitment/interviews/${iv.id}/feedback`, { rating: 4, recommendation: 'strong_hire', feedback: 'Clear thinker, good systems design.' })
  check('the interviewer submits feedback', r.status === 200 && r.body.status === 'completed' && r.body.rating === 4, r.data)
  check('…and the hiring manager hears about it', !!(await prisma.notification.findFirst({ where: { entityId: iv.id, userId: johnUser.id, type: 'recruitment.feedback' } })))

  // ─── Offer & hire ──────────────────────────────────────────
  r = await api(john, 'POST', `/recruitment/candidates/${ann.id}/offer`, { ctcAnnual: 84000, joiningDate: '2026-12-01' })
  check('a manager cannot make offers (403)', r.status === 403, r.status)
  r = await api(admin, 'POST', `/recruitment/candidates/${ann.id}/hire`, { workEmail: `ann.${TAG}@marichihr.com` })
  check('no hiring without an accepted offer (400)', r.status === 400, r.data)
  r = await api(admin, 'POST', `/recruitment/candidates/${ann.id}/offer`, { ctcAnnual: 84000, joiningDate: '2026-12-01', note: 'Standard benefits' })
  check('HR makes an offer', r.status === 200 && r.body.stage === 'offer' && r.body.offerStatus === 'made', r.data)
  r = await api(admin, 'POST', `/recruitment/candidates/${ann.id}/offer-response`, { accepted: true })
  check('the offer is accepted', r.status === 200 && r.body.offerStatus === 'accepted', r.data)
  r = await api(admin, 'POST', `/recruitment/candidates/${ann.id}/hire`, { workEmail: 'admin@marichihr.com' })
  check('hiring with an email already in use is refused (409) and the candidate stays at offer', r.status === 409 && (await prisma.candidate.findUnique({ where: { id: ann.id } })).stage === 'offer', r.data)
  r = await api(admin, 'POST', `/recruitment/candidates/${ann.id}/hire`, { workEmail: `ann.${TAG}@marichihr.com`, referralBonus: 500 })
  const emp = r.body?.employee
  if (emp) hiredEmployees.push(emp.id)
  const empRow = emp && await prisma.employee.findUnique({ where: { id: emp.id }, include: { user: true } })
  check('hiring creates the employee: right team, manager, joining date, no login', r.status === 201 && empRow.managerId === john.employeeId && empRow.orgUnitId === johnEmp.orgUnitId && empRow.hireDate.toISOString().startsWith('2026-12-01') && !empRow.user.passwordHash, r.data)
  check('the last seat filled closes the opening', r.body?.openingFilled === true && (await prisma.jobOpening.findUnique({ where: { id: req.id } })).status === 'closed')
  const inc = r.body?.referralIncentive
  check('a referral bonus nomination is raised for the referrer (approved separately)', inc && inc.employeeId === jane.employeeId && inc.status === 'nominated' && Number(inc.amount) === 500, inc)
  check('the referrer hears their referral joined', !!(await prisma.notification.findFirst({ where: { entityId: ann.id, userId: janeUser.id, type: 'recruitment.referral_hired' } })))
  r = await api(admin, 'POST', `/recruitment/candidates/${ann.id}/hire`, { workEmail: `ann2.${TAG}@marichihr.com` })
  check('hiring twice is refused (400)', r.status === 400, r.status)

  // ─── Isolation ─────────────────────────────────────────────
  const other = await prisma.tenant.findFirst({ where: { slug: { not: 'marichi-labs' }, active: true } })
  const otherUnit = await prisma.orgUnit.findFirst({ where: { tenantId: other.id } })
  r = await api(admin, 'POST', '/recruitment/openings', { title: `Cross ${TAG}`, orgUnitId: otherUnit.id })
  check("another company's department cannot be used (404)", r.status === 404, r.status)
  const foreign = await prisma.jobOpening.create({ data: { tenantId: other.id, title: `Foreign ${TAG}`, orgUnitId: otherUnit.id, currency: 'USD', requestedByUserId: johnUser.id } })
  r = await api(admin, 'GET', `/recruitment/openings/${foreign.id}`)
  check("another company's opening is invisible (404)", r.status === 404, r.status)
  r = await api(jane, 'POST', `/recruitment/openings/${foreign.id}/refer`, { firstName: 'A', lastName: 'B', email: `ab.${TAG}@example.com` })
  check("…and cannot take referrals (404)", r.status === 404, r.status)

  // ─── Cleanup ───────────────────────────────────────────────
  openings.push(foreign.id)
  if (inc?.id) await prisma.incentive.delete({ where: { id: inc.id } }).catch(() => {})
  const cands = await prisma.candidate.findMany({ where: { openingId: { in: openings.filter(Boolean) } }, select: { id: true } })
  await prisma.interview.deleteMany({ where: { candidateId: { in: cands.map((c) => c.id) } } })
  await prisma.candidate.deleteMany({ where: { openingId: { in: openings.filter(Boolean) } } })
  await prisma.jobOpening.deleteMany({ where: { id: { in: openings.filter(Boolean) } } })
  for (const id of hiredEmployees) {
    const e = await prisma.employee.update({ where: { id }, data: { active: false, employmentStatus: 'terminated' } }).catch(() => null)
    if (e) await prisma.user.update({ where: { id: e.userId }, data: { active: false } }).catch(() => {})
  }
  await done()
})()

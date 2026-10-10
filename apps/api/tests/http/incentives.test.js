// Incentives: default types, who may nominate whom, caps, approval by someone other than the nominator, what each
// person sees, posting approved awards into an open payroll run (and payroll's own maker-checker), isolation.
// Uses a throwaway payroll run in INC_MONTH (default 2032-01) and removes it at the end.
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `in${Date.now() % 1e6}`
const MONTH = process.env.INC_MONTH || '2032-01'

;(async () => {
  const admin = await tokenFor('admin@marichihr.com') // hr_admin
  const john = await tokenFor('john.banda@marichihr.com') // manager of Jane
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const finance = await tokenFor('finance@marichihr.com') // payroll_admin
  const made = []

  // ─── Types ─────────────────────────────────────────────────
  let r = await api(jane, 'GET', '/incentives/types')
  const types = r.body
  const spot = types.find((t) => t.code === 'SPOT'), perf = types.find((t) => t.code === 'PERFORMANCE')
  check('default incentive types exist, each paid as a payroll earning', r.status === 200 && spot && perf && types.every((t) => t.payrollInputTypeId), types)
  r = await api(admin, 'PATCH', `/incentives/types/${spot.id}`, { maxAmount: 1000 })
  check('HR caps the spot award at 1000', r.status === 200 && Number(r.body.maxAmount) === 1000, r.data)
  r = await api(john, 'PATCH', `/incentives/types/${spot.id}`, { maxAmount: 1 })
  check('a manager cannot change types (403)', r.status === 403, r.status)

  // ─── Nominate ──────────────────────────────────────────────
  r = await api(jane, 'POST', '/incentives', { employeeId: john.employeeId, typeId: spot.id, amount: 100, reason: 'Great support' })
  check('an employee cannot nominate (403)', r.status === 403, r.status)
  r = await api(john, 'POST', '/incentives', { employeeId: admin.employeeId, typeId: spot.id, amount: 100, reason: 'Thanks boss' })
  check('a manager can only nominate their own team (403)', r.status === 403, r.data)
  r = await api(admin, 'POST', '/incentives', { employeeId: admin.employeeId, typeId: spot.id, amount: 100, reason: 'Me, me, me' })
  check('nobody can nominate themselves (403)', r.status === 403, r.data)
  r = await api(john, 'POST', '/incentives', { employeeId: jane.employeeId, typeId: spot.id, amount: 2000, reason: 'Too generous' })
  check('the cap is enforced (400)', r.status === 400, r.data)
  r = await api(john, 'POST', '/incentives', { employeeId: jane.employeeId, typeId: spot.id, amount: 750, reason: `Fixed the release ${TAG}` })
  const a1 = r.body
  made.push(a1?.id)
  check('a manager nominates their report', r.status === 201 && a1.status === 'nominated' && Number(a1.amount) === 750, r.data)
  check("the nominee doesn't see a pending nomination", !(await api(jane, 'GET', '/incentives')).body.some((x) => x.id === a1.id))
  check('the nominator does', (await api(john, 'GET', '/incentives')).body.some((x) => x.id === a1.id))

  // ─── Decide ────────────────────────────────────────────────
  r = await api(john, 'POST', `/incentives/${a1.id}/approve`, {})
  check('a manager cannot approve (403)', r.status === 403, r.status)
  r = await api(admin, 'POST', `/incentives/${a1.id}/approve`, {})
  check('HR approves', r.status === 200 && r.body.status === 'approved', r.data)
  r = await api(admin, 'POST', `/incentives/${a1.id}/approve`, {})
  check('deciding twice is refused (400)', r.status === 400, r.status)
  const janeAwards = (await api(jane, 'GET', '/incentives')).body
  check('the employee now sees the award', janeAwards.some((x) => x.id === a1.id && x.status === 'approved'), janeAwards)
  const janeUser = await prisma.user.findFirst({ where: { email: 'jane.mutale@marichihr.com' } })
  check('…and is notified', !!(await prisma.notification.findFirst({ where: { userId: janeUser.id, entityId: a1.id, type: 'incentive.awarded' } })))

  r = await api(admin, 'POST', '/incentives', { employeeId: jane.employeeId, typeId: perf.id, amount: 3000, reason: `Quarter goals ${TAG}` })
  const a2 = r.body
  made.push(a2?.id)
  r = await api(admin, 'POST', `/incentives/${a2.id}/approve`, {})
  check('HR cannot approve their own nomination (403)', r.status === 403, r.data)
  r = await api(admin, 'POST', `/incentives/${a2.id}/cancel`)
  check('…but can cancel it', r.status === 200, r.data)
  r = await api(john, 'POST', '/incentives', { employeeId: jane.employeeId, typeId: spot.id, amount: 50, reason: `Small thanks ${TAG}` })
  const a3 = r.body
  made.push(a3?.id)
  r = await api(admin, 'POST', `/incentives/${a3.id}/reject`, {})
  check('rejecting needs a reason (400)', r.status === 400, r.status)
  r = await api(admin, 'POST', `/incentives/${a3.id}/reject`, { note: 'Already covered by the spot award' })
  check('HR rejects with a reason', r.status === 200 && r.body.status === 'rejected', r.data)

  // ─── Post to payroll ───────────────────────────────────────
  const last = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5)), 0)).toISOString().slice(0, 10)
  let cycle = await prisma.payrollCycle.findFirst({ where: { tenantId: admin.tenantId, payPeriodStart: new Date(`${MONTH}-01T00:00:00Z`) } })
  if (!cycle) cycle = (await api(admin, 'POST', '/payroll/cycles', { payPeriodStart: `${MONTH}-01`, payPeriodEnd: last })).body
  r = await api(jane, 'POST', '/incentives/post', { cycleId: cycle.id, incentiveIds: [a1.id] })
  check('an employee cannot post to payroll (403)', r.status === 403, r.status)
  r = await api(finance, 'POST', '/incentives/post', { cycleId: cycle.id, incentiveIds: [a3.id] })
  check('a rejected award cannot be posted (400)', r.status === 400, r.data)
  r = await api(finance, 'POST', '/incentives/post', { cycleId: cycle.id, incentiveIds: [a1.id] })
  check('payroll admin posts the approved award to an open run', r.status === 200 && r.body.posted === 1, r.data)
  const posted = await prisma.incentive.findUnique({ where: { id: a1.id } })
  const input = posted.payrollInputId && await prisma.payrollInput.findUnique({ where: { id: posted.payrollInputId } })
  check('it became a payroll input for the right person and amount', posted.status === 'posted' && input && input.employeeId === jane.employeeId && Number(input.amount) === 750 && input.payrollCycleId === cycle.id, { posted, input })
  r = await api(finance, 'POST', '/incentives/post', { cycleId: cycle.id, incentiveIds: [a1.id] })
  check('posting twice is refused (400)', r.status === 400, r.data)
  r = await api(finance, 'POST', `/payroll/inputs/${input.id}/approve`)
  check("payroll's maker-checker still applies: the poster cannot approve the input (403)", r.status === 403, r.status)
  r = await api(admin, 'POST', `/payroll/inputs/${input.id}/approve`)
  check('…someone else can', r.status === 200, r.data)

  // ─── Isolation ─────────────────────────────────────────────
  const otherTenant = await prisma.tenant.findFirst({ where: { slug: { not: 'marichi-labs' }, active: true } })
  const foreignType = await prisma.incentiveType.create({ data: { tenantId: otherTenant.id, code: `X${TAG}`.toUpperCase().slice(0, 20), name: 'Foreign' } })
  r = await api(admin, 'POST', '/incentives', { employeeId: jane.employeeId, typeId: foreignType.id, amount: 10, reason: 'cross-company' })
  check("another company's incentive type cannot be used (404)", r.status === 404, r.status)
  const foreignEmp = await prisma.employee.findFirst({ where: { tenantId: otherTenant.id } })
  r = await api(admin, 'POST', '/incentives', { employeeId: foreignEmp.id, typeId: spot.id, amount: 10, reason: 'cross-company' })
  check("another company's employee cannot be nominated (404)", r.status === 404, r.status)

  // ─── Cleanup ───────────────────────────────────────────────
  await prisma.incentiveType.delete({ where: { id: foreignType.id } })
  await api(admin, 'PATCH', `/incentives/types/${spot.id}`, { maxAmount: null })
  await prisma.payrollInput.deleteMany({ where: { payrollCycleId: cycle.id } })
  await prisma.incentive.deleteMany({ where: { id: { in: made.filter(Boolean) } } })
  if (cycle.status === 'draft' || (await prisma.payrollCycle.findUnique({ where: { id: cycle.id } })).status === 'draft') {
    await prisma.payrollCycle.delete({ where: { id: cycle.id } }).catch(() => {})
  }
  await done()
})()

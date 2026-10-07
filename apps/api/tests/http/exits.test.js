// Prompt 20 verification: exit → clearance → F&F compute → maker-checker approval → payment (contract closed, employee archived).
// Creates two throwaway employees each run. Uses FNF_MONTH (default 2027-02) for the last working day and a payroll cycle.
const { api, tokenFor, check, done, prisma, round2, sum } = require('./lib')

const FNF_MONTH = process.env.FNF_MONTH || '2027-02'
const TAG = `p20-${Date.now()}`

;(async () => {
  const admin = await tokenFor('admin@marichihr.com')
  const finance = await tokenFor('finance@marichihr.com')
  const john = await tokenFor('john.banda@marichihr.com')
  const jane = await tokenFor('jane.mutale@marichihr.com')

  // ─── SETUP: a leaver (reports to John, ZM contract) and a facilities user for the ADMIN sign-off ──
  const johnEmp = await prisma.employee.findUnique({ where: { id: john.employeeId } })
  const mk = async (first) => {
    const r = await api(admin, 'POST', '/employees', {
      firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@marichihr.com`, orgUnitId: johnEmp.orgUnitId,
      managerId: john.employeeId, hireDate: '2026-01-01', employmentType: 'full_time',
    })
    if (r.status !== 201) throw new Error(`create ${first}: ${JSON.stringify(r.data)}`)
    return { emp: r.body.employee, who: await tokenFor(`${first.toLowerCase()}.${TAG}@marichihr.com`) }
  }
  const leaver = await mk('Leaver')
  const facilities = await mk('Facilities')

  const zm = (await api(admin, 'GET', '/salary/structures')).body.find((s) => s.countryCode === 'ZM')
  let r = await api(admin, 'POST', '/leave/contracts', {
    employeeId: leaver.emp.id, ctcAnnual: 240000, wageMonthly: 20000, currency: 'ZMW', effectiveFrom: '2026-01-01', noticePeriodDays: 30, salaryStructureId: zm.id,
  })
  const contract = r.body
  check('setup: contract with 30-day notice', r.status === 201 && contract.noticePeriodDays === 30, r.data)
  for (const step of ['draft', 'confirm', 'activate']) await api(admin, 'POST', `/leave/contracts/${contract.id}/${step}`, {})
  const annual = (await api(admin, 'GET', '/leave/types')).body.find((t) => t.code === 'ANNUAL')
  r = await api(admin, 'POST', '/leave/allocations/manual', { employeeId: leaver.emp.id, leaveTypeId: annual.id, daysAllocated: 10, validFrom: '2026-01-01', reason: TAG, allocationType: 'manual' })
  check('setup: 10 days ANNUAL (encashable) allocated', r.status === 201, r.data)

  const cats = (await api(leaver.who, 'GET', '/expenses/categories')).body
  const claim = (await api(leaver.who, 'POST', '/expenses/claims', { claimType: 'actual', categoryId: cats.find((c) => c.code === 'COMM').id, expenseCurrency: 'ZMW', expenseAmount: 300, expenseDate: '2026-10-02', description: TAG })).body
  await api(john, 'POST', `/expenses/claims/${claim.id}/approve`)
  r = await api(finance, 'POST', `/expenses/claims/${claim.id}/finance-approve`)
  check('setup: leaver has a finance-approved 300 ZMW claim', r.status === 200 && r.body.status === 'finance_approved', r.data)

  // ─── INITIATE ───────────────────────────────────────────────
  const lwd = `${FNF_MONTH}-12`
  const [y, m] = FNF_MONTH.split('-').map(Number)
  const noticeDate = new Date(Date.UTC(y, m - 1, 12 - 23)).toISOString().slice(0, 10) // 23 days before LWD
  const base = { employeeId: leaver.emp.id, exitType: 'resignation', reason: TAG, noticeDate, lastWorkingDate: lwd }
  const clearance = { IT: admin.userId, FINANCE: finance.userId, ADMIN: facilities.who.userId }

  r = await api(admin, 'POST', '/exits', { ...base, clearance: { ...clearance, ADMIN: admin.userId } })
  check('same user on two clearances is 400', r.status === 400 && /different user/.test(r.data.message), r.data)
  r = await api(admin, 'POST', '/exits', { ...base, clearance: { ...clearance, ADMIN: leaver.who.userId } })
  check('exiting employee as a signer is 400', r.status === 400, r.data)
  r = await api(admin, 'POST', '/exits', { ...base, clearance, status: 'paid' })
  check('strict body: extra key is 400', r.status === 400, r.data)
  r = await api(admin, 'POST', '/exits', { ...base, lastWorkingDate: noticeDate, noticeDate: lwd, clearance })
  check('last working day before notice date is 400', r.status === 400, r.data)
  r = await api(finance, 'POST', '/exits', { ...base, clearance })
  check('payroll_admin cannot initiate (403)', r.status === 403, r.data)

  r = await api(admin, 'POST', '/exits', { ...base, clearance })
  const exit = r.body
  check('HR initiates resignation: 201', r.status === 201 && exit.status === 'initiated', r.data)
  check('notice from contract: 30 days, served 23, shortfall 7, action recover', exit.noticePeriodDays === 30 && exit.noticeServedDays === 23 && exit.shortfallDays === 7 && exit.shortfallAction === 'recover', exit)
  check('MANAGER clearance defaults to the direct manager (John)', exit.clearances.find((c) => c.department === 'MANAGER').responsibleUserId === john.userId, exit.clearances)
  r = await api(admin, 'POST', '/exits', { ...base, clearance })
  check('second open exit for the same employee is 409', r.status === 409, r.data)

  // ─── ACCESS ─────────────────────────────────────────────────
  check('John (manager) cannot list exits (403)', (await api(john, 'GET', '/exits')).status === 403)
  check('John sees the exit he must sign (200)', (await api(john, 'GET', `/exits/${exit.id}`)).status === 200)
  check('Jane (unrelated) gets 404', (await api(jane, 'GET', `/exits/${exit.id}`)).status === 404)
  const mine = (await api(john, 'GET', '/exits/clearances/mine')).body
  check("John's pending sign-offs include MANAGER for this exit", mine.some((c) => c.exitId === exit.id && c.department === 'MANAGER'), mine)

  // ─── CLEARANCE ──────────────────────────────────────────────
  r = await api(admin, 'POST', `/exits/${exit.id}/compute`, {})
  check('compute before clearance is blocked (400, lists pending)', r.status === 400 && /IT/.test(r.data.message) && /MANAGER/.test(r.data.message), r.data)
  r = await api(john, 'POST', `/exits/${exit.id}/clearances/IT/sign`, {})
  check('John cannot sign the IT clearance (403)', r.status === 403, r.data)
  r = await api(jane, 'POST', `/exits/${exit.id}/clearances/IT/sign`, {})
  check('unrelated user signing gets 404', r.status === 404, r.data)
  for (const [who, dept] of [[admin, 'IT'], [finance, 'FINANCE'], [facilities.who, 'ADMIN'], [john, 'MANAGER']]) {
    r = await api(who, 'POST', `/exits/${exit.id}/clearances/${dept}/sign`, { note: TAG })
    check(`${dept} signed off by its responsible user`, r.status === 200 && r.body.clearances.find((c) => c.department === dept).status === 'cleared', r.data)
  }
  r = await api(john, 'POST', `/exits/${exit.id}/clearances/MANAGER/sign`, {})
  check('signing twice is 400', r.status === 400, r.data)

  // ─── PAYROLL SKIPS THE LEAVER ───────────────────────────────
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  const leftover = await prisma.payrollCycle.findFirst({ where: { tenantId: admin.tenantId, payPeriodStart: new Date(`${FNF_MONTH}-01T00:00:00Z`) } })
  let cycle = leftover
  if (!cycle) cycle = (await api(admin, 'POST', '/payroll/cycles', { payPeriodStart: `${FNF_MONTH}-01`, payPeriodEnd: last })).body
  if (['draft', 'review'].includes(cycle.status)) {
    await api(admin, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
    const run = await api(admin, 'POST', `/payroll/cycles/${cycle.id}/run`)
    check(`${FNF_MONTH} payroll run skips the leaver ("full & final")`, run.status === 200 && run.body.skipped.some((s) => s.employeeId === leaver.emp.id && /final settlement/.test(s.reason)), run.data)
  }

  // ─── COMPUTE ────────────────────────────────────────────────
  r = await api(finance, 'POST', `/exits/${exit.id}/compute`, {})
  check('payroll_admin cannot compute (403)', r.status === 403, r.data)
  r = await api(admin, 'POST', `/exits/${exit.id}/compute`, { recoveries: [{ description: 'Unreturned laptop', amount: 500 }] })
  const fnf = r.body
  check('HR computes: status computed', r.status === 200 && fnf.status === 'computed' && fnf.computedBy === admin.userId, r.data)
  const L = (code) => fnf.lines.find((l) => l.code === code)
  // Feb 2027: 20 weekdays, 1–12 Feb = 10 → factor 0.5. BASIC = 20000 × 0.40 = 8000/month → 4000 prorated; 8000/30 = 266.67/day
  check('salary prorated by the payroll engine: BASIC 4000 (half of 8000)', L('BASIC')?.amount === 4000 && L('BASIC').section === 'salary', L('BASIC'))
  check('salary carries PAYE and NAPSA from the engine', !!L('PAYE_ZM') && L('PAYE_ZM').kind === 'deduction' && !!L('NAPSA_EMP'), fnf.lines.map((l) => l.code))
  check('leave encashment: 10 days × 266.67 = 2666.7', L('ENCASH_ANNUAL')?.amount === 2666.7 && L('ENCASH_ANNUAL').quantity === 10, L('ENCASH_ANNUAL'))
  check('notice shortfall recovery: 7 × 266.67 = 1866.69 (deduction)', L('NOTICE_RECOVERY')?.amount === 1866.69 && L('NOTICE_RECOVERY').kind === 'deduction', L('NOTICE_RECOVERY'))
  const reimb = fnf.lines.filter((l) => l.section === 'reimbursement')
  check('pending approved reimbursement included (300)', reimb.length === 1 && reimb[0].amount === 300 && reimb[0].sourceRefId === claim.id, reimb)
  check('manual recovery line (500)', L('RECOVERY_1')?.amount === 500 && L('RECOVERY_1').kind === 'deduction', L('RECOVERY_1'))
  check('gratuity is a labelled 0 placeholder', L('GRATUITY')?.amount === 0 && /PLACEHOLDER/.test(L('GRATUITY').name), L('GRATUITY'))
  const earn = sum(fnf.lines.filter((l) => l.kind === 'earning').map((l) => l.amount))
  const ded = sum(fnf.lines.filter((l) => l.kind === 'deduction').map((l) => l.amount))
  check(`totals: earnings ${earn} − deductions ${ded} = net ${fnf.netPayable}`, fnf.totalEarnings === earn && fnf.totalDeductions === ded && fnf.netPayable === round2(earn - ded), fnf)

  // ─── MAKER-CHECKER ──────────────────────────────────────────
  r = await api(admin, 'POST', `/exits/${exit.id}/approve`)
  check('HR who computed cannot approve (403)', r.status === 403, r.data)
  r = await api(john, 'POST', `/exits/${exit.id}/approve`)
  check('manager without payroll:disburse cannot approve (403)', r.status === 403, r.data)
  r = await api(finance, 'POST', `/exits/${exit.id}/pay`)
  check('pay before approval is 400', r.status === 400, r.data)
  r = await api(finance, 'POST', `/exits/${exit.id}/approve`)
  check('finance approves (different user)', r.status === 200 && r.body.status === 'approved' && r.body.approvedBy === finance.userId, r.data)
  r = await api(admin, 'POST', `/exits/${exit.id}/compute`, {})
  check('recompute after approval is 400', r.status === 400, r.data)
  r = await api(admin, 'POST', `/exits/${exit.id}/cancel`, { reason: 'x' })
  check('cancel after approval is refused (409)', r.status === 409, r.data)

  const pdf = await api(finance, 'GET', `/exits/${exit.id}/settlement.pdf`)
  check('final settlement PDF (%PDF)', pdf.status === 200 && Buffer.isBuffer(pdf.data) && pdf.data.slice(0, 4).toString() === '%PDF', pdf.status)

  // ─── PAY ────────────────────────────────────────────────────
  r = await api(finance, 'POST', `/exits/${exit.id}/pay`)
  check('finance pays: status paid', r.status === 200 && r.body.status === 'paid' && !!r.body.paidAt, r.data)
  const emp = await prisma.employee.findUnique({ where: { id: leaver.emp.id }, include: { user: true } })
  check('employee archived (active=false, terminated) and login deactivated', emp.active === false && emp.employmentStatus === 'terminated' && emp.user.active === false, { active: emp.active, status: emp.employmentStatus, userActive: emp.user.active })
  const c = await prisma.employeeContract.findUnique({ where: { id: contract.id }, include: { stateTransitions: { orderBy: { createdAt: 'desc' }, take: 1 } } })
  check('contract closed via state machine: running → expired, effectiveUntil = LWD', c.status === 'expired' && c.effectiveUntil.toISOString().slice(0, 10) === lwd && c.stateTransitions[0].fromState === 'running' && c.stateTransitions[0].toState === 'expired', { status: c.status, until: c.effectiveUntil, t: c.stateTransitions[0] })
  const paidClaim = await prisma.reimbursementClaim.findUnique({ where: { id: claim.id } })
  check('reimbursement marked paid by the settlement', paidClaim.status === 'paid' && !!paidClaim.paidAt && !paidClaim.paidInCycleId, paidClaim.status)
  const bal = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId: { employeeId: leaver.emp.id, leaveTypeId: annual.id } } })
  check('encashed days recorded on the leave balance (10)', bal.encashedDays === 10, bal)
  const events = (await prisma.domainEvent.findMany({ where: { tenantId: admin.tenantId, createdAt: { gte: new Date(exit.createdAt) } }, select: { eventType: true, payload: true } }))
    .filter((e) => e.payload.exitId === exit.id || e.payload.employeeId === leaver.emp.id || e.payload.contractId === contract.id).map((e) => e.eventType)
  check('domain events recorded', ['exit.initiated', 'exit.clearance.signed', 'exit.clearance.completed', 'fnf.computed', 'fnf.approved', 'fnf.paid', 'contract.expired', 'employee.archived'].every((t) => events.includes(t)), events)

  r = await api(finance, 'POST', `/exits/${exit.id}/pay`)
  check('paying twice is 400 (immutable)', r.status === 400, r.data)
  r = await api(admin, 'POST', `/exits/${exit.id}/compute`, {})
  check('recompute after payment is 400', r.status === 400, r.data)

  // ─── TERMINATION DEFAULTS + CANCEL ──────────────────────────
  r = await api(admin, 'POST', '/exits', { employeeId: facilities.emp.id, exitType: 'termination', reason: TAG, noticeDate: lwd, lastWorkingDate: lwd, clearance: { IT: admin.userId, FINANCE: finance.userId, ADMIN: jane.userId } })
  check('termination defaults to buyout; no contract → notice 0', r.status === 201 && r.body.shortfallAction === 'buyout' && r.body.noticePeriodDays === 0, r.data)
  const t = r.body
  r = await api(admin, 'POST', `/exits/${t.id}/cancel`, { reason: TAG })
  const fac = await prisma.employee.findUnique({ where: { id: facilities.emp.id } })
  check('HR cancels: status cancelled, exitDate cleared', r.status === 200 && r.body.status === 'cancelled' && fac.exitDate === null, r.data)
  await api(admin, 'POST', `/employees/${facilities.emp.id}/archive`, { reason: TAG })

  await done()
})().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})

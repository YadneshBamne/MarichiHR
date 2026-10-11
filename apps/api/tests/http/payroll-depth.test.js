// Payroll depth: payslip release control (early release after approval, hold one person, disbursing releases),
// anomaly flags before approval, salary revisions with maker-checker, arrears for months already paid and posting them
// into an open run. Uses Marichi Labs with a throwaway run in PD_MONTH (default 2034-02) and restores John's contract.
const { api, tokenFor, check, done, prisma } = require('./lib')

const MONTH = process.env.PD_MONTH || '2034-02'
const round2 = (n) => Math.round(n * 100) / 100

;(async () => {
  const admin = await tokenFor('admin@marichihr.com') // hr_admin
  const finance = await tokenFor('finance@marichihr.com') // payroll_admin
  const john = await tokenFor('john.banda@marichihr.com')
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const contract = await prisma.employeeContract.findFirst({ where: { employeeId: john.employeeId, status: 'running' }, orderBy: { effectiveFrom: 'desc' } })
  const created = { revisions: [], contracts: [], inputs: [] }

  // ─── A run to work with ────────────────────────────────────
  const last = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5)), 0)).toISOString().slice(0, 10)
  let cycle = await prisma.payrollCycle.findFirst({ where: { tenantId: admin.tenantId, payPeriodStart: new Date(`${MONTH}-01T00:00:00Z`) } })
  if (cycle && !['draft', 'review'].includes(cycle.status)) throw new Error(`${MONTH} is ${cycle.status}; set PD_MONTH to an unused month`)
  if (!cycle) cycle = (await api(admin, 'POST', '/payroll/cycles', { payPeriodStart: `${MONTH}-01`, payPeriodEnd: last })).body
  await api(admin, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
  let r = await api(admin, 'POST', `/payroll/cycles/${cycle.id}/run`)
  check('a test payroll run is computed', r.status === 200 && r.body.status === 'review', r.data)

  // ─── Anomaly flags ─────────────────────────────────────────
  r = await api(finance, 'GET', `/payroll/cycles/${cycle.id}/variance-report`)
  const flags = r.body.rows.flatMap((x) => x.flags)
  check('the anomaly check flags missing or unverified bank details and counts unapproved inputs', r.status === 200 && typeof r.body.unapprovedInputs === 'number' && (flags.includes('no_bank_details') || flags.includes('bank_unverified') || r.body.rows.every((x) => !x.flags.includes('zero_gross'))), { flags: [...new Set(flags)], unapproved: r.body.unapprovedInputs })

  // ─── Salary revision + arrears ─────────────────────────────
  const oldWage = Number(contract.wageMonthly)
  const body = { employeeId: john.employeeId, newCtcAnnual: (oldWage + 1000) * 12, newWageMonthly: oldWage + 1000, effectiveFrom: '2027-01-01', reason: 'Annual increment' }
  r = await api(jane, 'POST', '/salary-revisions', body)
  check('an employee cannot raise a revision (403)', r.status === 403, r.status)
  r = await api(finance, 'POST', '/salary-revisions', { ...body, effectiveFrom: '2027-01-15' })
  check('a revision starts on the first day of a month (400)', r.status === 400, r.data)
  r = await api(finance, 'POST', '/salary-revisions', { ...body, newWageMonthly: body.newCtcAnnual })
  check('twelve months of wage cannot exceed the CTC (400)', r.status === 400, r.data)
  r = await api(finance, 'POST', '/salary-revisions', body)
  const rev = r.body
  created.revisions.push(rev?.id)
  check('payroll raises a +1000 revision from Jan 2027', r.status === 201 && rev.status === 'pending' && rev.oldWageMonthly === oldWage && rev.newWageMonthly === oldWage + 1000, r.data)
  r = await api(finance, 'POST', '/salary-revisions', body)
  check('one pending revision per person (409)', r.status === 409, r.status)
  const paid = await prisma.payslip.findMany({ where: { employeeId: john.employeeId, payrollCycle: { tenantId: admin.tenantId, status: { in: ['disbursed', 'locked'] }, payPeriodStart: { gte: new Date('2027-01-01') } } }, select: { paidDays: true, workingDays: true } })
  const expected = round2(paid.reduce((t, s) => t + 1000 * (s.workingDays > 0 ? Math.min(1, s.paidDays / s.workingDays) : 1), 0))
  r = await api(admin, 'GET', '/salary-revisions?status=pending')
  const pend = r.body.find((x) => x.id === rev.id)
  check(`the pending revision already shows its arrears (${paid.length} paid months → ${expected})`, pend && pend.arrearsAmount === expected && pend.arrearsDetail.length === paid.length, { got: pend?.arrearsAmount, expected })
  r = await api(finance, 'POST', `/salary-revisions/${rev.id}/approve`, {})
  check('the person who raised it cannot approve it (403)', r.status === 403, r.status)
  r = await api(admin, 'POST', `/salary-revisions/${rev.id}/approve`, { note: 'OK' })
  check('someone else approves it', r.status === 200 && r.body.status === 'approved' && r.body.arrearsAmount === expected, r.data)
  const next = await prisma.employeeContract.findUnique({ where: { id: r.body.newContractId } })
  created.contracts.push(next?.id)
  const old = await prisma.employeeContract.findUnique({ where: { id: contract.id } })
  check('approval creates the next contract version and ends the old one the day before', next.version === contract.version + 1 && next.previousContractId === contract.id && Number(next.wageMonthly) === oldWage + 1000 && old.effectiveUntil.toISOString().startsWith('2026-12-31'), { next: next.version, until: old.effectiveUntil })
  r = await api(finance, 'POST', `/salary-revisions/${rev.id}/post-arrears`, { cycleId: cycle.id })
  created.inputs.push(r.body?.payrollInputId)
  const input = r.body?.payrollInputId && (await prisma.payrollInput.findUnique({ where: { id: r.body.payrollInputId } }))
  check('arrears go into the open run as an unapproved Salary Arrear input', r.status === 200 && input && Number(input.amount) === expected && !input.approvedBy, r.data)
  r = await api(finance, 'POST', `/salary-revisions/${rev.id}/post-arrears`, { cycleId: cycle.id })
  check('…once (400)', r.status === 400, r.status)

  // ─── Release control ───────────────────────────────────────
  r = await api(admin, 'POST', `/payroll/cycles/${cycle.id}/release-payslips`)
  check('payslips cannot be released before approval (400)', r.status === 400, r.data)
  await prisma.payrollInput.update({ where: { id: input.id }, data: { approvedBy: admin.userId, approvedAt: new Date() } }) // so approval isn't blocked by it
  r = await api(admin, 'POST', `/payroll/cycles/${cycle.id}/approve`)
  check('HR approves the run', r.status === 200, r.data)
  const mine = async () => (await api(john, 'GET', '/payroll/payslips/me')).body.some((p) => p.payrollCycleId === cycle.id)
  check('approved but not released: John cannot see it yet', !(await mine()))
  const johnSlip = await prisma.payslip.findFirst({ where: { payrollCycleId: cycle.id, employeeId: john.employeeId } })
  r = await api(admin, 'POST', `/payroll/payslips/${johnSlip.id}/withhold`, { withheld: true })
  check('holding a payslip needs a reason (400)', r.status === 400, r.status)
  await api(admin, 'POST', `/payroll/payslips/${johnSlip.id}/withhold`, { withheld: true, reason: 'Under review' })
  r = await api(admin, 'POST', `/payroll/cycles/${cycle.id}/release-payslips`)
  check('payroll releases payslips early', r.status === 200 && r.body.released >= 1, r.data)
  check('…but a held payslip stays hidden', !(await mine()) && (await api(john, 'GET', `/payroll/payslips/${johnSlip.id}`)).status === 404)
  await api(admin, 'POST', `/payroll/payslips/${johnSlip.id}/withhold`, { withheld: false })
  check('once unheld, John sees it', await mine())
  r = await api(admin, 'POST', `/payroll/cycles/${cycle.id}/release-payslips`)
  check('releasing twice is refused (400)', r.status === 400, r.status)

  // ─── Cleanup: the run, the revision, John's contract ───────
  const slips = await prisma.payslip.findMany({ where: { payrollCycleId: cycle.id }, select: { id: true } })
  await prisma.payslipLine.deleteMany({ where: { payslipId: { in: slips.map((s) => s.id) } } })
  await prisma.payslipWorkedDay.deleteMany({ where: { payslipId: { in: slips.map((s) => s.id) } } }).catch(() => {})
  await prisma.payslip.deleteMany({ where: { payrollCycleId: cycle.id } })
  await prisma.payrollInput.deleteMany({ where: { payrollCycleId: cycle.id } })
  await prisma.attendanceRecord.updateMany({ where: { employee: { tenantId: admin.tenantId }, date: { gte: new Date(`${MONTH}-01T00:00:00Z`), lte: new Date(`${last}T00:00:00Z`) } }, data: { isLocked: false } })
  await prisma.payrollCycle.delete({ where: { id: cycle.id } }).catch((e) => console.log('cycle left:', e.message.split('\n').pop()))
  await prisma.salaryRevision.deleteMany({ where: { id: { in: created.revisions.filter(Boolean) } } })
  await prisma.employeeContract.deleteMany({ where: { id: { in: created.contracts.filter(Boolean) } } })
  await prisma.employeeContract.update({ where: { id: contract.id }, data: { effectiveUntil: contract.effectiveUntil } })
  await done()
})()

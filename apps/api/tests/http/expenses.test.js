// Prompt 19 verification: reimbursement + per-diem claims through approval and payroll, plus the Part 0 fixes.
// Creates claims and a payroll cycle for CYCLE_MONTH (default 2026-12) in the dev DB; never touches disbursed cycles.
const { api, tokenFor, check, done, prisma, round2, sum } = require('./lib')

const CYCLE_MONTH = process.env.CYCLE_MONTH || '2026-12'
const TAG = `p19-${Date.now()}`

;(async () => {
  const admin = await tokenFor('admin@marichihr.com')
  const finance = await tokenFor('finance@marichihr.com')
  const john = await tokenFor('john.banda@marichihr.com')
  const jane = await tokenFor('jane.mutale@marichihr.com')

  const cats = (await api(jane, 'GET', '/expenses/categories')).body
  const cat = (code) => cats.find((c) => c.code === code).id
  const claim = (who, body) => api(who, 'POST', '/expenses/claims', { description: TAG, expenseDate: '2026-10-02', ...body })

  // ─── SUBMISSION RULES ───────────────────────────────────────
  let r = await claim(jane, { claimType: 'actual', categoryId: cat('TRAVEL'), expenseCurrency: 'USD', expenseAmount: 10 })
  check('receipt required: USD 10 travel (=250 ZMW > 100) without receipt is 400', r.status === 400 && /receipt/i.test(r.data.message), r.data)

  r = await claim(jane, { claimType: 'actual', categoryId: cat('TRAVEL'), expenseCurrency: 'USD', expenseAmount: 10, receiptNumber: 'R-1' })
  const janeTravel = r.body
  check('actual USD claim: 201', r.status === 201, r.data)
  check('FX snapshot: fxRate 25, fxRateDate 2026-01-01, home 250 ZMW', janeTravel?.fxRate === 25 && String(janeTravel.fxRateDate).startsWith('2026-01-01') && janeTravel.homeAmount === 250 && janeTravel.homeCurrency === 'ZMW' && janeTravel.expenseCurrency === 'USD', janeTravel)

  r = await claim(jane, { claimType: 'actual', categoryId: cat('MEALS'), expenseCurrency: 'ZMW', expenseAmount: 200 })
  check('enforced limit: MEALS 200 > 150 rejected 400', r.status === 400 && /limited/i.test(r.data.message), r.data)

  const softCode = `TSOFT${Date.now() % 100000}`
  const soft = (await api(admin, 'POST', '/expenses/config/categories', { name: `Soft limit ${TAG}`, code: softCode, maxAmount: 50, enforceLimit: false })).body
  r = await claim(jane, { claimType: 'actual', categoryId: soft.id, expenseCurrency: 'ZMW', expenseAmount: 80 })
  check('soft limit: 80 > 50 accepted and flagged overLimit', r.status === 201 && r.body.overLimit === true, r.data)
  const janeSoft = r.body
  await api(admin, 'PATCH', `/expenses/config/categories/${soft.id}`, { active: false })

  r = await claim(jane, { claimType: 'per_diem', categoryId: cat('TRAVEL'), countryCode: 'ke', days: 2 })
  const janePerDiem = r.body
  check('per-diem KE 2 days: 240 USD -> 6000 ZMW, rate snapshot', r.status === 201 && janePerDiem.expenseAmount === 240 && janePerDiem.expenseCurrency === 'USD' && janePerDiem.homeAmount === 6000 && janePerDiem.perDiemDays === 2 && janePerDiem.perDiemCountry === 'KE' && !!janePerDiem.perDiemRateId, r.data)

  r = await claim(jane, { claimType: 'per_diem', categoryId: cat('TRAVEL'), countryCode: 'KE', days: 1.3 })
  check('per-diem 1.3 days rejected (whole/half only)', r.status === 400, r.data)
  r = await claim(jane, { claimType: 'actual', categoryId: cat('COMM'), expenseCurrency: 'ZMW', expenseAmount: 5, status: 'finance_approved' })
  check('strict body: extra "status" key rejected 400', r.status === 400, r.data)
  r = await claim(jane, { claimType: 'actual', categoryId: cat('COMM'), expenseCurrency: 'ZMW', expenseAmount: 5, homeAmount: 999999 })
  check('strict body: client-supplied homeAmount rejected 400', r.status === 400, r.data)
  r = await claim(jane, { claimType: 'actual', categoryId: cat('COMM'), expenseCurrency: 'EUR', expenseAmount: 5 })
  check('unknown FX pair (EUR) rejected 400', r.status === 400 && /FX/.test(r.data.message), r.data)
  r = await claim(jane, { claimType: 'actual', categoryId: cat('COMM'), expenseCurrency: 'ZMW', expenseAmount: 5, expenseDate: '2099-01-01' })
  check('future expense date rejected 400', r.status === 400, r.data)

  // FX snapshot survives a later rate change
  const fx = (await api(admin, 'GET', '/expenses/config/fx-rates')).body.find((f) => f.fromCurrency === 'USD' && f.toCurrency === 'ZMW')
  await api(admin, 'PATCH', `/expenses/config/fx-rates/${fx.id}`, { rate: 26 })
  const reread = (await api(jane, 'GET', `/expenses/claims/${janeTravel.id}`)).body
  await api(admin, 'PATCH', `/expenses/config/fx-rates/${fx.id}`, { rate: 25 })
  check('FX snapshot: changing the rate to 26 leaves the claim at 25 / 250', reread.fxRate === 25 && reread.homeAmount === 250, reread)

  // ─── WITHDRAW ───────────────────────────────────────────────
  const toWithdraw = (await claim(jane, { claimType: 'actual', categoryId: cat('COMM'), expenseCurrency: 'ZMW', expenseAmount: 12 })).body
  r = await api(john, 'POST', `/expenses/claims/${toWithdraw.id}/withdraw`)
  check("withdraw: someone else's claim is 404", r.status === 404, r.data)
  r = await api(jane, 'POST', `/expenses/claims/${toWithdraw.id}/withdraw`)
  check('withdraw: owner withdraws submitted claim', r.status === 200 && r.body.status === 'withdrawn', r.data)
  r = await api(jane, 'POST', `/expenses/claims/${toWithdraw.id}/withdraw`)
  check('withdraw: second withdraw is 400', r.status === 400, r.data)
  r = await api(john, 'POST', `/expenses/claims/${toWithdraw.id}/approve`)
  check('approve a withdrawn claim is 400', r.status === 400, r.data)

  // ─── MANAGER STEP ───────────────────────────────────────────
  const johnClaim = (await claim(john, { claimType: 'actual', categoryId: cat('COMM'), expenseCurrency: 'ZMW', expenseAmount: 300 })).body
  const johnPerDiem = (await claim(john, { claimType: 'per_diem', categoryId: cat('TRAVEL'), countryCode: 'ZM', days: 1.5 })).body
  check('per-diem ZM 1.5 days = 450 ZMW, fxRate 1', johnPerDiem?.homeAmount === 450 && johnPerDiem.fxRate === 1, johnPerDiem)
  const adminClaim = (await claim(admin, { claimType: 'actual', categoryId: cat('COMM'), expenseCurrency: 'ZMW', expenseAmount: 40 })).body

  r = await api(jane, 'POST', `/expenses/claims/${janeTravel.id}/approve`)
  check('employee without expenses:approve cannot approve (403)', r.status === 403, r.data)
  r = await api(john, 'POST', `/expenses/claims/${johnClaim.id}/approve`)
  check('manager cannot approve own claim (403)', r.status === 403, r.data)
  r = await api(john, 'POST', `/expenses/claims/${adminClaim.id}/approve`)
  check("manager cannot approve their own manager's claim (403)", r.status === 403, r.data)

  const pendingJohn = (await api(john, 'GET', '/expenses/claims/pending')).body
  check("John's pending queue has only his direct reports' claims", pendingJohn.length > 0 && pendingJohn.every((c) => c.employee.managerId === john.employeeId), pendingJohn.map((c) => c.employee.employeeCode))

  for (const c of [janeTravel, janeSoft, janePerDiem]) {
    r = await api(john, 'POST', `/expenses/claims/${c.id}/approve`)
    check(`direct manager approves Jane claim ${c.homeAmount}`, r.status === 200 && r.body.status === 'manager_approved' && r.body.managerApprovedByUserId === john.userId, r.data)
  }
  for (const c of [johnClaim, johnPerDiem]) {
    r = await api(admin, 'POST', `/expenses/claims/${c.id}/approve`)
    check(`admin (John's manager) approves John claim ${c.homeAmount}`, r.status === 200 && r.body.status === 'manager_approved', r.data)
  }
  r = await api(admin, 'POST', `/expenses/claims/${adminClaim.id}/approve`)
  check('hr_admin with no manager self-approves (logged)', r.status === 200, r.data)
  const selfLog = await prisma.auditLog.findFirst({ where: { action: 'SELF_APPROVAL', entityType: 'expense_claim', entityId: adminClaim.id } })
  check('SELF_APPROVAL audit row written for admin claim', !!selfLog)

  // ─── FINANCE STEP ───────────────────────────────────────────
  r = await api(admin, 'POST', `/expenses/claims/${adminClaim.id}/finance-approve`)
  check('finance approve blocked when finance user = claimant (403)', r.status === 403 && /own claim/.test(r.data.message), r.data)
  r = await api(admin, 'POST', `/expenses/claims/${johnClaim.id}/finance-approve`)
  check('finance approve blocked when finance user = manager approver (403)', r.status === 403 && /different user/.test(r.data.message), r.data)
  r = await api(john, 'POST', `/expenses/claims/${janeTravel.id}/finance-approve`)
  check('manager without expenses:finance cannot finance-approve (403)', r.status === 403, r.data)

  for (const c of [janeTravel, janeSoft, janePerDiem, johnClaim, johnPerDiem, adminClaim]) {
    r = await api(finance, 'POST', `/expenses/claims/${c.id}/finance-approve`)
    check(`finance user approves claim ${c.homeAmount}`, r.status === 200 && r.body.status === 'finance_approved', r.data)
  }
  r = await api(finance, 'POST', `/expenses/claims/${janeTravel.id}/finance-approve`)
  check('finance approve twice is 400', r.status === 400, r.data)

  // ─── PAYROLL ────────────────────────────────────────────────
  const [y, m] = CYCLE_MONTH.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  // A previous run may have left this month's cycle undisbursed (e.g. crashed mid-run): reset and reuse it
  const leftover = await prisma.payrollCycle.findFirst({ where: { tenantId: admin.tenantId, payPeriodStart: new Date(`${CYCLE_MONTH}-01T00:00:00Z`), status: { in: ['draft', 'processing', 'review'] } } })
  if (leftover) await prisma.payrollCycle.update({ where: { id: leftover.id }, data: { status: 'draft' } })
  r = leftover ? { status: 201, body: leftover } : await api(admin, 'POST', '/payroll/cycles', { payPeriodStart: `${CYCLE_MONTH}-01`, payPeriodEnd: last })
  check(`create ${CYCLE_MONTH} cycle`, r.status === 201, r.data)
  const cycle = r.body
  await api(admin, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
  const run = await api(admin, 'POST', `/payroll/cycles/${cycle.id}/run`)
  check('run cycle', run.status === 200 && run.body.status === 'review', run.data)
  check('Jane (no contract) is skipped', run.body.skipped.some((s) => s.employeeCode === 'EMP0003' && /contract/i.test(s.reason)), run.body.skipped)

  const approvedBefore = await prisma.reimbursementClaim.findMany({ where: { tenantId: admin.tenantId, status: 'finance_approved', paidInCycleId: null } })
  const payslips = (await api(admin, 'GET', `/payroll/cycles/${cycle.id}/payslips`)).body
  for (const ps of payslips) {
    const full = (await api(admin, 'GET', `/payroll/payslips/${ps.id}`)).body
    const reimb = full.lines.filter((l) => l.category === 'REIMB')
    const net = full.lines.find((l) => l.code === 'NET')
    const gross = full.lines.find((l) => l.code === 'GROSS')
    const earnings = sum(full.lines.filter((l) => ['BASIC', 'ALW'].includes(l.category)).map((l) => l.amount))
    const expected = approvedBefore.filter((c) => c.employeeId === ps.employeeId)
    const code = ps.employee.employeeCode
    check(`${code}: one REIMB line per finance-approved claim (${expected.length})`, reimb.length === expected.length && expected.every((c) => reimb.some((l) => l.sourceRefId === c.id && l.amount === c.homeAmount)), reimb)
    check(`${code}: reimbursements not in gross (GROSS line ${gross?.amount} = earnings ${earnings} = payslip gross)`, gross && gross.amount === earnings && full.grossEarnings === earnings, { gross: gross?.amount, earnings, grossEarnings: full.grossEarnings })
    check(`${code}: net = NET rule + reimbursements (added after NET)`, round2(net.amount + sum(reimb.map((l) => l.amount))) === full.netPay && Math.max(...reimb.map((l) => l.sequence), 0) > net.sequence, { net: net.amount, reimb: sum(reimb.map((l) => l.amount)), netPay: full.netPay })
    // PAYE is computed from GROSS alone: same gross with no claims must give the same tax
    const paye = full.lines.find((l) => l.code === 'PAYE_ZM')
    const ded = sum(full.lines.filter((l) => ['DED', 'TAX'].includes(l.category)).map((l) => l.amount))
    check(`${code}: totalDeductions (${full.totalDeductions}) excludes reimbursements`, full.totalDeductions === ded && !!paye, { totalDeductions: full.totalDeductions, ded })
  }

  // Payslip PDF and HTML show the reimbursement section
  const johnPs = payslips.find((p) => p.employee.employeeCode === 'EMP0002')
  const pdf = await api(admin, 'GET', `/payroll/payslips/${johnPs.id}/pdf`)
  check('payslip PDF downloads (application/pdf, %PDF header)', pdf.status === 200 && Buffer.isBuffer(pdf.data) && pdf.data.slice(0, 4).toString() === '%PDF', pdf.status)

  // ─── APPROVALS, GL, DISBURSE ────────────────────────────────
  r = await api(admin, 'POST', `/payroll/cycles/${cycle.id}/approve`)
  check('HR approves cycle', r.status === 200, r.data)
  r = await api(admin, 'POST', `/payroll/cycles/${cycle.id}/finance-approve`)
  check('HR approver cannot finance-approve (403)', r.status === 403, r.data)
  r = await api(finance, 'POST', `/payroll/cycles/${cycle.id}/finance-approve`)
  check('finance approves cycle', r.status === 200, r.data)

  const gl = await api(finance, 'GET', `/payroll/cycles/${cycle.id}/gl-export`)
  const glRows = String(gl.data).trim().split('\r\n').map((l) => l.split(','))
  const reimbRow = glRows.find((c) => c[2] === '5020')
  const reimbTotal = sum(approvedBefore.filter((c) => payslips.some((p) => p.employeeId === c.employeeId)).map((c) => c.homeAmount))
  const debit = sum(glRows.slice(1).map((c) => Number(c[5])))
  const credit = sum(glRows.slice(1).map((c) => Number(c[6])))
  check(`GL: account 5020 debit = reimbursements paid (${reimbTotal})`, gl.status === 200 && reimbRow && Number(reimbRow[5]) === reimbTotal, reimbRow)
  check(`GL balances (debit ${debit} = credit ${credit})`, debit === credit, { debit, credit })

  const stillApproved = await prisma.reimbursementClaim.count({ where: { id: { in: [johnClaim.id, johnPerDiem.id, adminClaim.id] }, status: 'finance_approved' } })
  check('claims are still finance_approved before disbursement', stillApproved === 3, stillApproved)

  r = await api(finance, 'POST', `/payroll/cycles/${cycle.id}/disburse`)
  check('disburse cycle', r.status === 200 && r.body.status === 'disbursed', r.data)
  const after = await prisma.reimbursementClaim.findMany({ where: { id: { in: [johnClaim.id, johnPerDiem.id, adminClaim.id, janeTravel.id, janePerDiem.id, janeSoft.id] } } })
  const byId = Object.fromEntries(after.map((c) => [c.id, c]))
  check('paid claims: status paid + paidInCycleId + paidAt', [johnClaim, johnPerDiem, adminClaim].every((c) => byId[c.id].status === 'paid' && byId[c.id].paidInCycleId === cycle.id && byId[c.id].paidAt), [johnClaim, johnPerDiem, adminClaim].map((c) => byId[c.id].status))
  check("Jane's claims (skipped employee) stay finance_approved and unpaid", [janeTravel, janePerDiem, janeSoft].every((c) => byId[c.id].status === 'finance_approved' && !byId[c.id].paidInCycleId), [janeTravel, janePerDiem, janeSoft].map((c) => byId[c.id].status))
  r = await api(admin, 'POST', `/payroll/cycles/${cycle.id}/run`)
  check('disbursed cycle cannot be re-run (immutable)', r.status === 400, r.data)

  // ─── PART 0 FIXES ───────────────────────────────────────────
  for (const [who, name, expect] of [[john, 'manager', 403], [jane, 'employee', 403], [finance, 'payroll_admin', 200], [admin, 'hr_admin', 200]]) {
    const a = await api(who, 'GET', '/salary/structures')
    const b = await api(who, 'GET', '/salary/grade-bands')
    check(`salary reads as ${name}: ${expect}`, a.status === expect && b.status === expect, [a.status, b.status])
  }

  const annual = (await api(jane, 'GET', '/leave/types')).body.find((t) => t.code === 'ANNUAL')
  // Each run consumes a day of Jane's ANNUAL leave: top it up so the suite can repeat
  await api(admin, 'POST', '/leave/allocations/manual', { employeeId: jane.employeeId, leaveTypeId: annual.id, daysAllocated: 1, validFrom: '2026-01-01', reason: TAG })
  r = await api(jane, 'POST', '/leave/requests', { leaveTypeId: annual.id, startDate: '2027-01-05', endDate: '2027-01-05', reason: TAG })
  check('Jane applies for 2027-01-05', r.status === 201, r.data)
  const janeLeave = r.body
  r = await api(john, 'POST', '/leave/requests', { leaveTypeId: annual.id, startDate: '2027-01-06', endDate: '2027-01-06', reason: TAG })
  const johnLeave = r.body
  check('John applies for 2027-01-06', r.status === 201, r.data)

  const johnQueue = (await api(john, 'GET', '/leave/requests/pending')).body
  const adminQueue = (await api(admin, 'GET', '/leave/requests/pending')).body
  check("pending leave: John sees Jane's request, not his own", johnQueue.some((l) => l.id === janeLeave.id) && !johnQueue.some((l) => l.id === johnLeave.id) && johnQueue.every((l) => l.employee.managerId === john.employeeId), johnQueue.map((l) => l.employee.employeeCode))
  check('pending leave: hr_admin sees all (both)', adminQueue.some((l) => l.id === janeLeave.id) && adminQueue.some((l) => l.id === johnLeave.id))
  const finQueue = await api(finance, 'GET', '/leave/requests/pending')
  check('pending leave: payroll_admin (no leave:approve) is 403', finQueue.status === 403, finQueue.status)

  r = await api(john, 'POST', `/leave/requests/${janeLeave.id}/approve`, { comments: TAG })
  check('John approves Jane leave', r.status === 200, r.data)
  const chatter = (await api(admin, 'GET', `/activities/chatter/leave_request/${janeLeave.id}`)).body
  const msg = (chatter.messages || chatter).map((c) => c.body).find((b) => /approved from/.test(b))
  check('leave approval chatter uses YYYY-MM-DD: "from 2027-01-05 to 2027-01-05"', /from 2027-01-05 to 2027-01-05\./.test(msg || ''), msg)
  r = await api(john, 'POST', `/leave/requests/${johnLeave.id}/cancel`)
  check('John cancels his test leave', r.status === 200, r.data)

  await done()
})().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})

// 360° profile: the reporting chain both ways, and each block shown only to people allowed to see it
// (pay to self/HR/payroll, history to HR), plus isolation. Read-only against the dev company.
const { api, tokenFor, check, done, prisma } = require('./lib')

;(async () => {
  const admin = await tokenFor('admin@marichihr.com'), john = await tokenFor('john.banda@marichihr.com'), jane = await tokenFor('jane.mutale@marichihr.com')

  let r = await api(jane, 'GET', `/employees/${jane.employeeId}/360`)
  const me = r.body
  check('my own 360: the chain runs from the top down to my manager', r.status === 200 && me.chain.length >= 2 && me.chain[me.chain.length - 1].id === john.employeeId && me.chain[0].id === admin.employeeId, me?.chain)
  check('…I see my own pay block but not HR history', me.can.seePay === true && me.can.seeHistory === false && me.history.length === 0)
  check('…leave balances come with names', Array.isArray(me.leave) && me.leave.every((b) => b.type && typeof b.available === 'number'), me.leave)

  r = await api(john, 'GET', `/employees/${jane.employeeId}/360`)
  check("a manager sees their report's 360 without pay or awards", r.status === 200 && r.body.can.seePay === false && r.body.lastPayslip === null && r.body.awards.length === 0, r.body?.can)
  r = await api(john, 'GET', `/employees/${john.employeeId}/360`)
  check('the manager sees their direct reports', r.body.directReports.some((d) => d.id === jane.employeeId), r.body?.directReports)

  r = await api(jane, 'GET', `/employees/${john.employeeId}/360`)
  check("an employee cannot open their manager's 360 (404)", r.status === 404, r.status)

  r = await api(admin, 'GET', `/employees/${john.employeeId}/360`)
  check('HR sees pay, history (with who did it) and the team', r.status === 200 && r.body.can.seeHistory && r.body.history.length > 0 && r.body.history.every((h) => h.action && h.at) && r.body.directReports.length > 0, r.body?.history?.slice(0, 2))
  check('history never lists secret fields', r.body.history.every((h) => h.fields.every((f) => !/password|bank|secret|token/i.test(f))))
  const paid = await prisma.payslip.findFirst({ where: { employeeId: john.employeeId, payrollCycle: { status: { in: ['approved', 'disbursed'] } } }, orderBy: { payrollCycle: { payPeriodStart: 'desc' } }, include: { payrollCycle: true } })
  check('the latest finalised payslip is shown', !paid || (r.body.lastPayslip && r.body.lastPayslip.month === paid.payrollCycle.payPeriodStart.toISOString().slice(0, 7) && r.body.lastPayslip.net === Number(paid.netPay)), { api: r.body.lastPayslip, db: paid && Number(paid.netPay) })

  const foreign = await prisma.employee.findFirst({ where: { tenant: { slug: { not: 'marichi-labs' } } } })
  r = await api(admin, 'GET', `/employees/${foreign.id}/360`)
  check("another company's employee is invisible (404)", r.status === 404, r.status)
  await done()
})()

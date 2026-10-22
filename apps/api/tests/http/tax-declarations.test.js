// Tax declarations (declare → submit → Payroll verifies line by line or returns) and the annual tax certificate PDF.
const { api, tokenFor, check, done, prisma } = require('./lib')

;(async () => {
  const admin = await tokenFor('admin@marichihr.com') // HR, no pay
  const finance = await tokenFor('finance@marichihr.com') // Payroll admin
  const john = await tokenFor('john.banda@marichihr.com')
  const year = 2031 // a year nobody else uses
  await prisma.taxDeclaration.deleteMany({ where: { tenantId: john.tenantId, year } })

  let r = await api(john, 'GET', '/tax/declarations/sections')
  check('the sections list says which ones lower tax', r.status === 200 && r.body.find((s) => s.key === '80CCD2').newRegime === true && r.body.find((s) => s.key === '80C').newRegime === false, r.body)
  r = await api(john, 'PUT', `/tax/declarations/mine?year=${year}`, { items: [{ section: 'OTHER', amount: 100 }] })
  check('"Other" needs a description (400)', r.status === 400, r.data)
  r = await api(john, 'PUT', `/tax/declarations/mine?year=${year}`, { items: [{ section: '80C', description: 'PPF', amount: 120000 }, { section: '80CCD2', description: 'Employer NPS', amount: 60000 }] })
  const d = r.body
  check('John saves a draft with two lines', r.status === 200 && d.status === 'draft' && d.declared === 180000 && d.items.length === 2, r.data)
  r = await api(finance, 'GET', `/tax/declarations?year=${year}`)
  check('Payroll does not see drafts', !r.body.some((x) => x.id === d.id), r.body)
  r = await api(john, 'POST', `/tax/declarations/mine/submit?year=${year}`)
  check('John submits', r.status === 200, r.data)
  check('…Payroll admins are notified', !!(await prisma.notification.findFirst({ where: { userId: finance.userId, type: 'payroll.declaration', entityId: d.id } })))
  r = await api(john, 'PUT', `/tax/declarations/mine?year=${year}`, { items: [] })
  check('a submitted declaration cannot be edited (400)', r.status === 400, r.data)

  r = await api(admin, 'GET', `/tax/declarations?year=${year}`)
  check('HR cannot see declarations (403)', r.status === 403, r.status)
  r = await api(finance, 'GET', `/tax/declarations?year=${year}`)
  const row = r.body.find((x) => x.id === d.id)
  check('Payroll sees it with the person', !!row && /John/.test(row.employee), r.body)
  r = await api(finance, 'POST', `/tax/declarations/${d.id}/verify`, { approve: false })
  check('returning needs a note (400)', r.status === 400, r.data)
  r = await api(finance, 'POST', `/tax/declarations/${d.id}/verify`, { approve: true, items: [{ id: row.items[0].id, verifiedAmount: 200000, status: 'accepted' }, { id: row.items[1].id, verifiedAmount: 60000, status: 'accepted' }] })
  check('a line cannot be verified for more than declared (400)', r.status === 400, r.data)
  r = await api(finance, 'POST', `/tax/declarations/${d.id}/verify`, { approve: true, items: [{ id: row.items[0].id, verifiedAmount: 100000, status: 'accepted' }] })
  check('every line must be decided to verify (400)', r.status === 400, r.data)
  r = await api(finance, 'POST', `/tax/declarations/${d.id}/verify`, { approve: true, note: 'PPF proof shows 1,00,000', items: [{ id: row.items[0].id, verifiedAmount: 100000, status: 'accepted' }, { id: row.items[1].id, verifiedAmount: 60000, status: 'accepted' }] })
  check('Payroll verifies, accepting part of one line', r.status === 200 && r.body.status === 'verified' && r.body.verified === 160000, r.data)
  check('…only the new-regime section lowers tax (60,000)', r.body.applied === 60000, r.body?.applied)
  check('…John is notified', !!(await prisma.notification.findFirst({ where: { userId: john.userId, type: 'payroll.declaration', entityId: d.id } })))

  // ─── Certificate ──────────────────────────────────────────
  const slip = await prisma.payslip.findFirst({ where: { employeeId: john.employeeId, payrollCycle: { status: { in: ['approved', 'disbursed'] } } }, include: { payrollCycle: true }, orderBy: { payrollCycle: { payPeriodStart: 'desc' } } })
  if (slip) {
    const y = slip.payrollCycle.payPeriodStart.getUTCFullYear()
    r = await api(john, 'GET', `/tax/certificate?year=${y}`)
    check('John downloads his annual tax certificate (PDF)', r.status === 200 && Buffer.isBuffer(r.data) && r.data.slice(0, 4).toString() === '%PDF', r.status)
    r = await api(admin, 'GET', `/tax/certificate?year=${y}&employeeId=${john.employeeId}`)
    check("HR cannot download someone's certificate (404)", r.status === 404, r.status)
    r = await api(finance, 'GET', `/tax/certificate?year=${y}&employeeId=${john.employeeId}`)
    check('Payroll can', r.status === 200, r.status)
  }
  r = await api(john, 'GET', '/tax/certificate?year=2099')
  check('no certificate for a year without payroll (400)', r.status === 400, r.data)

  await prisma.taxDeclaration.deleteMany({ where: { tenantId: john.tenantId, year } })
  await done()
})()

// ZRA Smart Invoice purchases through DigiTax, against the DigiTax TEST business only (DIGITAX_API_KEY must be a
// ZMB_TEST_ key, DIGITAX_TENANT=marichi-labs, and the test business needs the item "MarichiHR test - desk supplies" accepted by ZRA).
// Sends ONE purchase per run to the test business. Restores the category mapping and removes the claim it adds.
const { api, tokenFor, withRoles, check, done, prisma } = require('./lib')

;(async () => {
  if (!String(process.env.DIGITAX_API_KEY || '').startsWith('ZMB_TEST_')) { console.log('skipped: needs a DigiTax TEST key'); process.exit(0) }
  const fin = withRoles(await tokenFor('finance@marichihr.com'), 'payroll_admin')
  const hrAdmin = await tokenFor('admin@marichihr.com')
  const emp = await prisma.employee.findFirst({ where: { tenantId: fin.tenantId, employeeCode: 'EMP0003' } })
  const cat = await prisma.expenseCategory.findFirst({ where: { tenantId: fin.tenantId, active: true }, orderBy: { name: 'asc' } })
  const before = cat.digitaxItemId
  let claim
  try {
    let r = await api(fin, 'GET', '/expenses/smart-invoice')
    check('the company the key belongs to is connected (test business)', r.status === 200 && r.body.connected && r.body.test === true, r.body)
    r = await api(fin, 'GET', '/expenses/smart-invoice/items')
    const item = (r.body || []).find((i) => i.name === 'MarichiHR test - desk supplies' && i.status === 'COMPLETED')
    const notSynced = (r.body || []).find((i) => i.status !== 'COMPLETED')
    check('DigiTax items are listed for mapping', r.status === 200 && !!item, r.data)
    r = await api(fin, 'PUT', `/expenses/smart-invoice/categories/${cat.id}`, { itemId: 'item_does_not_exist' })
    check('an item that is not in DigiTax is refused', r.status === 400, r.data)
    if (notSynced) {
      r = await api(fin, 'PUT', `/expenses/smart-invoice/categories/${cat.id}`, { itemId: notSynced.id })
      check('an item ZRA has not accepted cannot be mapped', r.status === 400 && /with ZRA/.test(r.data.message), r.data)
    }
    r = await api(fin, 'PUT', `/expenses/smart-invoice/categories/${cat.id}`, { itemId: item.id })
    check('a category maps to a DigiTax item', r.status === 200, r.data)

    claim = await prisma.reimbursementClaim.create({ data: { tenantId: fin.tenantId, employeeId: emp.id, categoryId: cat.id, claimType: 'actual', expenseDate: new Date('2026-10-20T00:00:00Z'), description: 'Smart Invoice test', expenseCurrency: 'ZMW', expenseAmount: 116, fxRate: 1, homeCurrency: 'ZMW', homeAmount: 116, status: 'manager_approved' } })
    r = await api(fin, 'POST', `/expenses/claims/${claim.id}/smart-invoice`, {})
    check('claims not yet finance-approved are not sent', r.status === 400, r.data)
    await prisma.reimbursementClaim.update({ where: { id: claim.id }, data: { status: 'finance_approved' } })
    r = await api(fin, 'POST', `/expenses/claims/${claim.id}/smart-invoice`, { supplierTin: '12345' })
    check('a TPIN must be 10 digits', r.status === 400, r.data)
    r = await api(fin, 'POST', `/expenses/claims/${claim.id}/smart-invoice`, { supplierName: 'MarichiHR test supplier' })
    check('the claim is recorded with DigiTax (test business) and gets a purchase id', r.status === 200 && /^purchase_/.test(r.body.purchaseId) && ['PENDING', 'COMPLETED', 'FAILED'].includes(r.body.status), r.data)
    const status = r.body?.status
    r = await api(fin, 'POST', `/expenses/claims/${claim.id}/smart-invoice`, {})
    check('a recorded claim is not sent twice', status === 'FAILED' ? r.status !== 409 : r.status === 409, r.data)
    r = await api(fin, 'POST', `/expenses/claims/${claim.id}/smart-invoice/refresh`)
    check('its ZRA status can be checked', r.status === 200 && ['PENDING', 'COMPLETED', 'FAILED'].includes(r.body.status), r.data)
    console.log('      ZRA status:', r.body?.status)
    r = await api(fin, 'GET', '/expenses/smart-invoice/claims')
    check('the finance list shows the status', r.body.claims.some((c) => c.id === claim.id && c.digitax?.purchaseId), null)
    r = await api(fin, 'GET', '/tax/filing-dashboard')
    check('the filing dashboard shows ZRA notices and purchase counts', r.status === 200 && r.body.smartInvoice?.connected && Array.isArray(r.body.smartInvoice.notices) && Object.values(r.body.smartInvoice.purchases).reduce((a, b) => a + b, 0) >= 1, r.body?.smartInvoice)
    r = await api(hrAdmin, 'GET', '/expenses/smart-invoice')
    check('HR admins with expense finance rights see it too', r.status === 200, r.status)

    const other = await prisma.tenant.findFirst({ where: { slug: { not: 'marichi-labs' }, active: true, users: { some: { userRoles: { some: { role: { name: 'payroll_admin' } } } } } } })
    if (other) {
      const u = await prisma.user.findFirst({ where: { tenantId: other.id, userRoles: { some: { role: { name: 'payroll_admin' } } } }, include: { userRoles: { include: { role: true } } } })
      const tok = require('jsonwebtoken').sign({ userId: u.id, tenantId: other.id, employeeId: '', roleIds: u.userRoles.map((x) => x.role.name), email: u.email }, process.env.JWT_ACCESS_SECRET, { expiresIn: '5m' })
      r = await api(tok, 'GET', '/expenses/smart-invoice')
      const d = await api(tok, 'GET', '/tax/filing-dashboard')
      check('other companies are not connected and see nothing of DigiTax', r.body?.connected === false && d.body && !d.body.digitax && !d.body.smartInvoice, [r.body, Object.keys(d.body || {})])
    }
  } finally {
    await prisma.expenseCategory.update({ where: { id: cat.id }, data: { digitaxItemId: before } })
    if (claim) await prisma.reimbursementClaim.delete({ where: { id: claim.id } })
  }
  await done()
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })

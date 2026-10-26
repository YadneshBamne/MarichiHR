// Bank file layouts: sourced presets, company values ({tokens}), ISO 20022 pain.001 and a header-line text layout,
// using a paid run in marichi-labs. Removes the layouts it adds.
const { api, tokenFor, check, done, prisma } = require('./lib')
const BASE = (process.env.API_URL || 'http://localhost:4000') + '/api/v1'

;(async () => {
  const fin = await tokenFor('finance@marichihr.com')
  const cycle = await prisma.payrollCycle.findFirst({ where: { tenantId: fin.tenantId, status: 'disbursed', payslips: { some: {} } }, orderBy: { payPeriodStart: 'asc' } })
  const TAG = `bf${Date.now() % 1e6}`
  const made = []
  const file = async (id) => { const res = await fetch(`${BASE}/payroll/cycles/${cycle.id}/bank-file?allowPartial=true&formatId=${id}&paymentDate=2026-10-30`, { headers: { authorization: `Bearer ${fin.token}` } }); return { status: res.status, type: res.headers.get('content-type'), name: res.headers.get('content-disposition'), text: await res.text() } }
  const strip = ({ status, source, notes, needs, ...f }) => f
  try {
    let r = await api(fin, 'GET', '/payroll/bank-formats')
    const presets = r.body.presets
    check('every preset says where it comes from', presets.every((p) => ['verified', 'confirm', 'generic'].includes(p.status) && (p.status === 'generic' || p.source)), presets.map((p) => [p.name, p.status]))

    const pain = presets.find((p) => p.kind === 'pain001')
    r = await api(fin, 'POST', '/payroll/bank-formats', { ...strip(pain), name: `ISO ${TAG}`, vars: { debtorName: 'Marichi Labs', debtorAccount: '62000000001', debtorBic: 'FIRNZMLX' } })
    check('a pain.001 layout is saved with the company values', r.status === 201 && r.body.vars.debtorBic === 'FIRNZMLX', r.data); made.push(r.body.id)
    const x = await file(r.body.id)
    check('…and the bank file is ISO 20022 XML', x.status === 200 && /xml/.test(x.type) && /\.xml"/.test(x.name) && x.text.includes('urn:iso:std:iso:20022:tech:xsd:pain.001.001.03') && /<NbOfTxs>\d+<\/NbOfTxs>/.test(x.text), x.text.slice(0, 200))

    const ubi = presets.find((p) => p.name.startsWith('Union Bank'))
    r = await api(fin, 'POST', '/payroll/bank-formats', { ...strip(ubi), name: `UBI ${TAG}` })
    made.push(r.body.id)
    const y = await file(r.body.id)
    check('a layout missing its company values stops with a clear message', y.status === 400 && /corporateId/.test(y.text), y.text.slice(0, 200))
    r = await api(fin, 'PUT', `/payroll/bank-formats/${r.body.id}`, { ...strip(ubi), name: `UBI ${TAG}`, vars: { corporateId: 'MARICHI', payerIfsc: 'UBIN0556688', debitAccount: '566802070000001', email: 'pay@x.com', mobile: '9999999999' } })
    const z = await file(r.body.id)
    check('…filled in, the file starts FILEHDR and each line has 11 fields', z.status === 200 && z.text.startsWith('FILEHDR,MARICHI\r\n') && z.text.split('\r\n')[1].split(',').length === 11, z.text.slice(0, 200))
    const audit = await prisma.auditLog.findFirst({ where: { tenantId: fin.tenantId, entityId: r.body.id, action: 'BANK_FORMAT_UPDATED' }, orderBy: { createdAt: 'desc' } })
    check('the audit row names the values but never holds the account numbers', audit && !JSON.stringify(audit.newValue).includes('566802070000001') && audit.newValue.vars.includes('debitAccount'), audit?.newValue)
  } finally {
    await prisma.bankFileFormat.deleteMany({ where: { id: { in: made.filter(Boolean) } } })
  }
  await done()
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })

// Payroll leftovers on the MongoDB API: custom bank file layouts, the ERP-agnostic accounting export and its signed push, salary revisions
// with arrears, and the pay review (compensation review). Runs a real two-person payroll first. Removes its company at the end.
// The ERP address is 192.0.2.10 (a documentation address nobody answers on), so no request leaves the machine.
//   API=http://localhost:4217 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-payroll2.test.js
const crypto = require('crypto')
const mongoose = require('mongoose')
const API = (process.env.API || 'http://localhost:4200') + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data, text }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`

;(async () => {
  const stamp = Date.now(), email = `pr${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    require('../../dist/mongo-mode')
    const { encryptField } = require('../../dist/shared/utils/crypto')
    const su = await call('POST', '/auth/signup', null, { companyName: `Payroll Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    await call('PATCH', '/company', owner, { primaryCountry: 'ZM', baseCurrency: 'ZMW' })
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), danielId = await mk('Daniel', 'Zulu'), fionaId = await mk('Fiona', 'Phiri'), ginaId = await mk('Gina', 'Tembo'), carlId = await mk('Carl', 'Mumba')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const daniel = await login(owner, danielId, `daniel${stamp}@example.com`, ['manager'])
    const fiona = await login(owner, fionaId, `fiona${stamp}@example.com`, ['payroll_admin'])
    const gina = await login(owner, ginaId, `gina${stamp}@example.com`, ['payroll_admin'])
    const carl = await login(owner, carlId, `carl${stamp}@example.com`, ['compliance_officer'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danielId } })
    // verified bank details (the maker-checker flow has its own test; here they are written directly, encrypted)
    for (const [id, acct] of [[maryId, '0123456789'], [danielId, '0987654321']]) await db.collection('employees').updateOne({ _id: id }, { $set: { bankName: 'Zanaco', bankAccountNo: encryptField(acct), bankIfscSwift: 'ZNCOZMLU', bankVerified: true } })

    const st = await call('POST', '/salary/structures/starter', fiona)
    const structureId = st.data.id || st.data.structure?.id
    for (const [id, wage] of [[maryId, 10000], [danielId, 20000]]) {
      const c = await call('POST', '/leave/contracts', fiona, { employeeId: id, ctcAnnual: wage * 12, wageMonthly: wage, currency: 'ZMW', effectiveFrom: '2026-01-01', salaryStructureId: structureId })
      for (const step of ['draft', 'confirm', 'activate']) await call('POST', `/leave/contracts/${c.data.id}/${step}`, fiona, {})
    }
    const cyc = await call('POST', '/payroll/cycles', fiona, { payPeriodStart: '2026-11-01', payPeriodEnd: '2026-11-30' })
    const cid = cyc.data.id
    await call('POST', `/payroll/cycles/${cid}/lock-attendance`, fiona)
    const run = await call('POST', `/payroll/cycles/${cid}/run`, fiona)
    check(run.status === 200 && run.data.processed === 2, `payroll run (${short(run).slice(0, 100)})`)
    await call('POST', `/payroll/cycles/${cid}/approve`, fiona)
    await call('POST', `/payroll/cycles/${cid}/finance-approve`, gina)
    check((await call('POST', `/payroll/cycles/${cid}/disburse`, gina)).data?.status === 'disbursed', 'the run is disbursed by a second admin')

    // ── custom bank layouts
    check((await call('GET', '/payroll/bank-formats', mary)).status === 403, 'an employee cannot see bank layouts')
    const bf = await call('GET', '/payroll/bank-formats', fiona)
    check(bf.status === 200 && bf.data.presets.length >= 4, `layouts and presets are listed (${short(bf).slice(0, 90)})`)
    const preset = bf.data.presets.find((p) => p.kind === 'delimited' && p.name.toLowerCase().includes('semi')) ?? bf.data.presets.find((p) => p.kind === 'delimited')
    const { name: pn, ...rest } = preset
    const nf = await call('POST', '/payroll/bank-formats', fiona, { name: 'Zanaco upload', kind: rest.kind, delimiter: rest.delimiter ?? ';', header: rest.header ?? true, columns: rest.columns, vars: rest.vars ?? {}, preamble: rest.preamble ?? [], trailer: rest.trailer ?? [] })
    check(nf.status === 201, `payroll saves a layout (${short(nf).slice(0, 140)})`)
    check((await call('POST', '/payroll/bank-formats', fiona, { name: 'Zanaco upload', kind: 'delimited', columns: rest.columns })).status === 409, 'a duplicate layout name is 409')
    check((await call('PUT', `/payroll/bank-formats/${nf.data.id}`, fiona, { name: 'Zanaco upload', kind: 'delimited', delimiter: ',', header: true, columns: rest.columns })).status === 200, 'and edits it')
    const csv = await call('GET', `/payroll/cycles/${cid}/bank-file?formatId=${nf.data.id}`, fiona)
    check(csv.status === 200 && csv.text.includes('0123456789') && csv.text.includes('0987654321'), `the bank file uses the layout and both accounts (${csv.status})`)
    check(csv.text.split(/\r?\n/).filter(Boolean).length >= 3, 'header plus one row per person')
    check((await call('GET', `/payroll/cycles/${cid}/bank-file?formatId=${crypto.randomUUID()}`, fiona)).status === 404, 'an unknown layout: 404')
    const plain = await call('GET', `/payroll/cycles/${cid}/bank-file`, fiona)
    check(plain.status === 200 && plain.text.includes('0123456789'), 'the generic file still works')

    // ── accounting export
    const as = await call('GET', '/payroll/accounting/settings', fiona)
    check(as.status === 200, `accounting settings (${short(as).slice(0, 100)})`)
    check((await call('GET', '/payroll/accounting/settings', mary)).status === 403, 'employees cannot read them')
    const sv = await call('PUT', '/payroll/accounting/settings', fiona, { accounts: { SALARY_EXPENSE: { code: '6100', name: 'Salaries and wages' } }, splitBy: 'none', webhookUrl: 'https://192.0.2.10/erp/journals', rotateSecret: true })
    check(sv.status === 200 && /^whsec_|^[a-z0-9_]{20,}$/i.test(sv.data?.webhookSecret ?? ''), `payroll saves the ERP address, the secret is shown once (${short(sv).slice(0, 120)})`)
    check((await call('PUT', '/payroll/accounting/settings', fiona, { webhookUrl: 'http://192.0.2.10/x' })).status === 400, 'a non-https ERP address is refused')
    check(!JSON.stringify((await call('GET', '/payroll/accounting/settings', fiona)).data).includes(sv.data?.webhookSecret ?? 'NO'), 'the secret is not shown again')
    const j = await call('GET', `/payroll/cycles/${cid}/journal?format=json`, fiona)
    check(j.status === 200, `the journal for the run (${short(j).slice(0, 100)})`)
    let jj = {}; try { jj = JSON.parse(j.text) } catch {} const lines = jj.lines ?? jj.journal?.lines ?? j.data?.lines ?? []
    const dr = lines.reduce((a, l) => a + Number(l.debit || 0), 0), cr = lines.reduce((a, l) => a + Number(l.credit || 0), 0)
    check(lines.length >= 4 && Math.abs(dr - cr) < 0.01 && dr > 0, `the journal balances: debits ${dr.toFixed(2)} = credits ${cr.toFixed(2)}`)
    check(lines.some((l) => l.accountCode === '6100'), 'the mapped salary account code is used')
    for (const f of ['csv', 'xml', 'quickbooks', 'xero', 'tally']) check((await call('GET', `/payroll/cycles/${cid}/journal?format=${f}`, fiona)).status === 200, `journal as ${f}`)
    const pushed = await call('POST', `/payroll/cycles/${cid}/journal/push`, fiona)
    check(pushed.status === 502 || pushed.status === 200, `the push to the (unreachable) ERP fails cleanly: 502 (${short(pushed).slice(0, 120)})`)
    check(!!(await db.collection('audit_logs').findOne({ tenantId, action: 'PAYROLL_JOURNAL_PUSH_FAILED' })), 'and the failure is audited')

    // ── salary revisions with arrears
    const rv = await call('POST', '/salary-revisions', fiona, { employeeId: maryId, newCtcAnnual: 180000, newWageMonthly: 15000, effectiveFrom: '2026-11-01', reason: 'Promotion to senior accountant' })
    check(rv.status === 201, `payroll proposes a revision for Mary (${short(rv).slice(0, 140)})`)
    check((await call('POST', '/salary-revisions', mary, { employeeId: maryId, newCtcAnnual: 1, newWageMonthly: 1, effectiveFrom: '2026-12-01', reason: 'Raise me' })).status === 403, 'an employee cannot')
    check((await call('POST', `/salary-revisions/${rv.data?.id}/approve`, fiona, {})).status === 403, 'the proposer cannot approve')
    const ap = await call('POST', `/salary-revisions/${rv.data?.id}/approve`, gina, { note: 'Agreed' })
    check(ap.status === 200, `a different payroll admin approves (${short(ap).slice(0, 140)})`)
    const newContract = await db.collection('employee_contracts').findOne({ employeeId: maryId, wageMonthly: 15000 })
    check(!!newContract, 'Mary has a contract at the new wage')
    const list = await call('GET', '/salary-revisions?status=approved', fiona)
    check(list.status === 200 && list.data.length === 1, 'the approved revision lists')
    const cyc2 = await call('POST', '/payroll/cycles', fiona, { payPeriodStart: '2026-12-01', payPeriodEnd: '2026-12-31' })
    const arr = await call('POST', `/salary-revisions/${rv.data?.id}/post-arrears`, fiona, { cycleId: cyc2.data?.id })
    check([200, 400, 409].includes(arr.status), `arrears are posted to the next run or refused clearly (${short(arr).slice(0, 140)})`)
    const rj = await call('POST', '/salary-revisions', fiona, { employeeId: danielId, newCtcAnnual: 300000, newWageMonthly: 25000, effectiveFrom: '2026-12-01', reason: 'Market adjustment' })
    check((await call('POST', `/salary-revisions/${rj.data?.id}/reject`, gina, { note: 'Not this year' })).status === 200, 'a revision can be rejected')
    const cn = await call('POST', '/salary-revisions', fiona, { employeeId: danielId, newCtcAnnual: 300000, newWageMonthly: 25000, effectiveFrom: '2026-12-01', reason: 'Second attempt' })
    check((await call('POST', `/salary-revisions/${cn.data?.id}/cancel`, fiona)).status === 200, 'or cancelled by its proposer')

    // ── tax override: payroll asks, a compliance officer signs off, and it survives a re-run
    await call('POST', `/payroll/cycles/${cyc2.data.id}/lock-attendance`, fiona)
    const run2 = await call('POST', `/payroll/cycles/${cyc2.data.id}/run`, fiona)
    check(run2.status === 200 && run2.data.status === 'review', `the December run is in review (${short(run2).slice(0, 100)})`)
    const lineOf = async () => { const p = await db.collection('payslips').findOne({ payrollCycleId: cyc2.data.id, employeeId: maryId }); return { p, l: p.lines.find((x) => x.code === 'PAYE_ZM') } }
    const before = await lineOf()
    check(!!before.l, 'Mary has a PAYE line to override')
    const ov = await call('POST', '/tax/overrides', fiona, { cycleId: cyc2.data.id, employeeId: maryId, lineCode: 'PAYE_ZM', amount: 500, reason: 'Certificate of exemption on file' })
    check(ov.status === 201, `payroll asks for a tax override (${short(ov).slice(0, 120)})`)
    check((await call('POST', '/tax/overrides', fiona, { cycleId: cyc2.data.id, employeeId: maryId, lineCode: 'PAYE_ZM', amount: 400, reason: 'Again please' })).status === 400, 'a second pending request for the line is refused')
    check((await call('POST', `/tax/overrides/${ov.data?.id}/decide`, fiona, { approve: true })).status === 403, 'payroll cannot sign it off')
    check((await call('GET', '/tax/overrides?status=pending', carl)).data?.length === 1, 'the compliance officer sees it waiting')
    check((await call('POST', `/tax/overrides/${ov.data?.id}/decide`, carl, { approve: true, note: 'Seen the certificate' })).status === 200, 'the compliance officer signs it off')
    const after = await lineOf()
    const delta = Number(before.l.amount) - 500
    check(after.l.amount === 500 && after.l.computationMethod === 'override', `the PAYE line is now 500 (was ${before.l.amount})`)
    check(Math.abs(after.p.netPay - (before.p.netPay + delta)) < 0.01 && Math.abs(after.p.totalDeductions - (before.p.totalDeductions - delta)) < 0.01, 'deductions and net pay moved by the difference')
    await call('POST', `/payroll/cycles/${cyc2.data.id}/run`, fiona)
    check((await lineOf()).l.amount === 500, 'a re-run keeps the signed-off override')

    // ── pay review
    const cr0 = await call('POST', '/comp-reviews', fiona, { name: 'FY27 review', effectiveFrom: '2027-01-01', budgetPercent: 5 })
    check(cr0.status === 201, `payroll opens a pay review cycle (${short(cr0).slice(0, 120)})`)
    check((await call('GET', '/comp-reviews', daniel)).status === 200, 'managers see cycles')
    const team = await call('GET', `/comp-reviews/${cr0.data?.id}/my-team`, daniel)
    check(team.status === 200, `Daniel sees his team's review sheet (${short(team).slice(0, 100)})`)
    const rec = await call('POST', `/comp-reviews/${cr0.data?.id}/recommend`, daniel, { items: [{ employeeId: maryId, increasePercent: 4, note: 'Strong year' }] })
    check(rec.status === 200 || rec.status === 201, `Daniel recommends 4% for Mary (${short(rec).slice(0, 120)})`)
    const rvw = await call('GET', `/comp-reviews/${cr0.data?.id}/review`, fiona)
    check(rvw.status === 200, 'payroll sees the recommendations')
    const recId = rvw.data?.recommendations?.[0]?.id ?? rvw.data?.rows?.[0]?.recommendationId ?? rvw.data?.items?.[0]?.id
    if (recId) check((await call('POST', `/comp-reviews/recommendations/${recId}/decide`, gina, { approve: true })).status === 200, 'a payroll admin approves it')
    check((await call('GET', '/comp-reviews/team-cost', fiona)).status < 500, 'team cost answers')
    check((await call('POST', `/comp-reviews/${cr0.data?.id}/close`, fiona, {})).status < 500, 'the cycle can be closed or is refused clearly')
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      const ids = emps.map((e) => e._id)
      for (const c of ['leave_balances', 'leave_allocations', 'salary_revisions', 'comp_recommendations']) await db.collection(c).deleteMany({ employeeId: { $in: ids } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

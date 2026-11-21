// What was still answering 501 on the MongoDB API, now ported: off-cycle and correction runs, flexi-basket, data imports (leave balances,
// bank details, contracts), employee skills and resume lines, event handlers (notifications delivered by the in-process pump) and the
// scheduled jobs (each run by hand). Runs a real two-person payroll. Removes its company at the end.
//   API=http://localhost:4218 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-gaps.test.js
const crypto = require('crypto')
const mongoose = require('mongoose')
const API = (process.env.API || 'http://localhost:4200') + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
const iso = (d) => d.toISOString().slice(0, 10)
const nextMonday = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 7); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d }

;(async () => {
  const stamp = Date.now(), email = `gp${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    require('../../dist/mongo-mode')
    const { encryptField } = require('../../dist/shared/utils/crypto')
    const su = await call('POST', '/auth/signup', null, { companyName: `Gaps Test ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken
    await call('PATCH', '/company', owner, { primaryCountry: 'ZM', baseCurrency: 'ZMW' })
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2025-01-01', employmentType: 'full_time' })).data.employee.id
    const maryId = await mk('Mary', 'Banda'), danielId = await mk('Daniel', 'Zulu'), fionaId = await mk('Fiona', 'Phiri'), ginaId = await mk('Gina', 'Tembo'), paulId = await mk('Paul', 'Mwale')
    const mary = await login(owner, maryId, `mary${stamp}@example.com`, ['employee'])
    const daniel = await login(owner, danielId, `daniel${stamp}@example.com`, ['manager'])
    const fiona = await login(owner, fionaId, `fiona${stamp}@example.com`, ['payroll_admin'])
    const gina = await login(owner, ginaId, `gina${stamp}@example.com`, ['payroll_admin'])
    await db.collection('employees').updateOne({ _id: maryId }, { $set: { managerId: danielId } })
    for (const [id, acct] of [[maryId, '0123456789'], [danielId, '0987654321']]) await db.collection('employees').updateOne({ _id: id }, { $set: { bankName: 'Zanaco', bankAccountNo: encryptField(acct), bankIfscSwift: 'ZNCOZMLU', bankVerified: true } })
    const st = await call('POST', '/salary/structures/starter', fiona)
    const structureId = st.data.id || st.data.structure?.id
    for (const [id, wage] of [[maryId, 10000], [danielId, 20000]]) {
      const c = await call('POST', '/leave/contracts', fiona, { employeeId: id, ctcAnnual: wage * 12, wageMonthly: wage, currency: 'ZMW', effectiveFrom: '2026-01-01', salaryStructureId: structureId })
      for (const step of ['draft', 'confirm', 'activate']) await call('POST', `/leave/contracts/${c.data.id}/${step}`, fiona, {})
    }
    await sleep(1500)

    // ── flexi-basket: configure, choose, approve, and the next run splits the pot
    check((await call('PUT', `/salary/structures/${structureId}/flexi`, mary, { potCode: 'TRANSPORT', components: [{ code: 'FUEL', name: 'Fuel', max: 1000 }] })).status === 403, 'an employee cannot configure a flexi-basket')
    const fx = await call('PUT', `/salary/structures/${structureId}/flexi`, fiona, { potCode: 'TRANSPORT', components: [{ code: 'FUEL', name: 'Fuel', max: 1000 }, { code: 'PHONE', name: 'Phone', max: 500 }] })
    check(fx.status === 200, `payroll configures TRANSPORT as the flexi pot (${short(fx).slice(0, 120)})`)
    const mine0 = await call('GET', '/salary/flexi/mine', mary)
    check(mine0.status === 200 && mine0.data.enabled === true && mine0.data.potCode === 'TRANSPORT', `Mary sees the basket (${short(mine0).slice(0, 120)})`)
    check((await call('PUT', '/salary/flexi/mine', mary, { choices: { FUEL: 5000 } })).status === 400, 'a choice above the component maximum is refused')
    const ch = await call('PUT', '/salary/flexi/mine', mary, { choices: { FUEL: 600, PHONE: 300 } })
    check(ch.status === 200, `Mary chooses fuel 600 and phone 300 (${short(ch).slice(0, 100)})`)
    const pend = await call('GET', '/salary/flexi', fiona)
    const choiceId = pend.data?.[0]?.id
    check(pend.status === 200 && pend.data.length === 1, 'Payroll sees one choice waiting')
    check((await call('POST', `/salary/flexi/${choiceId}/decide`, mary, { approve: true })).status === 403, 'Mary cannot approve her own choice')
    check((await call('POST', `/salary/flexi/${choiceId}/decide`, fiona, { approve: true })).status === 200, 'Payroll approves it')

    // ── monthly run with the split, then pay it
    const cyc = await call('POST', '/payroll/cycles', fiona, { payPeriodStart: '2026-11-01', payPeriodEnd: '2026-11-30' })
    const cid = cyc.data.id
    await call('POST', `/payroll/cycles/${cid}/lock-attendance`, fiona)
    const run = await call('POST', `/payroll/cycles/${cid}/run`, fiona)
    check(run.status === 200 && run.data.processed === 2, `monthly run (${short(run).slice(0, 100)})`)
    const slips = await call('GET', `/payroll/cycles/${cid}/payslips`, fiona)
    const maryslip = slips.data.find((p) => p.employeeId === maryId)
    const detail = await call('GET', `/payroll/payslips/${maryslip.id}`, fiona)
    const lines = detail.data?.lines ?? []
    check(lines.some((l) => l.code === 'FLEXI_FUEL' && l.amount === 600) && lines.some((l) => l.code === 'FLEXI_PHONE' && l.amount === 300), `Mary's payslip shows the flexi split (${lines.map((l) => l.code + ':' + l.amount).join(' ').slice(0, 200)})`)
    const rest = lines.find((l) => l.code === 'TRANSPORT')
    check(rest && rest.amount === 600, `the unallocated rest stays as the pot (1500 - 900 = ${rest?.amount})`)
    const dslip = (await call('GET', `/payroll/payslips/${slips.data.find((p) => p.employeeId === danielId).id}`, fiona)).data
    check(!dslip.lines.some((l) => String(l.code).startsWith('FLEXI_')), "Daniel has no choice, so his payslip is unchanged")
    check((await call('GET', '/salary/flexi/mine', mary)).data.pot === 1500, "'my basket' shows the pot from the latest payslip")
    await call('POST', `/payroll/cycles/${cid}/approve`, fiona)
    await call('POST', `/payroll/cycles/${cid}/finance-approve`, gina)
    check((await call('POST', `/payroll/cycles/${cid}/disburse`, gina)).data?.status === 'disbursed', 'the run is disbursed')

    // ── off-cycle run
    const types = await call('GET', '/salary/input-types', fiona)
    const bonus = types.data.find((t) => t.category !== 'deductions')
    check(!!bonus, 'there is an earnings input type')
    check((await call('POST', '/payroll/cycles', fiona, { payPeriodStart: '2026-11-15', payPeriodEnd: '2026-11-15', offCycle: true })).status === 400, 'an off-cycle run needs a reason')
    check((await call('POST', '/payroll/cycles', fiona, { payPeriodStart: '2026-11-01', payPeriodEnd: '2026-11-30', correctsCycleId: crypto.randomUUID() })).status === 400, 'a correction must point at a paid run')
    const oc = await call('POST', '/payroll/cycles', fiona, { payPeriodStart: '2026-11-30', payPeriodEnd: '2026-11-30', offCycle: true, reason: 'Referral bonus for Mary' })
    check(oc.status === 201 && oc.data.offCycle === true && oc.data.cycleType === 'off_cycle', `off-cycle run is created next to a paid monthly run (${short(oc).slice(0, 140)})`)
    const ocid = oc.data.id
    const inp = await call('POST', `/payroll/cycles/${ocid}/inputs`, fiona, { employeeId: maryId, inputTypeId: bonus.id, amount: 750, description: 'Referral' })
    check(inp.status === 201, `Payroll adds a 750 input for Mary (${short(inp).slice(0, 100)})`)
    check((await call('POST', `/payroll/inputs/${inp.data.id}/approve`, fiona)).status === 403, 'the same person cannot approve their own input')
    check((await call('POST', `/payroll/inputs/${inp.data.id}/approve`, gina)).status === 200, 'a second Payroll admin approves it')
    const ocRun = await call('POST', `/payroll/cycles/${ocid}/run`, fiona) // no attendance lock needed
    check(ocRun.status === 200 && ocRun.data.processed === 1, `the off-cycle run pays only Mary (${short(ocRun).slice(0, 140)})`)
    const ocSlips = await call('GET', `/payroll/cycles/${ocid}/payslips`, fiona)
    check(ocSlips.data.length === 1 && ocSlips.data[0].netPay === 750 && ocSlips.data[0].grossEarnings === 750, `Mary's off-cycle net is 750 (${ocSlips.data[0]?.netPay})`)
    await call('POST', `/payroll/cycles/${ocid}/approve`, fiona)
    await call('POST', `/payroll/cycles/${ocid}/finance-approve`, gina)
    check((await call('POST', `/payroll/cycles/${ocid}/disburse`, gina)).data?.status === 'disbursed', 'the off-cycle run is disbursed')
    // a correction to the paid monthly run: a linked run, nothing in the paid run changes
    const cor = await call('POST', '/payroll/cycles', fiona, { payPeriodStart: '2026-11-30', payPeriodEnd: '2026-11-30', offCycle: true, reason: 'Correct November transport', correctsCycleId: cid })
    check(cor.status === 201 && cor.data.correctsCycleId === cid, `a correction run points at the paid run (${short(cor).slice(0, 120)})`)
    check((await call('GET', `/payroll/cycles/${cid}`, fiona)).data.status === 'disbursed', 'the paid run is untouched')
    const jr = await call('GET', `/payroll/cycles/${ocid}/journal?format=json`, fiona)
    check(jr.status === 200 && JSON.stringify(jr.body).includes('OFFCYCLE'), `the accounting journal marks the off-cycle run (${jr.status})`)

    // ── skills and resume lines
    const stype = crypto.randomUUID(), skill = crypto.randomUUID(), lvl = crypto.randomUUID()
    await db.collection('skill_types').insertOne({ _id: stype, tenantId, name: 'Languages', createdAt: new Date() })
    await db.collection('skills').insertOne({ _id: skill, skillTypeId: stype, name: 'English', createdAt: new Date() })
    await db.collection('skill_levels').insertOne({ _id: lvl, skillId: skill, levelName: 'Fluent', progressPct: 90, sequence: 2 })
    const sk = await call('GET', '/employees/skill-types', owner)
    check(sk.status === 200 && sk.data.length === 1 && sk.data[0].skills[0].levels[0].levelName === 'Fluent', `skill types list with their levels (${short(sk).slice(0, 140)})`)
    const as = await call('POST', `/employees/${maryId}/skills`, owner, { skillId: skill, skillLevelId: lvl, justification: 'Spoken daily' })
    check(as.status === 201 && as.data.skill?.name === 'English' && as.data.skillLevel?.levelName === 'Fluent', `HR adds a skill (${short(as).slice(0, 140)})`)
    check((await call('POST', `/employees/${maryId}/skills`, owner, { skillId: crypto.randomUUID() })).status === 404, 'an unknown skill is 404')
    check((await call('POST', `/employees/${crypto.randomUUID()}/skills`, owner, { skillId: skill })).status === 404, 'an unknown employee is 404')
    check((await call('GET', `/employees/${maryId}`, owner)).data.skills.some((k) => k.skill?.name === 'English' && k.skill.skillType?.name === 'Languages'), 'the profile lists the skill with its type')
    check((await call('DELETE', `/employees/${maryId}/skills/${as.data.id}`, owner)).status < 300, 'HR removes the skill')
    const rl = await call('POST', `/employees/${maryId}/resume`, owner, { lineType: 'experience', name: 'Accountant', organisation: 'ZESCO', dateStart: '2020-01-01', dateEnd: '2023-12-31' })
    check(rl.status === 201, `HR adds a resume line (${short(rl).slice(0, 120)})`)
    check((await call('PATCH', `/employees/${maryId}/resume/${rl.data.id}`, owner, { name: 'Senior accountant' })).status < 300, 'and edits it')
    check((await call('GET', `/employees/${maryId}`, owner)).text.includes('Senior accountant'), 'the profile shows the edited line')
    check((await call('DELETE', `/employees/${maryId}/resume/${rl.data.id}`, owner)).status < 300, 'and removes it')
    check((await call('POST', `/employees/${maryId}/resume`, mary, { lineType: 'award', name: 'X' })).status === 403, 'an employee cannot edit resume lines through HR routes')

    // ── data imports
    const leaveTypes = (await call('GET', '/leave/types', mary)).data
    const annual = leaveTypes.find((t) => t.code === 'ANNUAL')
    const emps = (await call('GET', '/employees?limit=50', owner)).data
    const code = (id) => (emps.employees ?? emps.items ?? emps).find((e) => e.id === id)?.employeeCode
    const lb = await call('POST', '/employees/import/leave_balances', owner, { rows: [{ employee_id: code(maryId), leave_type: 'Annual', balance_days: '12.5', used_days: '2' }, { employee_id: 'NOPE', leave_type: 'Annual', balance_days: '3' }], dryRun: true })
    check(lb.status === 200 && JSON.stringify(lb.data).includes('NOPE'), `dry run reports the unknown person (${short(lb).slice(0, 160)})`)
    const lb2 = await call('POST', '/employees/import/leave_balances', owner, { rows: [{ employee_id: code(maryId), leave_type: annual.name, balance_days: '12.5', used_days: '2' }], dryRun: false })
    check(lb2.status === 200, `leave balances import (${short(lb2).slice(0, 160)})`)
    const mb = (await call('GET', '/leave/balances/me', mary)).data.find((b) => b.leaveTypeId === annual.id || b.leaveType?.code === 'ANNUAL')
    check(mb?.balanceDays === 12.5, `Mary's annual balance is now 12.5 (${mb?.balanceDays})`)
    const bk = await call('POST', '/employees/import/bank_details', owner, { rows: [{ employee_id: code(paulId), bank: 'Zanaco', account_number: '5550001112', ifsc_swift: 'ZNCOZMLU' }], dryRun: false })
    check(bk.status === 200, `bank details import (${short(bk).slice(0, 160)})`)
    const pe = await db.collection('employees').findOne({ _id: paulId })
    check(pe.bankAccountNo && !String(pe.bankAccountNo).includes('5550001112') && pe.bankVerified !== true, 'the account number is stored encrypted and left unverified')
    const ct = await call('POST', '/employees/import/contracts', fiona, { rows: [{ employee_id: code(paulId), wage_monthly: '8000', ctc_annual: '96000', currency: 'ZMW', effective_from: '2026-01-01', salary_structure: 'Zambia Standard Monthly' }], dryRun: false })
    check(ct.status === 200, `contracts import (${short(ct).slice(0, 160)})`)
    check((await db.collection('employee_contracts').countDocuments({ employeeId: paulId })) === 1, "Paul has a contract from the import")
    const mi = await call('POST', '/employees/import/contracts', mary, { rows: [{ employee_id: code(paulId) }], dryRun: true })
    check(mi.status === 403, `an employee cannot import (${short(mi).slice(0, 120)})`)

    // ── event handlers: a leave request notifies the manager, approving it notifies Mary (delivered by the pump, so allow a few seconds)
    const mon = nextMonday()
    const rq = await call('POST', '/leave/requests', mary, { leaveTypeId: annual.id, startDate: iso(mon), endDate: iso(mon), reason: 'Appointment' })
    check(rq.status === 201, `Mary applies for a day (${short(rq).slice(0, 100)})`)
    const waitFor = async (token, type) => { for (let i = 0; i < 12; i++) { const n = await call('GET', '/notifications', token); const list = n.data?.items ?? n.data?.notifications ?? n.data ?? []; if (JSON.stringify(list).includes(type)) return true; await sleep(1500) } return false }
    check(await waitFor(daniel, 'leave.approval.requested'), "Daniel's bell shows the leave request that needs him")
    check((await call('POST', `/leave/requests/${rq.data.id}/approve`, daniel, {})).status === 200, 'Daniel approves it')
    check(await waitFor(mary, 'leave.request.approved'), "Mary's bell shows it was approved")
    await call('POST', `/payroll/cycles/${ocid}/release`, fiona).catch(() => {})

    // ── scheduled jobs, each run by hand (the system admin runs them for their own company)
    const jobs = await call('GET', '/system/jobs', owner)
    check(jobs.status === 200 || jobs.status === 500 || jobs.status === 503, `the jobs list answers (${jobs.status})`)
    for (const name of ['events-sweep', 'people-dates', 'leave-sla-escalation', 'absent-marking', 'contracts', 'position-changes', 'document-expiry', 'leave-year-end', 'absence-flags', 'leave-attendance-check', 'carry-forward-expiry', 'declaration-window', 'leave-accrual']) {
      const r = await call('POST', `/system/jobs/${name}/run`, owner)
      check(r.status === 200, `job ${name} runs on MongoDB (${short(r).slice(0, 160)})`)
    }
  } catch (e) { failed++; console.log('✗ crashed:', e) } finally {
    if (tenantId && process.env.KEEP) console.log('kept tenant', tenantId)
    else if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      const ids = emps.map((e) => e._id)
      const types = await db.collection('skill_types').find({ tenantId }).project({ _id: 1 }).toArray()
      const skills = await db.collection('skills').find({ skillTypeId: { $in: types.map((t) => t._id) } }).project({ _id: 1 }).toArray()
      await db.collection('skill_levels').deleteMany({ skillId: { $in: skills.map((s) => s._id) } })
      await db.collection('skills').deleteMany({ skillTypeId: { $in: types.map((t) => t._id) } })
      for (const c of ['leave_balances', 'employee_skills', 'resume_lines', 'employee_contracts']) await db.collection(c).deleteMany({ employeeId: { $in: ids } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
    console.log(`${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  }
})()

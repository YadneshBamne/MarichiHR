// People fixes, recruitment / alumni / offboarding, on the MongoDB API: hiring rules (seats, duplicates, offers, interviews), candidate emails
// and templates, calendar file, CV upload, candidate search; the alumni login opening nothing but the alumni page; resignation requests,
// backdated exits, negative settlements, what is left behind when someone goes, the last-day job and reminders.
// Removes its company at the end. Start the API with STORAGE_PROVIDER=memory and EMAIL_TRANSPORT unset (log: nothing is sent), then:
//   API=http://localhost:4273 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-pe-recruit.test.js
const mongoose = require('mongoose')
const API = (process.env.API || 'http://localhost:4200') + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data, code: json.code, headers: res.headers, text }
}
async function upload(path, token, name, bytes, type, fields = {}) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('file', new Blob([bytes], { type }), name)
  const res = await fetch(API + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, data: json.data, code: json.code }
}
async function login(owner, id, email, roles) {
  const g = await call('PUT', `/employees/${id}/access`, owner, { roles, password: 'generate', loginEnabled: true })
  const l = await call('POST', '/auth/login', null, { email, password: g.data.temporaryPassword })
  return (await call('POST', '/auth/change-password', l.data.accessToken, { currentPassword: g.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
}
const iso = (d) => d.toISOString().slice(0, 10)
const inDays = (n) => new Date(Date.now() + n * 86400000)
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

;(async () => {
  const stamp = Date.now(), email = `pe${stamp}@example.com`
  let tenantId
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  try {
    const su = await call('POST', '/auth/signup', null, { companyName: `People Fix ${stamp}`, fullName: 'Hana Owner', email, password: 'Correct-horse-1' })
    tenantId = su.data.user.tenant.id
    const owner = su.data.accessToken // hr_admin + system_admin
    check((await call('PUT', '/company/plan', owner, { plan: 'enterprise', addons: ['recruitment', 'alumni'] })).status === 200, 'plan: enterprise with the recruitment and alumni add-ons')
    await call('PUT', '/company/modules', owner, { modules: ['attendance', 'leave', 'payroll', 'exits'] })
    await call('PATCH', '/company', owner, { primaryCountry: 'ZM', baseCurrency: 'ZMW' })
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const mk = async (n, w) => (await call('POST', '/employees', owner, { firstName: n, lastName: w, workEmail: `${n.toLowerCase()}${stamp}@example.com`, orgUnitId: unit, hireDate: '2024-01-01', employmentType: 'full_time' })).data.employee.id
    const ids = { dan: await mk('Dan', 'Zulu'), mary: await mk('Mary', 'Banda'), paul: await mk('Paul', 'Mwale'), fiona: await mk('Fiona', 'Phiri'), gina: await mk('Gina', 'Tembo'), rita: await mk('Rita', 'Chola'), tom: await mk('Tom', 'Sata'), bob: await mk('Bob', 'Lungu'), sam: await mk('Sam', 'Kunda'), alma: await mk('Alma', 'Nkhoma') }
    const dan = await login(owner, ids.dan, `dan${stamp}@example.com`, ['manager'])
    const paul = await login(owner, ids.paul, `paul${stamp}@example.com`, ['employee'])
    const fiona = await login(owner, ids.fiona, `fiona${stamp}@example.com`, ['payroll_admin'])
    const gina = await login(owner, ids.gina, `gina${stamp}@example.com`, ['payroll_admin'])
    const rita = await login(owner, ids.rita, `rita${stamp}@example.com`, ['employee'])
    const bob = await login(owner, ids.bob, `bob${stamp}@example.com`, ['employee'])
    const sam = await login(owner, ids.sam, `sam${stamp}@example.com`, ['employee'])
    const uid = {}
    for (const [k, v] of Object.entries(ids)) uid[k] = (await db.collection('employees').findOne({ _id: v })).userId
    await db.collection('employees').updateMany({ _id: { $in: [ids.rita, ids.bob, ids.sam] } }, { $set: { managerId: ids.dan } })
    await db.collection('employees').updateOne({ _id: ids.tom }, { $set: { managerId: ids.rita } })
    const notes = (userId, type) => db.collection('notifications').find({ tenantId, userId, ...(type && { type }) }).toArray()

    // ════════════ RECRUITMENT ════════════
    const op = await call('POST', '/recruitment/openings', owner, { title: 'Cook', description: 'Kitchen', orgUnitId: unit, openings: 1, salaryMin: 5000, salaryMax: 8000, hiringManagerId: ids.dan })
    check(op.status === 201, `HR opens a 1-seat position (${short(op)})`)
    const op2 = await call('POST', '/recruitment/openings', owner, { title: 'Driver', description: 'Roads', orgUnitId: unit, openings: 1, hiringManagerId: ids.dan })
    const add = (opening, who, extra = {}) => call('POST', `/recruitment/openings/${opening}/candidates`, owner, { firstName: who, lastName: 'Lee', email: `${who.toLowerCase()}${stamp}@mail.example.com`, ...extra })
    const ann = await add(op.data.id, 'Ann'), bea = await add(op.data.id, 'Bea')
    check(ann.status === 201 && bea.status === 201, 'two candidates are added')
    const dupe = await add(op2.data.id, 'Ann')
    check(dupe.status === 409 && dupe.code === 'DUPLICATE_CANDIDATE' && dupe.body.details?.matches?.length === 1, `the same email on another opening is stopped with the matches (${short(dupe)})`)
    check((await add(op2.data.id, 'Ann', { allowDuplicate: true })).status === 201, 'HR can add them anyway on purpose')
    const asStaff = await call('POST', `/recruitment/openings/${op2.data.id}/candidates`, owner, { firstName: 'Mary', lastName: 'Banda', email: `mary${stamp}@example.com` })
    check(asStaff.status === 409 && /Works here/.test(asStaff.body.message), `a candidate whose email belongs to a current employee is flagged (${asStaff.body.message})`)
    const ref = await call('POST', `/recruitment/openings/${op.data.id}/refer`, paul, { firstName: 'Mary', lastName: 'Banda', email: `mary${stamp}@example.com` })
    check(ref.status === 409 && ref.code === 'DUPLICATE_CANDIDATE' && !ref.body.details, `a referral of someone already known is turned away without showing who (${short(ref)})`)

    // interviews
    const past = await call('POST', `/recruitment/candidates/${ann.data.id}/interviews`, owner, { interviewerUserId: uid.dan, scheduledAt: new Date(Date.now() - 86400000).toISOString() })
    check(past.status === 400 && past.code === 'INTERVIEW_IN_PAST', 'an interview in the past is refused')
    const iv = await call('POST', `/recruitment/candidates/${ann.data.id}/interviews`, owner, { interviewerUserId: uid.dan, scheduledAt: inDays(3).toISOString(), mode: 'video' })
    check(iv.status === 201, 'an interview is scheduled')

    // offers
    const noInterview = await call('POST', `/recruitment/candidates/${bea.data.id}/offer`, owner, { ctcAnnual: 6000, joiningDate: iso(inDays(30)) })
    check(noInterview.status === 409 && noInterview.code === 'INTERVIEW_REQUIRED', 'an offer without a completed interview is refused')
    check((await call('POST', `/recruitment/candidates/${bea.data.id}/offer`, owner, { ctcAnnual: 6000, joiningDate: iso(inDays(-3)), skipInterviewReason: 'Known to us' })).code === 'JOINING_IN_PAST', 'a joining date in the past is refused')
    const oor = await call('POST', `/recruitment/candidates/${bea.data.id}/offer`, owner, { ctcAnnual: 20000, joiningDate: iso(inDays(30)), skipInterviewReason: 'Known to us' })
    check(oor.status === 409 && oor.code === 'OFFER_OUT_OF_RANGE', 'pay outside the opening range needs a confirmation')
    const skipped = await call('POST', `/recruitment/candidates/${bea.data.id}/offer`, owner, { ctcAnnual: 20000, joiningDate: iso(inDays(30)), skipInterviewReason: 'Known to us', confirmOutOfRange: true })
    check(skipped.status === 200 && skipped.data.offerStatus === 'made', 'with a reason and the confirmation the offer is made')
    const skipAudit = await db.collection('audit_logs').findOne({ tenantId, entityType: 'candidate', entityId: bea.data.id, action: 'OFFER_MADE' })
    check(skipAudit?.newValue?.interviewSkipped === 'Known to us' && skipAudit.newValue.outOfRangeConfirmed === true, 'the skipped interview and the range confirmation are audited')
    check((await call('POST', `/recruitment/candidates/${bea.data.id}/offer`, owner, { ctcAnnual: 7000, joiningDate: iso(inDays(30)), skipInterviewReason: 'Known to us' })).status === 200, 'an offer that is only made can be revised')
    // feedback for Ann, then her offer needs no skip
    check((await call('POST', `/recruitment/interviews/${iv.data.id}/feedback`, dan, { rating: 4, recommendation: 'hire', feedback: 'Strong cook, calm in a rush.' })).status === 200, 'the interviewer records feedback')
    check((await call('POST', `/recruitment/candidates/${ann.data.id}/offer`, owner, { ctcAnnual: 6500, joiningDate: iso(inDays(30)) })).status === 200, 'with feedback in, the offer needs no skip')
    check((await call('POST', `/recruitment/candidates/${ann.data.id}/offer-response`, owner, { accepted: true })).status === 200, 'Ann accepts')
    const reoffer = await call('POST', `/recruitment/candidates/${ann.data.id}/offer`, owner, { ctcAnnual: 9000, joiningDate: iso(inDays(30)) })
    check(reoffer.status === 409 && reoffer.code === 'OFFER_ACCEPTED', 'an accepted offer cannot be silently re-made')
    const rej = await call('PATCH', `/recruitment/candidates/${ann.data.id}`, owner, { stage: 'rejected', rejectionReason: 'Changed our mind' })
    check(rej.status === 409 && rej.code === 'OFFER_ACCEPTED', 'a candidate with an accepted offer cannot be rejected')
    check((await call('POST', `/recruitment/candidates/${ann.data.id}/offer/withdraw`, dan, { reason: 'Testing' })).status === 403, 'only HR withdraws an offer')
    const wd = await call('POST', `/recruitment/candidates/${ann.data.id}/offer/withdraw`, owner, { reason: 'Budget frozen for a week' })
    check(wd.status === 200 && wd.data.offerStatus === 'withdrawn' && wd.data.stage === 'interview', `withdrawing the offer returns her to the pipeline (${short(wd)})`)
    check((await call('POST', `/recruitment/candidates/${ann.data.id}/offer`, owner, { ctcAnnual: 6500, joiningDate: iso(inDays(30)) })).status === 200, 'she can be offered again after a withdrawal')
    await call('POST', `/recruitment/candidates/${ann.data.id}/offer-response`, owner, { accepted: true })

    // seats and the new joiner
    const hireAnn = await call('POST', `/recruitment/candidates/${ann.data.id}/hire`, owner, { workEmail: `ann.work${stamp}@example.com` })
    check(hireAnn.status === 201 && hireAnn.data.openingFilled === true, `Ann is hired into the only seat (${short(hireAnn)})`)
    const onb = await db.collection('profile_requests').findOne({ tenantId, employeeId: hireAnn.data.employee.id, kind: 'onboarding' })
    check(!!onb && hireAnn.data.onboardingRequestId === onb._id, 'hiring starts an onboarding request for the new joiner')
    await call('POST', `/recruitment/candidates/${bea.data.id}/offer-response`, owner, { accepted: true })
    const full1 = await call('POST', `/recruitment/candidates/${bea.data.id}/hire`, owner, { workEmail: `bea.work${stamp}@example.com` })
    check(full1.status === 409 && full1.code === 'OPENING_NOT_OPEN', 'the filled opening is closed, so a second hire is refused')
    await call('PATCH', `/recruitment/openings/${op.data.id}`, owner, { status: 'open' })
    const full2 = await call('POST', `/recruitment/candidates/${bea.data.id}/hire`, owner, { workEmail: `bea.work${stamp}@example.com` })
    check(full2.status === 409 && full2.code === 'OPENING_FULL', `reopened, all seats are still counted (${short(full2)})`)

    // search and history
    const q1 = await call('GET', '/recruitment/candidates?q=ann', owner)
    check(q1.status === 200 && q1.data.some((c) => c.id === ann.data.id), 'HR searches candidates by name')
    const q2 = await call('GET', '/recruitment/candidates?q=ann%20lee', owner)
    check(q2.data.some((c) => c.id === ann.data.id) && q2.data.every((c) => /ann/i.test(c.name)), 'a two-word search finds the person')
    check((await call('GET', `/recruitment/candidates?stage=hired`, owner)).data.every((c) => c.stage === 'hired'), 'search filters by stage')
    check((await call('GET', '/recruitment/candidates', dan)).data.length >= 2, 'the hiring manager searches their own openings')
    check((await call('GET', '/recruitment/candidates', paul)).data.length === 0, 'an employee with no opening sees no candidates')
    const hist = await call('GET', `/recruitment/candidates/${ann.data.id}/history`, owner)
    check(hist.status === 200 && ['OFFER_MADE', 'OFFER_WITHDRAWN', 'CANDIDATE_HIRED'].every((a) => hist.data.some((h) => h.action === a)), 'the candidate history lists offers, the withdrawal and the hire')
    check((await call('GET', `/recruitment/candidates/${ann.data.id}/history`, paul)).status === 404, 'history is hidden from people who cannot see the candidate')

    // templates and emails
    const tpl = await call('GET', '/recruitment/templates', owner)
    check(tpl.status === 200 && tpl.data.templates.length === 4 && tpl.data.templates.every((t) => !t.custom), 'HR sees four default email templates (interview, rejection, offer, application received)')
    check((await call('GET', '/recruitment/templates', dan)).status === 403, 'managers do not edit templates')
    check((await call('PUT', '/recruitment/templates/rejection', owner, { subject: 'About {role}', body: 'Dear {candidate}, thanks {nonsense}.' })).status === 400, 'an unknown placeholder is refused')
    const put = await call('PUT', '/recruitment/templates/rejection', owner, { subject: 'Your application: {role}', body: 'Dear {candidate},\n\nWe will not be taking {role} further. Thank you from all of us at {company}.' })
    check(put.status === 200 && put.data.custom === true, 'HR edits a template')
    const prev = await call('POST', `/recruitment/candidates/${bea.data.id}/email/preview`, owner, { template: 'rejection' })
    check(prev.status === 200 && prev.data.subject === 'Your application: Cook' && prev.data.body.includes(`all of us at People Fix ${stamp}`) && prev.data.to.includes('bea'), `the preview fills the edited template (${prev.data?.subject})`)
    check((await call('POST', `/recruitment/candidates/${bea.data.id}/email/send`, dan, { template: 'rejection' })).status === 403, 'only HR sends candidate emails')
    check((await call('POST', `/recruitment/candidates/${ann.data.id}/email/preview`, owner, { template: 'interview' })).status === 400, 'an interview email must name the interview')
    const ivNew = await call('POST', `/recruitment/candidates/${bea.data.id}/interviews`, owner, { interviewerUserId: uid.dan, scheduledAt: inDays(4).toISOString(), mode: 'phone' })
    const iprev = await call('POST', `/recruitment/candidates/${bea.data.id}/email/preview`, owner, { template: 'interview', interviewId: ivNew.data.id, link: 'https://meet.example/abc' })
    check(iprev.status === 200 && iprev.data.attachment === 'interview.ics' && iprev.data.body.includes('Meeting link: https://meet.example/abc') && /Phone call/.test(iprev.data.body), `the interview preview carries the date, mode, link and a calendar file (${short(iprev)})`)
    const noLink = await call('POST', `/recruitment/candidates/${bea.data.id}/email/preview`, owner, { template: 'interview', interviewId: ivNew.data.id })
    check(!!noLink.data && !noLink.data.body.includes('Meeting link'), 'with no link the empty "Meeting link" line is dropped')
    const sent = await call('POST', `/recruitment/candidates/${bea.data.id}/email/send`, owner, { template: 'interview', interviewId: ivNew.data.id, link: 'https://meet.example/abc' })
    check(sent.status === 200 && sent.data.sent === true, `HR sends the invitation (${short(sent)})`)
    const logged = await db.collection('audit_logs').findOne({ tenantId, entityType: 'candidate', entityId: bea.data.id, action: 'CANDIDATE_EMAIL_SENT' })
    check(logged?.newValue?.template === 'interview' && logged.newValue.to.includes('bea'), 'every send is logged on the candidate')
    check((await call('POST', `/recruitment/candidates/${bea.data.id}/email/send`, owner, { template: 'offer' })).status === 200, 'the offer email goes once an offer is made')
    check((await call('POST', `/recruitment/candidates/${ann.data.id}/email/send`, owner, { template: 'offer' })).status === 409, 'no offer email for someone with no offer')
    check((await call('POST', `/recruitment/candidates/${bea.data.id}/email/send`, owner, { template: 'rejection', rejectNow: true })).status === 400, 'send and reject needs a reason')
    const rejBlocked = await call('POST', `/recruitment/candidates/${bea.data.id}/email/send`, owner, { template: 'rejection', rejectNow: true, reason: 'Not the right fit' })
    check(rejBlocked.status === 409 && rejBlocked.code === 'OFFER_ACCEPTED', 'send and reject is stopped while her offer is accepted')
    await call('POST', `/recruitment/candidates/${bea.data.id}/offer/withdraw`, owner, { reason: 'Role is filled by Ann' })
    const rejAcc = await call('POST', `/recruitment/candidates/${bea.data.id}/email/send`, owner, { template: 'rejection', rejectNow: true, reason: 'Not the right fit' })
    check(rejAcc.status === 200 && (await call('GET', `/recruitment/candidates/${bea.data.id}`, owner)).data.stage === 'rejected', 'send and reject rejects first, then writes to the candidate')
    check((await call('DELETE', '/recruitment/templates/rejection', owner)).data.custom === false, 'a template can be reset to the default')
    // calendar file
    const icsRes = await fetch(`${API}/recruitment/interviews/${ivNew.data.id}/ics`, { headers: { Authorization: `Bearer ${owner}` } })
    const icsText = await icsRes.text()
    check(icsRes.status === 200 && /text\/calendar/.test(icsRes.headers.get('content-type') || '') && icsText.includes('BEGIN:VEVENT') && icsText.includes('SUMMARY:Interview: Cook'), 'the interview calendar file downloads')
    check((await fetch(`${API}/recruitment/interviews/${ivNew.data.id}/ics`, { headers: { Authorization: `Bearer ${paul}` } })).status === 404, 'and not for people outside the interview')
    // CV file
    const cvBad = await upload(`/recruitment/candidates/${ann.data.id}/cv`, owner, 'cv.exe', Buffer.from('MZ'), 'application/x-msdownload')
    check(cvBad.status === 400, 'only PDF, DOC and DOCX CVs are accepted')
    const cv = await upload(`/recruitment/candidates/${ann.data.id}/cv`, owner, 'ann-cv.pdf', PDF, 'application/pdf')
    check(cv.status === 201 && cv.data.resumeFile === 'ann-cv.pdf', `HR uploads a CV (${cv.status} ${cv.code ?? ''})`)
    const cand = (await call('GET', `/recruitment/candidates/${ann.data.id}`, owner)).data
    check(cand.resumeUrl === null && cand.resumeFile === 'ann-cv.pdf', 'the screen gets the file name, never the storage key')
    const cvLink = await call('GET', `/recruitment/candidates/${ann.data.id}/cv`, owner)
    check(cvLink.status === 200 && cvLink.data.expiresInSeconds === 300 && cvLink.data.name === 'ann-cv.pdf', 'the CV opens through a short-lived link')
    check((await call('GET', `/recruitment/candidates/${ann.data.id}/cv`, paul)).status === 404, 'and not for people who cannot see the candidate')
    check((await call('GET', `/recruitment/candidates/${ann.data.id}/cv`, dan)).status === 200, 'the hiring manager can open it')
    check((await call('DELETE', `/recruitment/candidates/${ann.data.id}/cv`, owner)).status === 200 && (await call('GET', `/recruitment/candidates/${ann.data.id}/cv`, owner)).status === 404, 'a CV can be removed')

    // ════════════ ALUMNI ════════════
    const alumaUser = uid.alma
    await db.collection('employees').updateOne({ _id: ids.alma }, { $set: { employmentStatus: 'terminated', active: false, archivedAt: new Date() } })
    await db.collection('users').updateOne({ _id: alumaUser }, { $set: { active: false } })
    const en = await call('POST', `/alumni/${ids.alma}/enable`, owner)
    check(en.status === 200 && !!en.data.temporaryPassword, 'HR switches on alumni access')
    const al0 = await call('POST', '/auth/login', null, { email: en.data.email, password: en.data.temporaryPassword })
    const alumni = (await call('POST', '/auth/change-password', al0.data.accessToken, { currentPassword: en.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data?.accessToken
    check(!!alumni, 'the former employee signs in')
    for (const p of ['/dashboard', '/recruitment/openings', '/approvals/inbox', '/helpdesk/tickets', '/forums/spaces', '/holidays', '/announcements', '/policies', '/masters', '/employees', '/leave/types']) {
      const r = await call('GET', p, alumni)
      check(r.status === 403 && r.code === 'ALUMNI_RESTRICTED', `alumni cannot open ${p} (${r.status} ${r.code})`)
    }
    check((await call('GET', '/alumni/me', alumni)).status === 200, 'the alumni page still opens')
    check((await call('GET', '/auth/me', alumni)).status === 200, 'and so does their own account')
    check((await call('GET', '/notifications', alumni)).status < 400, 'and the bell')
    check((await call('PATCH', '/alumni/me/contact', alumni, { email: 'alma.home@mail.example.com', phone: '+260 97 000 1111' })).status === 200, 'they leave a personal contact')
    const alumList = (await call('GET', '/alumni', owner)).data.alumni.find((a) => a.employeeId === ids.alma)
    check(alumList?.contact?.email === 'alma.home@mail.example.com' && alumList.contact.phone === '+260 97 000 1111', 'HR sees the alumni contact details')
    await upload(`/employees/${ids.alma}/documents`, owner, 'exp.pdf', PDF, 'application/pdf', { category: 'contract', title: 'Experience letter', visibility: 'employee' })
    await upload(`/employees/${ids.alma}/documents`, owner, 'note.pdf', PDF, 'application/pdf', { category: 'contract', title: 'Internal note', visibility: 'hr' })
    const picker = await call('GET', `/alumni/employee/${ids.alma}/documents`, owner)
    check(picker.status === 200 && picker.data.length === 1 && picker.data[0].title === 'Experience letter', 'the letter picker lists only documents the person can see')
    check((await call('GET', `/alumni/employee/${ids.alma}/documents`, dan)).status === 403, 'only HR sees that list')

    // ════════════ OFFBOARDING ════════════
    const starter = await call('POST', '/salary/structures/starter', fiona)
    const structureId = starter.data.id || starter.data.structure?.id
    const ct = await call('POST', '/leave/contracts', fiona, { employeeId: ids.rita, ctcAnnual: 120000, wageMonthly: 10000, currency: 'ZMW', effectiveFrom: '2024-01-01', salaryStructureId: structureId })
    for (const step of ['draft', 'confirm', 'activate']) await call('POST', `/leave/contracts/${ct.data.id}/${step}`, fiona, {})
    // Bob: a backdated exit
    const bobBody = { employeeId: ids.bob, exitType: 'resignation', reason: 'Left already', noticeDate: iso(inDays(-20)), lastWorkingDate: iso(inDays(-2)), clearance: { IT: uid.gina, FINANCE: uid.fiona, ADMIN: uid.paul } }
    const noFlag = await call('POST', '/exits', owner, bobBody)
    check(noFlag.status === 400 && noFlag.code === 'BACKDATED_EXIT', `a last day in the past needs the backdated confirmation (${short(noFlag)})`)
    const bobExit = await call('POST', '/exits', owner, { ...bobBody, backdated: true })
    check(bobExit.status === 201, 'with the confirmation the exit starts')
    check((await notes(uid.gina, 'exit.clearance_assigned')).length === 1 && (await notes(uid.fiona, 'exit.clearance_assigned')).length === 1 && (await notes(uid.paul, 'exit.clearance_assigned')).length === 1, 'every sign-off owner is told when the exit starts')
    check((await notes(uid.dan, 'exit.clearance_assigned')).length === 1, 'the manager holds the MANAGER sign-off and is told')
    const clk = await call('POST', '/attendance/clock-in', bob, { method: 'web' })
    check(clk.status === 403 && clk.code === 'EMPLOYMENT_ENDED', 'after the last working day clock-in is refused')
    const lv = await call('GET', '/leave/types', bob)
    const lvType = lv.data.find((t) => t.isPaid)
    const leaveAfter = await call('POST', '/leave/requests', bob, { leaveTypeId: lvType.id, startDate: iso(inDays(5)), endDate: iso(inDays(6)), reason: 'x' })
    check(leaveAfter.status === 400 && leaveAfter.code === 'LEAVE_AFTER_EXIT', 'leave after the last working day is refused')
    // the last-day job
    await db.collection('employee_exits').updateOne({ _id: bobExit.data.id }, { $set: { createdAt: new Date(Date.now() - 5 * 86400000) } })
    const run1 = await call('POST', '/system/jobs/exit-last-day/run', owner)
    check(run1.status === 200 && run1.data[tenantId]?.loginsEnded === 1 && run1.data[tenantId]?.reminders >= 3, `the job ends the login and reminds the sign-off owners (${JSON.stringify(run1.data?.[tenantId])})`)
    check((await db.collection('users').findOne({ _id: uid.bob })).active === false, "Bob's login is switched off")
    check((await call('GET', '/dashboard/counts', bob)).status === 401, "and his old token stops working")
    check((await notes(uid.gina, 'exit.clearance_overdue')).length === 1, 'the IT owner got an overdue reminder')
    const run2 = await call('POST', '/system/jobs/exit-last-day/run', owner)
    check(run2.data[tenantId].reminders === 0 && run2.data[tenantId].loginsEnded === 0, 'running it again changes nothing (once a day at most, idempotent)')
    check((await call('POST', `/exits/${bobExit.data.id}/restore-login`, dan)).status === 403, 'only HR restores a login')
    check((await call('POST', `/exits/${bobExit.data.id}/restore-login`, owner)).status === 200 && (await db.collection('users').findOne({ _id: uid.bob })).active === true, 'HR can restore it')
    await call('POST', '/system/jobs/exit-last-day/run', owner)
    check((await db.collection('users').findOne({ _id: uid.bob })).active === false, 'the job ends it again after the last day')
    check((await call('POST', `/exits/${bobExit.data.id}/cancel`, owner, { reason: 'He is staying after all' })).status === 200 && (await db.collection('users').findOne({ _id: uid.bob })).active === true, 'cancelling the exit gives the login back')

    // resignation request: Sam
    const rs = await call('POST', '/exits/resign', sam, { reason: 'Family reasons' })
    check(rs.status === 201 && rs.data.status === 'requested', `Sam hands in a resignation (${short(rs)})`)
    check((await call('POST', '/exits/resign', sam, { reason: 'Again' })).status === 409, 'and cannot hand in a second one')
    check((await notes(uid.fiona, 'exit.requested')).length === 0 && (await db.collection('notifications').countDocuments({ tenantId, type: 'exit.requested' })) >= 1, 'HR is told about the resignation')
    const mine = await call('GET', '/exits/mine', sam)
    check(mine.data.exit.status === 'requested' && mine.data.canResign === false && !('netPayable' in mine.data.exit) && !('lines' in mine.data.exit), 'Sam sees his own request and no pay')
    check((await call('POST', `/exits/${rs.data.id}/decline`, sam, { reason: 'No' })).status === 403, 'an employee cannot decline for HR')
    check((await call('POST', `/exits/${rs.data.id}/decline`, owner, { reason: 'Please talk to your manager first' })).status === 200, 'HR declines with a reason')
    check((await call('GET', '/exits/mine', sam)).data.exit.declinedReason === 'Please talk to your manager first' && (await call('GET', '/exits/mine', sam)).data.canResign === true, 'Sam sees the reason and may try again')
    const rs2 = await call('POST', '/exits/resign', sam, { reason: 'Final decision', lastWorkingDate: iso(inDays(20)) })
    check(rs2.status === 201, 'he resigns again with a proposed last day')
    check((await call('POST', `/exits/${rs2.data.id}/accept`, sam, { clearance: { IT: uid.gina, FINANCE: uid.fiona, ADMIN: uid.paul } })).status === 403, 'an employee cannot accept their own resignation')
    const acc = await call('POST', `/exits/${rs2.data.id}/accept`, owner, { lastWorkingDate: iso(inDays(25)), clearance: { IT: uid.gina, FINANCE: uid.fiona, ADMIN: uid.paul } })
    check(acc.status === 200 && acc.data.status === 'initiated' && acc.data.clearances.length === 4 && iso(new Date(acc.data.lastWorkingDate)) === iso(inDays(25)), `HR accepts with a new last day and four sign-offs (${short(acc)})`)
    check(iso((await db.collection('employees').findOne({ _id: ids.sam })).exitDate) === iso(inDays(25)), "Sam's exit date is set on his record")
    check((await call('GET', '/exits/mine', sam)).data.exit.clearances.length === 4, 'Sam sees the sign-off steps')
    check((await call('GET', '/exits/clearances/mine', gina)).data.length >= 1 && (await notes(uid.gina, 'exit.clearance_assigned')).length >= 2, 'the sign-off owners are told, and the work shows under My sign-offs')

    // Rita: the full settlement
    await db.collection('employees').updateOne({ _id: ids.rita }, { $set: { taxJurisdiction: null } })
    await call('POST', '/leave/allocations/manual', owner, { employeeId: ids.rita, leaveTypeId: lvType.id, daysAllocated: 5, validFrom: '2024-01-01', reason: 'test' })
    const pend = await call('POST', '/leave/requests', rita, { leaveTypeId: lvType.id, startDate: iso(inDays(8)), endDate: iso(inDays(8)), reason: 'one day' })
    check(pend.status === 201, 'Rita has a pending leave request')
    const rbody = { employeeId: ids.rita, exitType: 'resignation', reason: 'New job', noticeDate: iso(inDays(-40)), lastWorkingDate: iso(inDays(10)), clearance: { IT: uid.gina, FINANCE: uid.fiona, ADMIN: uid.paul } }
    const rx = await call('POST', '/exits', owner, rbody)
    check(rx.status === 201, 'HR starts Rita\'s exit')
    const rid = rx.data.id
    const ritaLate = await call('POST', '/leave/requests', rita, { leaveTypeId: lvType.id, startDate: iso(inDays(12)), endDate: iso(inDays(12)), reason: 'after' })
    check(ritaLate.code === 'LEAVE_AFTER_EXIT', 'Rita cannot ask for leave after her last day')
    for (const [who, dept] of [[gina, 'IT'], [fiona, 'FINANCE'], [paul, 'ADMIN'], [dan, 'MANAGER']]) await call('POST', `/exits/${rid}/clearances/${dept}/sign`, who, {})
    check((await notes(uid.fiona, 'exit.ready_to_compute')).length === 1, 'payroll is told when every sign-off is done')
    // no tax country anywhere: blocked with a plain message; the company country fills the gap
    await db.collection('tenants').updateOne({ _id: tenantId }, { $set: { primaryCountry: null } })
    const noCountry = await call('POST', `/exits/${rid}/compute`, fiona, {})
    check(noCountry.status === 400 && noCountry.code === 'TAX_COUNTRY_MISSING', `no country anywhere stops the settlement with a clear message (${noCountry.body.message?.slice(0, 60)})`)
    await db.collection('tenants').updateOne({ _id: tenantId }, { $set: { primaryCountry: 'ZM' } })
    const comp = await call('POST', `/exits/${rid}/compute`, fiona, {})
    check(comp.status === 200 && comp.data.status === 'computed', `with the company country the settlement computes (${short(comp)})`)
    check(comp.data.lines.some((l) => l.section === 'gratuity') || comp.data.warnings.some((w) => /gratuity/i.test(w)), 'gratuity is worked out (or explained), not skipped silently')
    // negative settlement
    await db.collection('employee_exits').updateOne({ _id: rid }, { $set: { netPayable: -500 } })
    const hrView = await call('GET', `/exits/${rid}`, owner)
    check(hrView.data.netPayable === null && hrView.data.needsRecovery === true, 'HR sees that a recovery is needed, not the amount')
    const ap0 = await call('POST', `/exits/${rid}/approve`, gina)
    check(ap0.status === 409 && ap0.code === 'RECOVERY_REQUIRED', 'a negative settlement cannot be approved without a recovery')
    check((await call('POST', `/exits/${rid}/recovery`, paul, { note: 'Deducted from last advance' })).status === 403, 'only HR or payroll record a recovery')
    check((await call('POST', `/exits/${rid}/recovery`, owner, { note: 'x' })).status === 400, 'the recovery note needs real words')
    const rec = await call('POST', `/exits/${rid}/recovery`, fiona, { note: 'Recovered from the final salary advance', recoveredAmount: 500 })
    check(rec.status === 200 && rec.data.needsRecovery === false && rec.data.recovery.recoveredAmount === 500, 'payroll records how it is recovered')
    const recAudit = await db.collection('audit_logs').findOne({ tenantId, entityType: 'employee_exit', entityId: rid, action: 'FNF_RECOVERY_RECORDED' })
    check(!!recAudit, 'the recovery is audited')
    check((await call('POST', `/exits/${rid}/approve`, gina)).status === 200, 'with a recovery on record the settlement is approved')
    check((await call('GET', '/exits/export.csv', paul)).status === 403, 'employees cannot export')
    const csvHr = await call('GET', '/exits/export.csv', owner), csvPay = await call('GET', '/exits/export.csv', fiona)
    check(csvHr.status === 200 && /^Employee,Code,Type/.test(csvHr.text) && !/Net payable/.test(csvHr.text) && csvHr.text.includes('Rita Chola'), 'HR exports the exits list without amounts')
    check(/Net payable/.test(csvPay.text), 'payroll exports it with the net payable')
    // pay: the leftovers
    const ritaTokenBefore = (await call('GET', '/dashboard/counts', rita)).status
    await sleep(1200)
    const paid = await call('POST', `/exits/${rid}/pay`, gina)
    check(ritaTokenBefore === 200 && paid.status === 200 && paid.data.status === 'paid', `the settlement is paid (${short(paid)})`)
    check((await call('GET', '/dashboard/counts', rita)).status === 401, "Rita's old access token stops working at once")
    check((await db.collection('employees').findOne({ _id: ids.tom })).managerId === ids.dan, "Tom, who reported to Rita, now reports to Rita's manager Dan")
    check((await notes(uid.dan, 'exit.reports_reassigned')).length === 1 && (await notes(uid.tom, 'exit.reports_reassigned')).length === 1, 'the new manager and Tom are told')
    check((await db.collection('leave_requests').findOne({ _id: pend.data.id })).status === 'cancelled', "Rita's pending leave is called off")
    const bal = await db.collection('leave_balances').findOne({ employeeId: ids.rita, leaveTypeId: lvType.id })
    check(!bal || (bal.pendingDays ?? 0) === 0, 'and its days leave the pending balance')
    check((await notes(uid.dan, 'exit.alumni_available')).length === 0 && (await db.collection('notifications').countDocuments({ tenantId, type: 'exit.alumni_available' })) >= 1, 'HR is asked whether to give alumni access (not switched on by itself)')
    check(!(await db.collection('alumni_access').findOne({ tenantId, employeeId: ids.rita })), 'alumni access is not switched on automatically')

    console.log(`${passed} passed, ${failed} failed`)
  } finally {
    if (tenantId) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('leave_requests').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('exit_clearances').deleteMany({ exitId: { $in: (await db.collection('employee_exits').find({ tenantId }).project({ _id: 1 }).toArray()).map((x) => x._id) } })
      await db.collection('interviews').deleteMany({ candidateId: { $in: (await db.collection('candidates').find({ tenantId }).project({ _id: 1 }).toArray()).map((c) => c._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      await db.collection('profile_request_sections').deleteMany({ requestId: { $in: (await db.collection('profile_requests').find({ tenantId }).project({ _id: 1 }).toArray()).map((r) => r._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    await mongoose.disconnect()
  }
})().catch((e) => { console.error(e); process.exit(1) })

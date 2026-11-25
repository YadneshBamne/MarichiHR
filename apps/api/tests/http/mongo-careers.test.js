// The public careers page on the MongoDB API: HR switches and texts, the no-sign-in list and detail, publishing rules, tenant isolation,
// applying (consent, honeypot, speed, file checks, CV storage, duplicates, limits), what HR sees afterwards, and that nothing internal leaks.
// Removes its two companies at the end. Start the API with STORAGE_PROVIDER=memory and EMAIL_TRANSPORT unset (log: nothing is sent), then:
//   API=http://localhost:4274 DOTENV_CONFIG_PATH=.env node -r dotenv/config tests/http/mongo-careers.test.js
const mongoose = require('mongoose')
const Redis = require('ioredis')
const API = (process.env.API || 'http://localhost:4200') + '/api/v1'
let passed = 0, failed = 0
const check = (ok, msg) => { ok ? passed++ : (failed++, console.log('✗', msg)) }
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data, code: json.code, headers: res.headers, text }
}
// The public application: multipart with an optional CV
async function apply(slug, openingId, fields, file) {
  const fd = new FormData()
  for (const [k, v] of Object.entries({ firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', consent: 'true', startedAt: String(Date.now() - 10_000), ...fields })) if (v !== undefined) fd.append(k, String(v))
  if (file) fd.append('cv', new Blob([file.bytes], { type: file.type }), file.name)
  const res = await fetch(`${API}/public/careers/${slug}/openings/${openingId}/apply`, { method: 'POST', body: fd })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, data: json.data, code: json.code, details: json.details, text }
}
const pub = (path) => call('GET', `/public/careers${path}`)
const PDF = { bytes: Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF'), type: 'application/pdf', name: 'ann cv.pdf' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const stamp = Date.now()
  const tenants = []
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGODB_DB })
  const db = mongoose.connection.db
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
  const resetLimits = async () => { const k = await redis.keys('careers:*'); if (k.length) await redis.del(...k) }
  try {
    await resetLimits()
    const su = await call('POST', '/auth/signup', null, { companyName: `Careers Co ${stamp}`, fullName: 'Hana Owner', email: `cr${stamp}@example.com`, password: 'Correct-horse-1' })
    const tenantId = su.data.user.tenant.id; tenants.push(tenantId)
    const owner = su.data.accessToken
    const slug = su.data.workspace
    check((await call('PUT', '/company/plan', owner, { plan: 'growth', addons: ['recruitment'] })).status === 200, 'plan: growth with the recruitment add-on')
    const unit = (await call('GET', '/employees/org-units/tree', owner)).data[0].id
    const dan = (await call('POST', '/employees', owner, { firstName: 'Dan', lastName: 'Zulu', workEmail: `dan${stamp}@example.com`, orgUnitId: unit, hireDate: '2024-01-01', employmentType: 'full_time' })).data.employee.id
    const danUser = (await db.collection('employees').findOne({ _id: dan })).userId
    const ownerUser = (await db.collection('users').findOne({ tenantId, email: `cr${stamp}@example.com` }))._id
    const cook = (await call('POST', '/recruitment/openings', owner, { title: 'Cook', description: 'INTERNAL kitchen notes', orgUnitId: unit, openings: 2, salaryMin: 5000, salaryMax: 8000, hiringManagerId: dan })).data.id
    const driver = (await call('POST', '/recruitment/openings', owner, { title: 'Driver', description: 'Roads', orgUnitId: unit, openings: 1, hiringManagerId: dan })).data.id

    // ── off by default, and one generic answer for everything that is not public
    const off = await pub(`/${slug}`)
    const nope = await pub('/no-such-company-here')
    check(off.status === 404 && nope.status === 404, 'a careers page that is off, and an unknown one, are both 404')
    check(off.body.message === nope.body.message && off.code === nope.code, 'with the same generic answer: nothing reveals which it was')
    check(!/public/.test(off.headers.get('cache-control') ?? ''), 'a 404 is never cached')
    check((await pub('/BAD_SLUG!')).status === 404, 'a malformed slug is 404')

    // ── HR side
    const paul = (await call('POST', '/employees', owner, { firstName: 'Paul', lastName: 'Mwale', workEmail: `paul${stamp}@example.com`, orgUnitId: unit, hireDate: '2024-01-01', employmentType: 'full_time' })).data.employee.id
    const g = await call('POST', '/auth/login', null, { email: `paul${stamp}@example.com`, password: 'x' }) // no login yet: use the access endpoint
    const acc = await call('PUT', `/employees/${paul}/access`, owner, { roles: ['employee'], password: 'generate', loginEnabled: true })
    const pl = await call('POST', '/auth/login', null, { email: `paul${stamp}@example.com`, password: acc.data.temporaryPassword })
    const pw = (await call('POST', '/auth/change-password', pl.data.accessToken, { currentPassword: acc.data.temporaryPassword, newPassword: 'Fresh-pass-77x' })).data.accessToken
    check((await call('GET', '/recruitment/careers', pw)).status === 403, 'an employee cannot open the careers settings')
    check((await call('PUT', '/recruitment/careers/settings', pw, { enabled: true, headline: '', intro: '', applyNote: '', contactEmail: '', showSalary: false })).status === 403, 'an employee cannot change them')
    const st = await call('GET', '/recruitment/careers', owner)
    check(st.status === 200 && st.data.enabled === false && st.data.slug === slug && st.data.openings.length === 2 && st.data.showSalary === false, 'HR sees the settings: off, the link, both openings, salary hidden')
    check((await call('PUT', '/recruitment/careers/openings/' + cook, owner, { published: true })).status === 400, 'an opening cannot be shown before it has a public description')
    check((await call('PUT', '/recruitment/careers/openings/' + cook, owner, { publicDescription: 'short' })).status === 200, 'a short text can be saved on its own')
    check((await call('PUT', '/recruitment/careers/openings/' + cook, owner, { published: true })).status === 400, 'but not enough to publish')
    const desc = 'About the role\n\nYou will run the lunch service for 120 people.\n\nWhat we are looking for\n- Two years in a busy kitchen\n- Food safety certificate'
    const pubCook = await call('PUT', '/recruitment/careers/openings/' + cook, owner, { published: true, publicDescription: desc })
    check(pubCook.status === 200 && pubCook.data.published === true, 'HR publishes the cook opening with its description')
    check((await call('PUT', '/recruitment/careers/openings/' + driver, owner, { publicDescription: 'x'.repeat(6001) })).status === 400, 'a description over 6,000 characters is refused')
    check((await call('PUT', '/recruitment/careers/openings/00000000-0000-4000-8000-000000000000', owner, { published: false })).status === 404, 'an unknown opening is 404')
    check((await call('PUT', '/recruitment/careers/settings', owner, { enabled: true, headline: 'Join our kitchen', intro: 'We cook for the whole town.', applyNote: 'We are an equal opportunity employer.', contactEmail: 'bad address', showSalary: false })).status === 400, 'a bad contact email is refused')
    check((await call('PUT', '/recruitment/careers/settings', owner, { enabled: true, headline: 'Join our kitchen', intro: 'We cook for the whole town.', applyNote: 'We are an equal opportunity employer.', contactEmail: 'jobs@example.com', showSalary: false })).status === 200, 'HR switches the page on')

    // ── the public list and detail
    const list = await pub(`/${slug}`)
    check(list.status === 200 && list.data.company.name === `Careers Co ${stamp}` && list.data.company.headline === 'Join our kitchen' && list.data.company.contactEmail === 'jobs@example.com', 'the page shows the company, headline and contact')
    check(list.data.openings.length === 1 && list.data.openings[0].title === 'Cook', 'only the published, open opening is listed (Driver is not)')
    const item = list.data.openings[0]
    check(item.excerpt.startsWith('About the role') && item.employmentTypeLabel === 'Full time' && item.department && item.postedAt, 'the card has an excerpt, the type, the department and the date')
    check(item.salary === null && !('description' in item), 'no salary unless HR allows it, and no full text in the list')
    check(/public/.test(list.headers.get('cache-control') ?? '') && /max-age=60/.test(list.headers.get('cache-control') ?? ''), 'the list may be cached for 60 seconds')
    const det = await pub(`/${slug}/openings/${cook}`)
    check(det.status === 200 && det.data.opening.description === desc.replace(/\r/g, ''), 'the opening page has the full public description')
    check(/max-age=60/.test(det.headers.get('cache-control') ?? ''), 'and may be cached too')
    check((await pub(`/${slug}/openings/${driver}`)).status === 404, 'an unpublished opening is 404')
    check((await pub(`/${slug}/openings/not-an-id`)).status === 404, 'a bad opening id is 404')
    await call('PUT', '/recruitment/careers/settings', owner, { enabled: true, headline: 'Join our kitchen', intro: 'We cook for the whole town.', applyNote: 'We are an equal opportunity employer.', contactEmail: 'jobs@example.com', showSalary: true })
    const withPay = (await pub(`/${slug}`)).data.openings[0]
    check(withPay.salary && withPay.salary.min === 5000 && withPay.salary.max === 8000 && typeof withPay.salary.currency === 'string', 'salary shows once HR allows it')
    await call('PUT', '/recruitment/careers/settings', owner, { enabled: true, headline: 'Join our kitchen', intro: 'We cook for the whole town.', applyNote: 'We are an equal opportunity employer.', contactEmail: 'jobs@example.com', showSalary: false })
    const everything = JSON.stringify([(await pub(`/${slug}`)).body, (await pub(`/${slug}/openings/${cook}`)).body])
    check(!everything.includes(tenantId) && !everything.includes('tenantId') && !everything.includes('INTERNAL') && !everything.includes(dan) && !everything.includes('hiringManager') && !everything.includes('salaryMin'), 'no tenant id, internal notes, hiring manager or raw pay in the public JSON')

    // ── tenant isolation
    await resetLimits()
    const sb = await call('POST', '/auth/signup', null, { companyName: `Other Co ${stamp}`, fullName: 'Olga Owner', email: `ot${stamp}@example.com`, password: 'Correct-horse-1' })
    tenants.push(sb.data.user.tenant.id)
    const ownerB = sb.data.accessToken, slugB = sb.data.workspace
    await call('PUT', '/company/plan', ownerB, { plan: 'growth', addons: ['recruitment'] })
    const unitB = (await call('GET', '/employees/org-units/tree', ownerB)).data[0].id
    const baker = (await call('POST', '/recruitment/openings', ownerB, { title: 'Baker', description: 'x', orgUnitId: unitB, openings: 1 })).data.id
    await call('PUT', '/recruitment/careers/openings/' + baker, ownerB, { published: true, publicDescription: 'Bake bread every morning for our shop customers.' })
    await call('PUT', '/recruitment/careers/settings', ownerB, { enabled: true, headline: '', intro: '', applyNote: '', contactEmail: '', showSalary: false })
    const listB = await pub(`/${slugB}`)
    check(listB.status === 200 && listB.data.openings.length === 1 && listB.data.openings[0].title === 'Baker' && listB.data.company.headline === `Careers at Other Co ${stamp}`, 'the other company has its own page, with a default headline')
    check((await pub(`/${slug}/openings/${baker}`)).status === 404 && (await pub(`/${slugB}/openings/${cook}`)).status === 404, "one company's slug cannot reach the other company's opening")
    check((await apply(slug, baker, {})).status === 404, "nor apply to it")
    check((await call('PUT', '/recruitment/careers/openings/' + baker, owner, { published: false })).status === 404, "HR of one company cannot change the other's opening")

    // ── the plan
    await call('PUT', '/company/plan', owner, { plan: 'growth', addons: [] })
    check((await pub(`/${slug}`)).status === 404, 'without the recruitment feature the page is 404 (even though it is switched on)')
    await call('PUT', '/company/plan', owner, { plan: 'growth', addons: ['recruitment'] })
    await sleep(100)

    // ── applying: refusals first
    await resetLimits()
    const countCands = () => db.collection('candidates').countDocuments({ tenantId })
    check((await apply(slug, cook, { consent: undefined })).data === undefined && (await countCands()) === 0, 'no consent: refused')
    const noConsent = await apply(slug, cook, { consent: 'false' })
    check(noConsent.status === 400 && noConsent.details?.fields?.consent, 'with the reason against the consent box')
    const badMail = await apply(slug, cook, { email: 'not-an-email' })
    check(badMail.status === 400 && badMail.details?.fields?.email, 'a bad email is refused, with the field named')
    check((await apply(slug, cook, { firstName: '   ', lastName: '' })).status === 400, 'an empty name is refused')
    check((await apply(slug, cook, { phone: 'abc' })).status === 400, 'a phone with letters is refused')
    check((await apply(slug, cook, { message: 'x'.repeat(2001) })).status === 400, 'a message over 2,000 characters is refused')
    const quick = await apply(slug, cook, { startedAt: String(Date.now() - 500) })
    check(quick.status === 400 && quick.code === 'TOO_FAST', 'sent within 3 seconds of opening the form: refused')
    check((await apply(slug, cook, { startedAt: 'nonsense' })).code === 'TOO_FAST', 'no valid start time: refused the same way')
    const bot = await apply(slug, cook, { website: 'http://spam.example', email: 'bot@example.com' })
    check(bot.status === 201 && (await db.collection('candidates').countDocuments({ tenantId, email: 'bot@example.com' })) === 0, 'the hidden field filled in: a polite 201 and nothing kept')
    const fake = await apply(slug, cook, {}, { bytes: Buffer.from('MZ this is a program, not a pdf'), type: 'application/pdf', name: 'cv.pdf' })
    check(fake.status === 400 && fake.details?.fields?.cv, 'a file that says PDF but is not one (by its first bytes): refused')
    const wrongExt = await apply(slug, cook, {}, { bytes: PDF.bytes, type: 'application/pdf', name: 'cv.exe' })
    check(wrongExt.status === 400, 'a PDF with an .exe name: refused')
    const wrongType = await apply(slug, cook, {}, { bytes: Buffer.from('hello'), type: 'text/plain', name: 'cv.txt' })
    check(wrongType.status === 400, 'a text file: refused')
    const big = await apply(slug, cook, {}, { bytes: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 + 10)]), type: 'application/pdf', name: 'huge.pdf' })
    check(big.status === 400 && /5 MB/.test(big.body.message ?? ''), 'a file over 5 MB: refused with a clear message')
    check((await countCands()) === 0, 'none of the refused attempts created a candidate')

    // ── applying: it works
    const ok1 = await apply(slug, cook, { firstName: '<b>Ann</b>', lastName: 'Lee\u0007', email: 'Ann.Lee@Example.com', phone: '+260 97 1234567', message: 'I cook for 100 people at <script>alert(1)</script>a school.' })
    check(ok1.status === 201 && ok1.data.received === true && ok1.data.role === 'Cook', 'an application without a CV is received')
    const c1 = await db.collection('candidates').findOne({ tenantId, email: 'ann.lee@example.com' })
    check(c1 && c1.source === 'careers' && c1.stage === 'applied' && c1.openingId === cook, "it is a 'careers' candidate at stage applied, in the right opening")
    check(c1.firstName === 'Ann' && c1.lastName === 'Lee' && !/[<>]/.test(c1.summary) && c1.summary.includes('school') && c1.phone === '+260 97 1234567', 'tags and control characters were stripped, the email lowercased')
    check(c1.resumeUrl == null, 'no CV, no file')
    await sleep(700) // notifications and the thank-you email follow the answer
    const hrNote = await db.collection('notifications').findOne({ tenantId, userId: ownerUser, type: 'recruitment.application' })
    const mgrNote = await db.collection('notifications').findOne({ tenantId, userId: danUser, type: 'recruitment.application' })
    check(hrNote && mgrNote && hrNote.link === `/recruitment/${cook}`, 'HR and the hiring manager were told, with a link to the opening')
    const hist = await call('GET', `/recruitment/candidates/${c1._id}/history`, owner)
    check(hist.status === 200 && hist.data.some((h) => h.action === 'CANDIDATE_APPLIED') && hist.data.some((h) => h.action === 'CANDIDATE_EMAIL_SENT' && h.detail?.template === 'application_received' && h.detail?.to === 'ann.lee@example.com'), 'the history shows the application and the thank-you email to the applicant')
    const cand = await call('GET', `/recruitment/candidates/${c1._id}`, owner)
    check(cand.status === 200 && cand.data.source === 'careers', 'HR opens the candidate and sees the source as the careers page')
    check((await call('GET', `/recruitment/candidates/${c1._id}`, pw)).status >= 400, 'an ordinary employee cannot open the candidate')

    const ok2 = await apply(slug, cook, { firstName: 'Ben', lastName: 'Phiri', email: 'ben@example.com' }, PDF)
    check(ok2.status === 201, 'an application with a PDF CV is received')
    const c2 = await db.collection('candidates').findOne({ tenantId, email: 'ben@example.com' })
    check(c2.resumeUrl?.startsWith('file:recruitment/') && c2.resumeUrl.includes(c2._id) && c2.resumeUrl.endsWith('.pdf|ann cv.pdf'), 'the CV is stored privately under the candidate (a key, never a public link)')
    const cv = await call('GET', `/recruitment/candidates/${c2._id}/cv`, owner)
    check(cv.status === 200 && cv.data.url && cv.data.expiresInSeconds === 300, 'HR gets a short-lived signed link to it')
    check((await call('GET', `/recruitment/candidates/${c2._id}/cv`, pw)).status >= 400, 'an employee does not')
    check(!JSON.stringify(ok2.body).includes('recruitment/'), 'the public answer never mentions the stored file')

    // ── the same person again
    const again = await apply(slug, cook, { firstName: 'Ann', lastName: 'Lee', email: 'ANN.LEE@example.com', message: 'second go' })
    check(again.status === 201 && JSON.stringify(again.body) === JSON.stringify(ok1.body), 'applying again gets the identical success answer (nothing reveals it was a repeat)')
    check((await db.collection('candidates').countDocuments({ tenantId, email: 'ann.lee@example.com' })) === 1, 'but there is still only one candidate')
    const hist2 = await call('GET', `/recruitment/candidates/${c1._id}/history`, owner)
    check(hist2.data.some((h) => h.action === 'CANDIDATE_APPLIED_AGAIN'), "HR sees 'applied again' on the existing candidate's history")

    // ── limits (counted per real attempt)
    await resetLimits()
    for (let i = 1; i <= 3; i++) check((await apply(slug, cook, { firstName: 'Zed', lastName: 'Zulu', email: 'zed@example.com' })).status === 201, `the same email applies ${i} of 3 times a day`)
    const mailLimit = await apply(slug, cook, { firstName: 'Zed', lastName: 'Zulu', email: 'zed@example.com' })
    check(mailLimit.status === 429 && mailLimit.code === 'RATE_LIMITED' && /email address/.test(mailLimit.body.message), 'a fourth try from the same email is 429, saying why')
    await resetLimits()
    for (let i = 1; i <= 5; i++) check((await apply(slug, cook, { firstName: 'P' + i, lastName: 'Person', email: `p${i}@example.com` })).status === 201, `connection application ${i} of 5 an hour`)
    const ipLimit = await apply(slug, cook, { firstName: 'P6', lastName: 'Person', email: 'p6@example.com' })
    check(ipLimit.status === 429 && /connection/.test(ipLimit.body.message), 'a sixth from the same connection is 429, saying why')
    await resetLimits()
    await redis.set(`careers:co:${tenantId}`, '60', 'EX', 60)
    const coLimit = await apply(slug, cook, { firstName: 'Q', lastName: 'Person', email: 'q@example.com' })
    check(coLimit.status === 429 && /lot of applications/.test(coLimit.body.message), 'a company already at its hourly cap answers 429')
    await resetLimits()

    // ── hiding at once, and closing
    check((await call('PATCH', `/recruitment/openings/${cook}`, owner, { status: 'on_hold' })).status === 200, 'HR puts the cook opening on hold')
    check((await pub(`/${slug}/openings/${cook}`)).status === 404 && (await pub(`/${slug}`)).data.openings.length === 0, 'it disappears from the public page at once')
    check((await apply(slug, cook, { email: 'late@example.com' })).status === 404, 'and nobody can apply to it any more')
    const empty = await pub(`/${slug}`)
    check(empty.status === 200 && empty.data.company.contactEmail === 'jobs@example.com', 'the page itself stays up, with the contact email for the empty state')
    check((await call('PATCH', `/recruitment/openings/${cook}`, owner, { status: 'open' })).status === 200 && (await pub(`/${slug}/openings/${cook}`)).status === 200, 'reopened, it is back (still switched on)')
    await call('PUT', '/recruitment/careers/settings', owner, { enabled: false, headline: '', intro: '', applyNote: '', contactEmail: '', showSalary: false })
    check((await pub(`/${slug}`)).status === 404, 'switching the page off makes everything 404 again')

    // ── the template HR can edit
    const tpl = await call('GET', '/recruitment/templates', owner)
    const t = tpl.data.templates.find((x) => x.key === 'application_received')
    check(t && /\{role\}/.test(t.subject) && /\{company\}/.test(t.body) && /\{candidate\}/.test(t.body), "the 'application received' email is in HR's templates with its placeholders")
    check((await call('PUT', '/recruitment/templates/application_received', owner, { subject: 'Got it: {role}', body: 'Dear {candidate}, we have your application for {role}. {company}' })).status === 200, 'HR can edit it')
    await call('DELETE', '/recruitment/templates/application_received', owner)
    console.log(`${passed} passed, ${failed} failed`)
  } finally {
    await resetLimits().catch(() => undefined)
    for (const tenantId of tenants) {
      const emps = await db.collection('employees').find({ tenantId }).project({ _id: 1 }).toArray()
      const users = await db.collection('users').find({ tenantId }).project({ _id: 1 }).toArray()
      await db.collection('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } })
      await db.collection('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of await db.listCollections().toArray()) if (!['statutory_tables', 'salary_rule_categories', 'tenants'].includes(c.name)) await db.collection(c.name).deleteMany({ tenantId })
      await db.collection('careers_settings').deleteMany({ _id: tenantId })
      await db.collection('tenants').deleteOne({ _id: tenantId })
    }
    redis.disconnect()
    await mongoose.disconnect()
  }
})().catch((e) => { console.error(e); process.exit(1) })

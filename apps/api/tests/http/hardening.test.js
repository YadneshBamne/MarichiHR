// Prompt 22 verification: event worker + cron, notifications, nightly absent marking, chatter tenantId,
// leave-type configuration, TOTP MFA, Google SSO wiring. Needs the API running with jobs enabled (the default).
// Creates throwaway employees each run and archives them at the end.
const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const { api, tokenFor, check, done, prisma } = require('./lib')
require('ts-node').register({ transpileOnly: true })

const TAG = `p22-${Date.now()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 30000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await sleep(750)
  }
}
const ymd = (d) => new Date(d).toISOString().slice(0, 10)
const addDays = (s, n) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000))
const lusakaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lusaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

// Independent RFC 6238 implementation (cross-checks the API's own)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function b32decode(s) {
  let bits = 0, val = 0
  const out = []
  for (const c of s) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8 } }
  return Buffer.from(out)
}
function totp(secret, step) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(step))
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest()
  const o = h[h.length - 1] & 15
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0')
}
const stepNow = () => Math.floor(Date.now() / 30000)

;(async () => {
  const admin = await tokenFor('admin@marichihr.com')
  const john = await tokenFor('john.banda@marichihr.com')
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const tenantId = admin.tenantId
  const johnEmp = await prisma.employee.findUnique({ where: { id: john.employeeId } })
  const temps = []
  const mk = async (first, extra = {}) => {
    const r = await api(admin, 'POST', '/employees', {
      firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@marichihr.com`, orgUnitId: johnEmp.orgUnitId,
      managerId: john.employeeId, hireDate: '2026-01-01', employmentType: 'full_time', ...extra,
    })
    if (r.status !== 201) throw new Error(`create ${first}: ${JSON.stringify(r.data)}`)
    temps.push(r.body.employee.id)
    return { emp: r.body.employee, who: await tokenFor(`${first.toLowerCase()}.${TAG}@marichihr.com`) }
  }
  const notesFor = async (userId, where = {}) => prisma.notification.findMany({ where: { userId, ...where }, orderBy: { createdAt: 'desc' } })

  // ─── 1. WORKER + CRON ──────────────────────────────────────
  let r = await api(admin, 'GET', '/system/jobs')
  const jobs = r.body || []
  const expectJobs = ['events-sweep', 'leave-sla-escalation', 'absent-marking', 'contracts', 'leave-accrual']
  check('5 cron jobs registered with BullMQ, each with a next run time', r.status === 200 && expectJobs.every((n) => jobs.find((j) => j.name === n && j.scheduled && j.nextRunAt)), r.data)
  r = await api(john, 'GET', '/system/jobs')
  check('manager cannot list or run jobs (403)', r.status === 403, r.data)
  r = await api(admin, 'POST', '/system/jobs/nope/run')
  check('unknown job is 404', r.status === 404, r.data)

  const annual = (await api(admin, 'GET', '/leave/types')).body.find((t) => t.code === 'ANNUAL')
  const worker = await mk('Worker')
  await api(admin, 'POST', '/leave/allocations/manual', { employeeId: worker.emp.id, leaveTypeId: annual.id, daysAllocated: 5, validFrom: '2026-01-01', reason: TAG })
  r = await api(worker.who, 'POST', '/leave/requests', { leaveTypeId: annual.id, startDate: '2027-03-02', endDate: '2027-03-02', reason: TAG })
  const lr = r.body
  check('setup: worker applies for 2027-03-02', r.status === 201, r.data)
  const submitted = await prisma.domainEvent.findFirst({ where: { eventType: 'leave.request.submitted', payload: { path: ['leaveRequestId'], equals: lr?.id } } })
  const delivered = await until(async () => (await prisma.domainEvent.findUnique({ where: { id: submitted.id } })).status === 'delivered')
  check('worker consumes the domain event: status delivered, deliveredAt set', delivered, submitted)
  const johnNote = await until(async () => (await notesFor(john.userId, { eventId: submitted.id }))[0])
  check('manager gets an in-app "awaiting approval" notification linked to the request', johnNote && johnNote.type === 'leave.approval.requested' && johnNote.entityId === lr.id && johnNote.link === '/approvals', johnNote)
  check('email delivery recorded through the log transport', johnNote && johnNote.deliveries.some((d) => d.channel === 'email' && d.transport === 'log' && d.status === 'sent'), johnNote?.deliveries)

  // A retried event must not notify twice: mark it failed and let the sweep re-dispatch it
  await prisma.domainEvent.update({ where: { id: submitted.id }, data: { status: 'failed' } })
  r = await api(admin, 'POST', '/system/jobs/events-sweep/run')
  check('events-sweep re-enqueues failed events', r.status === 200 && r.body >= 1, r.data)
  await until(async () => (await prisma.domainEvent.findUnique({ where: { id: submitted.id } })).status === 'delivered')
  await sleep(1500)
  check('re-dispatched event does not duplicate the notification', (await notesFor(john.userId, { eventId: submitted.id })).length === 1)

  // SLA escalation: push the pending approval past its deadline
  await prisma.leaveApproval.updateMany({ where: { leaveRequestId: lr.id, action: 'pending' }, data: { deadlineAt: new Date(Date.now() - 3600_000) } })
  r = await api(admin, 'POST', '/system/jobs/leave-sla-escalation/run')
  check('SLA job escalates the overdue approval', r.status === 200 && r.body[tenantId] >= 1, r.data)
  const appr = await prisma.leaveApproval.findFirst({ where: { leaveRequestId: lr.id, action: 'pending' } })
  check('approval stamped escalatedAt', !!appr.escalatedAt, appr)
  const escNote = await until(async () => (await notesFor(admin.userId, { type: 'leave.approval.escalated', entityId: lr.id }))[0])
  check('HR admin notified of the overdue approval', !!escNote, escNote)
  r = await api(admin, 'POST', '/system/jobs/leave-sla-escalation/run')
  await sleep(1500)
  check('SLA job is idempotent: no second escalation', (await notesFor(admin.userId, { type: 'leave.approval.escalated', entityId: lr.id })).length === 1, r.data)

  r = await api(john, 'POST', `/leave/requests/${lr.id}/approve`, { comments: TAG })
  check('manager approves', r.status === 200, r.data)
  const appNote = await until(async () => (await notesFor(worker.who.userId, { type: 'leave.request.approved', entityId: undefined }))[0])
  check('employee notified of the approval', !!appNote, appNote)
  r = await api(worker.who, 'POST', `/leave/requests/${lr.id}/cancel`)

  // Accrual: one credit per employee, leave type and month
  await api(admin, 'POST', '/system/jobs/leave-accrual/run')
  const accrualsA = await prisma.leaveAllocation.count({ where: { employeeId: worker.emp.id, allocationType: 'accrual' } })
  r = await api(admin, 'POST', '/system/jobs/leave-accrual/run')
  const accrualsB = await prisma.leaveAllocation.count({ where: { employeeId: worker.emp.id, allocationType: 'accrual' } })
  check('leave accrual credits a new employee once for this month', accrualsA === 1, accrualsA)
  check('second accrual run in the same month credits nothing', r.status === 200 && r.body[tenantId] === 0 && accrualsB === 1, r.data)

  // Contracts: a running contract whose last day was yesterday is expired by the job; HR is notified
  const zm = (await api(admin, 'GET', '/salary/structures')).body.find((s) => s.countryCode === 'ZM')
  r = await api(admin, 'POST', '/leave/contracts', { employeeId: worker.emp.id, ctcAnnual: 120000, wageMonthly: 10000, currency: 'ZMW', effectiveFrom: '2026-01-01', salaryStructureId: zm.id })
  const contract = r.body
  for (const step of ['draft', 'confirm', 'activate']) await api(admin, 'POST', `/leave/contracts/${contract.id}/${step}`, {})
  const today = lusakaToday()
  await prisma.employeeContract.update({ where: { id: contract.id }, data: { effectiveUntil: new Date(`${today}T00:00:00Z`) } })
  r = await api(admin, 'POST', '/system/jobs/contracts/run')
  check('contract ending today is still running after the job', (await prisma.employeeContract.findUnique({ where: { id: contract.id } })).status === 'running', r.data)
  await prisma.employeeContract.update({ where: { id: contract.id }, data: { effectiveUntil: new Date(`${addDays(today, -1)}T00:00:00Z`) } })
  r = await api(admin, 'POST', '/system/jobs/contracts/run')
  check('contract that ended yesterday is expired by the job', r.status === 200 && r.body.expired >= 1 && (await prisma.employeeContract.findUnique({ where: { id: contract.id } })).status === 'expired', r.data)
  const expNote = await until(async () => (await notesFor(admin.userId, { type: 'contract.expired' })).find((n) => n.link === `/employees/${worker.emp.id}`))
  check('HR notified of the expired contract', !!expNote)

  // ─── 2. NOTIFICATIONS API ──────────────────────────────────
  r = await api(worker.who, 'GET', '/notifications')
  const mine = r.body
  check('GET /notifications lists my notifications with an unread count', r.status === 200 && mine.items.length >= 1 && mine.unread >= 1, r.data)
  check('notification payload never exposes delivery internals', mine.items.every((n) => n.deliveries === undefined && n.userId === undefined), mine.items[0])
  r = await api(jane, 'POST', `/notifications/${mine.items[0].id}/read`)
  check("someone else's notification is 404", r.status === 404, r.data)
  r = await api(worker.who, 'POST', `/notifications/${mine.items[0].id}/read`)
  check('mark one read', r.status === 200 && r.body.readAt, r.data)
  r = await api(worker.who, 'POST', '/notifications/read-all')
  check('read-all clears the unread count', r.status === 200 && (await api(worker.who, 'GET', '/notifications?unread=true')).body.unread === 0, r.data)

  const { whatsappTransport } = require('../../src/infrastructure/notifications/notify')
  let waErr = ''
  await whatsappTransport.send({ to: { name: 'x', phone: '+260000000000' }, subject: 's', text: 't' }).catch((e) => (waErr = e.message))
  check('WhatsApp adapter refuses to send without WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID', /not configured/.test(waErr), waErr)

  // ─── 3. NIGHTLY ABSENT MARKING ─────────────────────────────
  const absentee = await mk('Absentee', { hireDate: addDays(today, -10) })
  await prisma.employee.update({ where: { id: absentee.emp.id }, data: { taxJurisdiction: 'XT' } })
  const present = await mk('Present', { hireDate: addDays(today, -10) })

  // (a) The scheduled run over the real last 3 days: days inside a payroll cycle whose attendance is locked are never touched
  r = await api(admin, 'POST', '/system/jobs/absent-marking/run')
  check('absent-marking job runs for the tenant', r.status === 200 && typeof r.body[tenantId] === 'number', r.data)
  const recent = [3, 2, 1].map((n) => addDays(today, -n)).filter((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))
  const lockedCycles = await prisma.payrollCycle.findMany({ where: { tenantId, attendanceLockedAt: { not: null } } })
  const isLocked = (d) => lockedCycles.some((c) => ymd(c.payPeriodStart) <= d && d <= ymd(c.payPeriodEnd))
  const realRows = (await prisma.attendanceRecord.findMany({ where: { employeeId: absentee.emp.id }, orderBy: { date: 'asc' } })).map((x) => ymd(x.date))
  const realExpected = recent.filter((d) => !isLocked(d))
  check(`real run marks exactly the unlocked working days (${realExpected.join(', ') || 'none: those days are in a locked payroll cycle'})`, JSON.stringify(realRows) === JSON.stringify(realExpected), realRows)
  await prisma.attendanceRecord.deleteMany({ where: { employeeId: absentee.emp.id, source: 'system' } })

  // (b) The marking rules on a fixed future window (Mon 2030-03-04 .. Wed 2030-03-06), for the test employees only
  const { attendanceService } = require('../../src/modules/attendance/attendance.service')
  const lateHire = await mk('Latehire', { hireDate: '2030-03-06' })
  check('no locked payroll cycle covers the March 2030 test window', !(await prisma.payrollCycle.findFirst({ where: { tenantId, attendanceLockedAt: { not: null }, payPeriodStart: { lte: new Date('2030-03-19') }, payPeriodEnd: { gte: new Date('2030-03-04') } } })))
  const ids = [absentee.emp.id, present.emp.id, lateHire.emp.id]
  const cal = await prisma.holidayCalendar.create({ data: { tenantId, name: `Test ${TAG}`, countryCode: 'XT', year: 2030 } })
  await prisma.holiday.create({ data: { calendarId: cal.id, name: 'Test holiday', date: new Date('2030-03-04T00:00:00Z') } })
  await prisma.attendanceRecord.createMany({ data: ['2030-03-04', '2030-03-05', '2030-03-06'].map((d) => ({ employeeId: present.emp.id, date: new Date(`${d}T00:00:00Z`), status: 'present', source: 'hr_override' })) })
  let res = await attendanceService.markAbsences(tenantId, { asOf: '2030-03-07', employeeIds: ids })
  const absRows = await prisma.attendanceRecord.findMany({ where: { employeeId: absentee.emp.id }, orderBy: { date: 'asc' } })
  check('working days without attendance are marked absent, source system (03-05, 03-06)', JSON.stringify(absRows.map((x) => ymd(x.date))) === '["2030-03-05","2030-03-06"]' && absRows.every((x) => x.status === 'absent' && x.source === 'system'), absRows.map((x) => [ymd(x.date), x.status, x.source]))
  check("the employee's public holiday (03-04, country XT) is skipped", !absRows.some((x) => ymd(x.date) === '2030-03-04'))
  check('days with attendance are left alone', (await prisma.attendanceRecord.findMany({ where: { employeeId: present.emp.id } })).every((x) => x.status === 'present' && x.source === 'hr_override'))
  const lateRows = (await prisma.attendanceRecord.findMany({ where: { employeeId: lateHire.emp.id } })).map((x) => ymd(x.date))
  check('days before the hire date are not marked (late hire: only 03-06)', JSON.stringify(lateRows) === '["2030-03-06"]', lateRows)
  check('run reports 3 records marked', res.marked === 3, res)
  res = await attendanceService.markAbsences(tenantId, { asOf: '2030-03-07', employeeIds: ids })
  check('second run marks nothing new', res.marked === 0, res)
  res = await attendanceService.markAbsences(tenantId, { asOf: '2030-03-19', employeeIds: [absentee.emp.id] })
  check('weekend (03-16, 03-17) skipped; Monday 03-18 marked', JSON.stringify(res.records.map((x) => x.date)) === '["2030-03-18"]', res)
  const absNote = await until(async () => (await notesFor(absentee.who.userId, { type: 'attendance.absent.marked' }))[0])
  check('employee notified that they were marked absent (via the event worker)', !!absNote, absNote)

  // Approved leave for a marked day removes the system absence (leave.request.approved consumer); it is not re-marked
  const lwp = (await api(admin, 'GET', '/leave/types')).body.find((t) => t.code === 'LWP')
  r = await api(absentee.who, 'POST', '/leave/requests', { leaveTypeId: lwp.id, startDate: '2030-03-06', endDate: '2030-03-06', reason: TAG })
  r = await api(john, 'POST', `/leave/requests/${r.body?.id}/approve`, { comments: TAG })
  check('leave for a marked day is approved', r.status === 200, r.data)
  const day10 = { employeeId: absentee.emp.id, date: new Date('2030-03-06T00:00:00Z') }
  check('approved leave removes the system absence for that day', await until(async () => !(await prisma.attendanceRecord.findFirst({ where: day10 }))))
  await attendanceService.markAbsences(tenantId, { asOf: '2030-03-07', employeeIds: ids })
  check('a day covered by approved leave is not re-marked', !(await prisma.attendanceRecord.findFirst({ where: day10 })))
  await prisma.holiday.deleteMany({ where: { calendarId: cal.id } })
  await prisma.holidayCalendar.delete({ where: { id: cal.id } })

  // ─── 5. CHATTER tenantId ───────────────────────────────────
  check('every chatter row has a tenantId after the backfill', (await prisma.$queryRawUnsafe(`select count(*)::int as n from chatter_messages where "tenantId" is null`))[0].n === 0)
  r = await api(admin, 'POST', '/activities/chatter', { entityType: 'employee', entityId: jane.employeeId, body: `Note ${TAG}` })
  const posted = await prisma.chatterMessage.findFirst({ where: { body: `Note ${TAG}` } })
  check('posted chatter stores the author tenant', r.status === 201 && posted?.tenantId === tenantId, r.data)
  const sys = await prisma.chatterMessage.findFirst({ where: { entityType: 'leave_request', entityId: lr.id, messageType: 'system_log' } })
  check('system chatter from events stores the tenant', sys?.tenantId === tenantId, sys)
  let other = await prisma.tenant.findUnique({ where: { slug: 'p22-isolation' } })
  if (!other) other = await prisma.tenant.create({ data: { name: 'P22 isolation (inactive test tenant)', slug: 'p22-isolation', countryCodes: [], fiscalYearStart: new Date('2026-01-01'), active: false } })
  await prisma.chatterMessage.create({ data: { tenantId: other.id, entityType: 'employee', entityId: jane.employeeId, body: `Foreign ${TAG}`, messageType: 'comment' } })
  r = await api(admin, 'GET', `/activities/chatter/employee/${jane.employeeId}`)
  check("chatter list never shows another tenant's rows on the same entity id", r.status === 200 && r.body.some((m) => m.body === `Note ${TAG}`) && !r.body.some((m) => m.body === `Foreign ${TAG}`), r.body?.length)

  // ─── 6. LEAVE-TYPE CONFIGURATION ───────────────────────────
  const code = `T${Date.now() % 1e8}`
  const base = { name: `Study ${TAG}`, code, category: 'other', isPaid: true, accrualType: 'annual_lumpsum', accrualAmount: 4, approvalLevels: 1 }
  r = await api(admin, 'POST', '/leave/types', base)
  const lt = r.body
  check('HR creates a leave type', r.status === 201 && lt.code === code && lt.accrualAmount === 4 && lt.tenantId === tenantId, r.data)
  r = await api(admin, 'POST', '/leave/types', base)
  check('duplicate code is 409', r.status === 409, r.data)
  r = await api(admin, 'POST', '/leave/types', { ...base, code: `${code}X`, tenantId: 'x' })
  check('strict body: unknown field rejected 400', r.status === 400, r.data)
  r = await api(admin, 'POST', '/leave/types', { ...base, code: 'bad code' })
  check('invalid code format rejected 400', r.status === 400, r.data)
  r = await api(admin, 'POST', '/leave/types', { ...base, code: `${code}Y`, accrualType: 'monthly_prorate', accrualAmount: 0 })
  check('accruing type without an amount rejected 400', r.status === 400, r.data)
  r = await api(john, 'POST', '/leave/types', { ...base, code: `${code}Z` })
  check('manager cannot configure leave types (403)', r.status === 403, r.data)
  r = await api(admin, 'PATCH', `/leave/types/${lt.id}`, { name: `Study leave ${TAG}`, halfDayAllowed: false, attachmentRequiredAfterDays: 2 })
  check('HR updates a leave type', r.status === 200 && r.body.halfDayAllowed === false && r.body.attachmentRequiredAfterDays === 2, r.data)
  r = await api(admin, 'PATCH', `/leave/types/${lt.id}`, { code: 'NEWCODE' })
  check('code is immutable (400)', r.status === 400, r.data)
  r = await api(admin, 'PATCH', `/leave/types/${lt.id}`, { accrualType: 'monthly_prorate', accrualAmount: null })
  check('update that leaves an accruing type without an amount is 400', r.status === 400, r.data)
  r = await api(admin, 'PATCH', `/leave/types/${crypto.randomUUID()}`, { name: 'x' })
  check('unknown or other-tenant id is 404', r.status === 404, r.data)
  r = await api(admin, 'PATCH', `/leave/types/${lt.id}`, { active: false })
  check('archive (active=false) sets archivedAt', r.status === 200 && r.body.active === false && r.body.archivedAt, r.data)
  check('archived type hidden from employees, kept in the HR list', !(await api(jane, 'GET', '/leave/types')).body.some((t) => t.id === lt.id) && (await api(admin, 'GET', '/leave/types/all')).body.some((t) => t.id === lt.id))
  r = await api(jane, 'POST', '/leave/requests', { leaveTypeId: lt.id, startDate: '2027-03-03', endDate: '2027-03-03' })
  check('cannot apply for an archived type (404)', r.status === 404, r.data)
  r = await api(jane, 'GET', '/leave/types/all')
  check('employee cannot read the HR list (403)', r.status === 403, r.data)
  check('leave-type changes are audit-logged', (await prisma.auditLog.count({ where: { entityType: 'leave_type', entityId: lt.id } })) === 3)

  // ─── 7. MFA (TOTP) + GOOGLE SSO ────────────────────────────
  const mfa = await mk('Mfa')
  const password = crypto.randomBytes(9).toString('base64url')
  await prisma.user.update({ where: { id: mfa.who.userId }, data: { passwordHash: await bcrypt.hash(password, 10) } })
  const email = `mfa.${TAG}@marichihr.com`
  r = await api(mfa.who, 'POST', '/auth/mfa/setup')
  const secret = r.body?.secret
  check('MFA setup returns a base32 secret and an otpauth:// URI', r.status === 200 && /^[A-Z2-7]{32}$/.test(secret) && r.body.otpauthUrl.startsWith('otpauth://totp/') && r.body.otpauthUrl.includes(secret), r.data)
  const stored = await prisma.user.findUnique({ where: { id: mfa.who.userId } })
  check('secret is stored AES-GCM encrypted, not in clear', stored.mfaSecret.startsWith('v1:') && !stored.mfaSecret.includes(secret) && !stored.mfaEnabled)
  r = await api(mfa.who, 'POST', '/auth/mfa/enable', { code: totp(secret, stepNow()) === '000000' ? '111111' : '000000' })
  check('enable with a wrong code is 401', r.status === 401, r.data)
  const s0 = stepNow()
  r = await api(mfa.who, 'POST', '/auth/mfa/enable', { code: totp(secret, s0) })
  check('enable with the current code', r.status === 200 && r.body.mfaEnabled === true, r.data)
  r = await api(null, 'POST', '/auth/login', { email, password, tenantSlug: 'marichi-labs' })
  const mfaToken = r.body?.mfaToken
  check('password login now stops at the MFA step (no tokens)', r.status === 200 && r.body.mfaRequired === true && mfaToken && !r.body.accessToken, r.data)
  r = await api(mfaToken, 'GET', '/auth/me')
  check('the MFA step token is not an access token (401)', r.status === 401, r.data)
  r = await api(null, 'POST', '/auth/mfa/verify', { mfaToken, code: totp(secret, s0) })
  check('replaying the code already used is refused (401)', r.status === 401, r.data)
  r = await api(null, 'POST', '/auth/mfa/verify', { mfaToken, code: totp(secret, s0 + 1) })
  check('a fresh code completes sign-in with tokens', r.status === 200 && r.body.accessToken && r.body.refreshToken && r.body.user.email === email, r.data)
  r = await api(r.body?.accessToken, 'GET', '/auth/me')
  check('/auth/me shows mfaEnabled and never the secret', r.status === 200 && r.body.mfaEnabled === true && !JSON.stringify(r.data).includes(stored.mfaSecret) && !JSON.stringify(r.data).includes(secret), r.data)
  r = await api(null, 'POST', '/auth/mfa/verify', { mfaToken: 'x.y.z', code: '123456' })
  check('forged MFA token is 401', r.status === 401, r.data)
  await until(async () => stepNow() >= s0 + 1, 35000)
  r = await api(mfa.who, 'POST', '/auth/mfa/disable', { code: totp(secret, s0 + 2) })
  check('disable needs a fresh code and clears the secret', r.status === 200 && r.body.mfaEnabled === false && !(await prisma.user.findUnique({ where: { id: mfa.who.userId } })).mfaSecret, r.data)
  r = await api(null, 'POST', '/auth/login', { email, password, tenantSlug: 'marichi-labs' })
  check('login returns tokens directly again', r.status === 200 && r.body.accessToken, r.data)
  check('MFA enable/disable audit-logged', (await prisma.auditLog.count({ where: { entityId: mfa.who.userId, action: { in: ['MFA_ENABLED', 'MFA_DISABLED'] } } })) === 2)
  r = await api(mfa.who, 'POST', '/auth/mfa/setup')
  const secret2 = r.body.secret
  const codes = []
  for (let i = 0; i < 5; i++) codes.push((await api(mfa.who, 'POST', '/auth/mfa/enable', { code: String(100000 + i) === totp(secret2, stepNow()) ? '999999' : String(100000 + i) })).status)
  r = await api(mfa.who, 'POST', '/auth/mfa/enable', { code: totp(secret2, stepNow()) })
  check('5 wrong codes lock MFA attempts (6th, even correct, is 429)', codes.every((c) => c === 401) && r.status === 429, { codes, last: r.status })

  r = await api(null, 'GET', '/auth/providers')
  const googleOn = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET
  check(`providers endpoint reports Google as ${googleOn ? '' : 'not '}configured, matching the env`, r.status === 200 && r.body.google === googleOn, r.data)
  if (googleOn) {
    const st = await fetch((process.env.API_URL || 'http://localhost:4000') + '/api/v1/auth/google?tenant=marichi-labs', { redirect: 'manual' })
    const loc = new URL(st.headers.get('location') || 'http://x')
    check('Google start redirects to Google with our client id, callback and a signed state, and sets the nonce cookie',
      st.status === 302 && loc.host === 'accounts.google.com' && loc.searchParams.get('client_id') === process.env.GOOGLE_CLIENT_ID &&
      loc.searchParams.get('redirect_uri') === process.env.GOOGLE_CALLBACK_URL && (loc.searchParams.get('state') || '').split('.').length === 3 &&
      /g_oauth_nonce=[0-9a-f]{32}/.test(st.headers.get('set-cookie') || ''), { status: st.status, location: loc.href.slice(0, 120) })
    r = await api(null, 'GET', '/auth/google?tenant=no-such-org')
    check('Google start for an unknown organisation is 404', r.status === 404, r.data)
  } else {
    r = await api(null, 'GET', '/auth/google?tenant=marichi-labs')
    check('Google start is 501 until GOOGLE_CLIENT_ID/SECRET are set', r.status === 501, r.data)
  }
  const cb = await fetch((process.env.API_URL || 'http://localhost:4000') + '/api/v1/auth/google/callback?code=x&state=y', { redirect: 'manual' })
  check('Google callback redirects to the login page with an error, never 500', cb.status === 302 && /\/login\?sso_error=/.test(cb.headers.get('location')), cb.status)
  r = await api(null, 'POST', '/auth/google/exchange', { code: 'a'.repeat(48) })
  check('SSO exchange with an unknown one-time code is 401', r.status === 401, r.data)

  // ─── PRODUCT TOUR ─────────────────────────────────────────
  r = await api(mfa.who, 'GET', '/auth/me')
  check('new user has not seen the tour (tourDoneAt null)', r.status === 200 && r.body.tourDoneAt === null, r.data)
  r = await api(mfa.who, 'POST', '/auth/me/tour', { status: 'done' })
  check('finishing the tour stamps tourDoneAt', r.status === 200 && !!r.body.tourDoneAt && !!(await prisma.user.findUnique({ where: { id: mfa.who.userId } })).tourDoneAt, r.data)
  r = await api(mfa.who, 'POST', '/auth/me/tour', { status: 'reset' })
  check('reset clears it so the tour shows again', r.status === 200 && r.body.tourDoneAt === null, r.data)
  r = await api(mfa.who, 'POST', '/auth/me/tour', { status: 'done', userId: admin.userId })
  check('tour body is strict (no other user ids)', r.status === 400, r.data)
  r = await api(null, 'POST', '/auth/login', { email, password, tenantSlug: 'marichi-labs' })
  check('login payload carries tourDoneAt and mfaEnabled for the client', r.status === 200 && 'tourDoneAt' in r.body.user && r.body.user.mfaEnabled === false, r.data)

  // ─── CLEANUP: archive throwaway employees (no more nightly marks for them) ──
  for (const id of temps) await api(admin, 'POST', `/employees/${id}/archive`, { reason: `Test cleanup ${TAG}` })
  check('throwaway employees archived', (await prisma.employee.count({ where: { id: { in: temps }, active: true } })) === 0)
  await done()
})().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})

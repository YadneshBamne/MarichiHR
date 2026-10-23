// Attendance: shifts and rosters, QR check-in, device punches, heatmap, absence flags, changes after lock, holiday templates.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `ag${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BASE = (process.env.API_URL || 'http://localhost:4000') + '/api/v1'

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `AttG ${TAG}`, fullName: 'Ada Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken } // hr_admin + system_admin
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { modules: { set: [...new Set([...(tenant.modules ?? []), 'attendance'])] } } })
  const as = (emp, roleIds) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first) => { const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2024-01-08', employmentType: 'full_time' }); return prisma.employee.findUnique({ where: { id: (x.body.employee ?? x.body).id } }) }
  const ann = await add('Ann'), ben = await add('Ben')
  const asAnn = as(ann, ['employee'])

  // ─── Shifts and rosters ───────────────────────────────────
  r = await api(asAnn, 'POST', '/attendance/shifts', { name: 'Early', shiftType: 'fixed', startTime: '06:00', endTime: '14:00' })
  check('only HR sets up shifts (403)', r.status === 403, r.status)
  const early = (await api(owner, 'POST', '/attendance/shifts', { name: 'Early', shiftType: 'fixed', startTime: '06:00', endTime: '14:00' })).body
  r = await api(owner, 'POST', '/attendance/shifts', { name: 'Split', shiftType: 'split', startTime: '08:00', endTime: '12:00' })
  check('a split shift needs its second part (400)', r.status === 400, r.data)
  const split = (await api(owner, 'POST', '/attendance/shifts', { name: 'Split', shiftType: 'split', startTime: '08:00', endTime: '12:00', splitStartTime: '16:00', splitEndTime: '20:00' })).body
  check('HR creates fixed and split shifts', !!early?.id && split?.splitEndTime === '20:00', split)
  const from = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
  const to = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  r = await api(owner, 'POST', '/attendance/roster', { employeeIds: [ann.id, ben.id], from, to, pattern: [early.id, split.id, null] })
  check('HR rosters two people over 6 days with a rotating pattern', r.status === 200 && r.body.days === 12, r.data)
  r = await api(asAnn, 'GET', `/attendance/roster?from=${from}&to=${to}`)
  check('Ann sees her own roster: early, split, day off, repeating', r.status === 200 && r.body.length === 6 && r.body[0].shift.name === 'Early' && r.body[1].shift.endTime === '20:00' && r.body[2].off === true && r.body.every((x) => x.employeeId === ann.id), r.body?.slice(0, 3))

  // ─── QR check-in ──────────────────────────────────────────
  const loc = await prisma.workLocation.create({ data: { tenantId: tenant.id, name: `HQ ${TAG}` } })
  r = await api(owner, 'GET', `/attendance/locations/${loc.id}/qr`)
  const token = r.body?.token
  check('HR gets the office QR code', r.status === 200 && token?.length > 10, r.data)
  r = await api(asAnn, 'POST', '/attendance/clock-in', { qrToken: 'wrong-token-value' })
  check('a wrong QR code is refused (404)', r.status === 404, r.status)
  r = await api(asAnn, 'POST', '/attendance/clock-in', { qrToken: token })
  check('scanning the office QR clocks Ann in at that office', r.status === 200 || r.status === 201, r.data)
  const qrRec = await prisma.attendanceRecord.findFirst({ where: { employeeId: ann.id }, orderBy: { date: 'desc' } })
  check('…recorded as a QR check-in at HQ', qrRec?.checkInMethod === 'qr' && qrRec.checkInLocationId === loc.id, qrRec)

  // ─── Device punches ───────────────────────────────────────
  r = await api(owner, 'POST', '/automation/api-keys', { name: `Turnstile ${TAG}`, scopes: ['attendance:write'] })
  const key = r.body?.key
  check('HR creates a device key with the attendance:write scope', r.status === 201 && !!key, r.data)
  const punchAt = (h) => new Date(Date.UTC(2026, 9, 6, h, 0, 0)).toISOString() // 6 Oct 2026, a Tuesday
  const res = await fetch(`${BASE}/integration/punches`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ punches: [{ employeeId: ben.employeeCode, at: punchAt(7), type: 'in' }, { employeeId: ben.employeeCode, at: punchAt(15), type: 'out' }, { employeeId: 'NOBODY', at: punchAt(7), type: 'in' }] }) })
  const body = await res.json()
  check('a device sends punches: 2 accepted, the unknown person skipped', res.status === 200 && body.accepted === 2 && body.skipped.length === 1, body)
  const benRec = await prisma.attendanceRecord.findFirst({ where: { employeeId: ben.id, date: new Date('2026-10-06T00:00:00Z') } })
  check('…Ben has an 8-hour day from the device', benRec?.checkInMethod === 'biometric' && benRec.workedHours === 8, benRec)

  // ─── Heatmap ──────────────────────────────────────────────
  r = await api(owner, 'GET', '/attendance/heatmap?month=2026-10')
  check('HR sees the attendance heatmap by department and day', r.status === 200 && r.body.days.length === 31 && r.body.departments.length >= 1, r.body?.departments?.length)
  r = await api(asAnn, 'GET', '/attendance/heatmap?month=2026-10')
  check('employees cannot (403)', r.status === 403, r.status)

  // ─── Unapproved absences ──────────────────────────────────
  const pol = (await api(owner, 'POST', '/attendance/policies', { name: `Strict ${TAG}`, isDefault: true, lwpFlagAfterAbsences: 2 })).body
  check('HR sets "flag after 2 unapproved absences" on the policy', !!pol?.id && pol.lwpFlagAfterAbsences === 2, pol)
  const today = new Date(); const d1 = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)); const d2 = new Date(d1.getTime() + 86_400_000)
  for (const d of [d1, d2]) await prisma.attendanceRecord.upsert({ where: { employeeId_date: { employeeId: ben.id, date: d } }, create: { employeeId: ben.id, date: d, status: 'absent' }, update: { status: 'absent' } })
  await api(owner, 'POST', '/system/jobs/absence-flags/run')
  let flag = null
  for (let i = 0; i < 30 && !flag; i++) { flag = await prisma.notification.findFirst({ where: { tenantId: tenant.id, type: 'attendance.absence_flag', entityId: ben.id } }); if (!flag) await sleep(500) }
  check('HR is told Ben reached 2 unapproved absences', !!flag)

  // ─── Changes after lock ───────────────────────────────────
  await prisma.attendanceRecord.update({ where: { id: benRec.id }, data: { isLocked: true } })
  r = await api(owner, 'POST', '/attendance/override', { employeeId: ben.id, date: '2026-10-06', status: 'absent', reason: 'Badge was used by someone else' })
  check('HR changes a locked day (with a reason)', r.status === 200 || r.status === 201, r.data)
  r = await api(owner, 'GET', '/attendance/adjustments?pending=true')
  check('…it is logged as an adjustment worth −1 day of pay for the next payroll', r.body.some((a) => a.employeeId === ben.id && a.fromStatus === 'present' && a.toStatus === 'absent' && a.payDays === -1), r.body)

  // ─── Holiday templates ────────────────────────────────────
  r = await api(owner, 'GET', '/holidays/templates?country=ZM&year=2026')
  check("Zambia 2026 template: Good Friday 3 April, Heroes' Day 6 July", r.body.holidays.some((h) => h.name === 'Good Friday' && h.date === '2026-04-03') && r.body.holidays.some((h) => h.name === "Heroes' Day" && h.date === '2026-07-06'), r.body?.holidays)
  r = await api(owner, 'POST', '/holidays/calendars/from-template', { country: 'KE', year: 2027 })
  const cal = r.body
  check('HR creates the Kenya 2027 calendar in one click', r.status === 201 && (await prisma.holiday.count({ where: { calendarId: cal.id } })) >= 10, r.data)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

// Time tracker: the running session lives on the server (openSince), several check-in/out pairs a day add up, a shift
// past midnight stays clocked in, and hours are kept to the second. Runs as the owner of a fresh test company
// (deactivated at the end), with the clock simulated by moving openSince back.
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `tt${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
const HOUR = 3_600_000
const near = (a, b, tol = 0.002) => Math.abs(a - b) < tol

;(async () => {
  const keys = await redis.keys('signup:ip:*')
  if (keys.length) await redis.del(...keys)
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Tracker ${TAG}`, fullName: 'Tia Tracker', email: `tia.${TAG}@example.com`, password: `Start${TAG}x9` })
  if (r.status !== 201) throw new Error(`signup: ${JSON.stringify(r.data)}`)
  const me = r.body.accessToken
  const tenantId = r.body.user.tenant.id
  const employeeId = r.body.user.employee.id
  const back = async (id, ms) => {
    const rec = await prisma.attendanceRecord.findUnique({ where: { id } })
    await prisma.attendanceRecord.update({ where: { id }, data: { openSince: new Date(rec.openSince.getTime() - ms), ...(rec.workedHours ? {} : { checkInTime: new Date(rec.checkInTime.getTime() - ms) }) } })
  }

  // ─── FIRST SESSION ─────────────────────────────────────────
  r = await api(me, 'GET', '/attendance/today')
  const today = r.body.date
  check('before clocking in: not running, server time included', r.status === 200 && !r.body.running && !r.body.clockedIn && r.body.serverTime, r.body)
  r = await api(me, 'POST', '/attendance/clock-in', { method: 'web' })
  check('clock in', r.status === 200 || r.status === 201, r.data)
  r = await api(me, 'GET', '/attendance/today')
  const rec = await prisma.attendanceRecord.findFirst({ where: { employeeId } })
  check('today shows the running session with its server start time', r.body.running && r.body.openSince && new Date(r.body.openSince).getTime() === rec.openSince.getTime(), r.body)
  r = await api(me, 'POST', '/attendance/clock-in', { method: 'web' })
  check('clocking in twice is refused', r.status === 400, r.data)
  await back(rec.id, 1.5 * HOUR + 15_000) // 1:30:15 worked
  r = await api(me, 'POST', '/attendance/clock-out', { method: 'web' })
  check('clock out', r.status === 200, r.data)
  r = await api(me, 'GET', '/attendance/today')
  const first = r.body.workedHours
  // 1:30:15 simulated plus the few real seconds between requests; to the second, not rounded to 0.01 h (36 s)
  check('hours are kept to the second (about 1:30:15)', !r.body.running && r.body.clockedOut && near(first, 1.504167, 0.005) && Math.round(first * 100) !== first * 100 && r.body.openSince === null, r.body)

  // ─── SECOND SESSION THE SAME DAY ───────────────────────────
  r = await api(me, 'POST', '/attendance/clock-in', { method: 'web' })
  check('clocking in again after clocking out is allowed', r.status === 200 || r.status === 201, r.data)
  const again = await prisma.attendanceRecord.findUnique({ where: { id: rec.id } })
  check('the first check-in time is kept; a new session is open', again.checkInTime.getTime() === new Date(rec.checkInTime.getTime() - 1.5 * HOUR - 15_000).getTime() && again.openSince && again.checkOutTime === null, again)
  r = await api(me, 'GET', '/attendance/today')
  check('today: running again, closed hours carried over', r.body.running && r.body.workedHours === first, r.body)
  await back(rec.id, 0.5 * HOUR)
  r = await api(me, 'POST', '/attendance/clock-out', { method: 'web' })
  check('the day total adds both sessions (first + 0:30:00)', r.status === 200 && near(r.body.workedHours, first + 0.5, 0.005), r.body)

  // ─── A SHIFT PAST MIDNIGHT ─────────────────────────────────
  const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86_400_000)
  const night = await prisma.attendanceRecord.create({ data: { employeeId, date: yesterday, checkInTime: new Date(Date.now() - 3 * HOUR), openSince: new Date(Date.now() - 3 * HOUR), status: 'present', source: 'auto' } })
  await prisma.attendanceRecord.update({ where: { id: rec.id }, data: { date: new Date(yesterday.getTime() - 86_400_000) } }) // today's pairs out of the way
  r = await api(me, 'GET', '/attendance/today')
  check("a session started yesterday still shows as running today", r.body.running && r.body.date === yesterday.toISOString().slice(0, 10) && new Date(r.body.openSince).getTime() === night.openSince.getTime(), r.body)
  r = await api(me, 'POST', '/attendance/clock-in', { method: 'web' })
  check('cannot start another session while that one runs', r.status === 400, r.data)
  r = await api(me, 'POST', '/attendance/clock-out', { method: 'web' })
  const closed = await prisma.attendanceRecord.findUnique({ where: { id: night.id } })
  check('clocking out closes it on the day it started (3 h)', r.status === 200 && closed.checkOutTime && near(closed.workedHours, 3, 0.01), closed)

  // ─── FORGOTTEN CLOCK-OUTS ARE NOT RESUMED ──────────────────
  await prisma.attendanceRecord.create({ data: { employeeId, date: new Date(yesterday.getTime() - 3 * 86_400_000), checkInTime: new Date(Date.now() - 100 * HOUR), openSince: new Date(Date.now() - 100 * HOUR), status: 'present', source: 'auto' } })
  r = await api(me, 'GET', '/attendance/today')
  check('an open record from 4 days ago does not show as running', !r.body.running, r.body)

  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await redis.quit()
  await done()
})().catch(async (e) => { console.error(e); await redis.quit(); await prisma.$disconnect(); process.exit(1) })

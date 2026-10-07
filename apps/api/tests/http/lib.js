// HTTP test helpers. Runs against a live API (default http://localhost:4000) and the dev DB.
// Usage: load apps/api/.env into the environment, start the API, then `node tests/http/<file>.test.js`.
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')

const BASE = (process.env.API_URL || 'http://localhost:4000') + '/api/v1'
// Neon's pooler can be slow to accept the first connection after idle
const dbUrl = process.env.DATABASE_URL || ''
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl.includes('connect_timeout') ? dbUrl : dbUrl + (dbUrl.includes('?') ? '&' : '?') + 'connect_timeout=30' } } })
const results = []

// Access token for a user, built the same way auth.service does (passwords for John/Jane aren't in the seeds)
async function tokenFor(email) {
  const user = await prisma.user.findFirst({
    where: { email, tenant: { slug: 'marichi-labs' } },
    include: { userRoles: { include: { role: true } }, employee: true },
  })
  if (!user) throw new Error(`No user ${email}`)
  const payload = { userId: user.id, tenantId: user.tenantId, employeeId: user.employee?.id || '', roleIds: user.userRoles.map((r) => r.role.name), email }
  return { token: jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: '2h' }), ...payload }
}

async function login(email, password) {
  const r = await api(null, 'POST', '/auth/login', { email, password, tenantSlug: 'marichi-labs' })
  return r
}

async function api(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' }
  if (who) headers.Authorization = `Bearer ${who.token || who}`
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const type = res.headers.get('content-type') || ''
  let data
  if (type.includes('json')) data = await res.json()
  else if (type.includes('pdf')) data = Buffer.from(await res.arrayBuffer())
  else data = await res.text()
  return { status: res.status, data, body: data && data.data, headers: res.headers }
}

function check(name, cond, detail) {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `\n      got: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`)
}

async function done() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  await prisma.$disconnect()
  process.exit(failed.length ? 1 : 0)
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
const sum = (a) => round2(a.reduce((s, x) => s + x, 0))

module.exports = { api, login, tokenFor, check, done, prisma, round2, sum }

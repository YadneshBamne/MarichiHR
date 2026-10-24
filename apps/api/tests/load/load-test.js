// Load test: a throwaway company with N people (bulk-seeded with running contracts), then
//  1. a full payroll run through the API, timed, with the per-person cost and an estimate for 5,000 people
//  2. C concurrent users reading the dashboard for S seconds: requests/second and p50 / p95 latency
// Run with the API up:  N=300 C=20 S=30 node -r dotenv/config tests/load/load-test.js
// The company is deactivated at the end. Numbers depend on the database round trip: from India to Neon us-east-2 it
// is ~250-400 ms; co-located (same region) it is ~1-2 ms, which is what production should be measured on.
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, prisma } = require('../http/lib')

const N = Number(process.env.N || 300), C = Number(process.env.C || 20), S = Number(process.env.S || 30)
const TAG = `ld${Date.now() % 1e7}`
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }

;(async () => {
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  redis.disconnect()
  const email = `owner.${TAG}@example.com`
  const r = await api(null, 'POST', '/auth/signup', { companyName: `Load ${TAG}`, fullName: 'Load Owner', email, password: 'Owner-pass-123' })
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { primaryCountry: 'ZM', modules: { set: [...new Set([...(tenant.modules ?? []), 'payroll'])] } } })
  const owner = await prisma.employee.findFirst({ where: { tenantId: tenant.id } })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const pay = { token: jwt.sign({ userId: owner.userId, tenantId: tenant.id, employeeId: owner.id, roleIds: ['employee', 'payroll_admin', 'hr_admin', 'system_admin'], email }, process.env.JWT_ACCESS_SECRET, { expiresIn: '2h' }) }
  const structure = (await api(pay, 'POST', '/salary/structures/starter')).body

  // ─── Seed N people with running contracts (bulk) ─────────
  let t = Date.now()
  const people = Array.from({ length: N }, (_, i) => ({ userId: crypto.randomUUID(), employeeId: crypto.randomUUID(), i }))
  for (let at = 0; at < N; at += 1000) {
    const chunk = people.slice(at, at + 1000)
    await prisma.user.createMany({ data: chunk.map((p) => ({ id: p.userId, tenantId: tenant.id, email: `p${p.i}.${TAG}@example.com`, fullName: `Person ${p.i}` })) })
    await prisma.employee.createMany({ data: chunk.map((p) => ({ id: p.employeeId, tenantId: tenant.id, userId: p.userId, employeeCode: `LD${String(p.i).padStart(6, '0')}`, orgUnitId: root.id, firstName: 'Person', lastName: String(p.i), workEmail: `p${p.i}.${TAG}@example.com`, hireDate: new Date('2025-01-06'), taxJurisdiction: 'ZM' })) })
    await prisma.employeeContract.createMany({ data: chunk.map((p) => ({ employeeId: p.employeeId, salaryStructureId: structure.id, ctcAnnual: 120000 + p.i, wageMonthly: 10000 + p.i / 12, currency: 'ZMW', effectiveFrom: new Date('2025-01-06'), status: 'running' })) })
  }
  console.log(`seeded ${N} people with contracts in ${((Date.now() - t) / 1000).toFixed(1)} s`)

  // ─── Payroll run ─────────────────────────────────────────
  const cycle = (await api(pay, 'POST', '/payroll/cycles', { payPeriodStart: '2026-04-01', payPeriodEnd: '2026-04-30' })).body
  await api(pay, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
  t = Date.now()
  const run = await api(pay, 'POST', `/payroll/cycles/${cycle.id}/run`)
  const secs = (Date.now() - t) / 1000
  const per = secs / Math.max(1, run.body?.processed ?? 1)
  console.log(`payroll run: ${run.status}, ${run.body?.processed} payslips, ${run.body?.skipped?.length} skipped in ${secs.toFixed(1)} s (${(per * 1000).toFixed(0)} ms per person); 5,000 people ≈ ${((per * 5000) / 60).toFixed(1)} min at this database latency`)

  // ─── Concurrent reads ────────────────────────────────────
  const lat = []
  let errors = 0
  const until = Date.now() + S * 1000
  await Promise.all(Array.from({ length: C }, async () => {
    while (Date.now() < until) {
      const a = Date.now()
      const x = await api(pay, 'GET', '/dashboard')
      lat.push(Date.now() - a)
      if (x.status !== 200) errors++
    }
  }))
  console.log(`dashboard: ${C} users for ${S} s → ${lat.length} requests (${(lat.length / S).toFixed(1)}/s), p50 ${pct(lat, 50)} ms, p95 ${pct(lat, 95)} ms, errors ${errors}`)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  await prisma.$disconnect()
})().catch((e) => { console.error(e); process.exit(1) })

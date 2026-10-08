// Sign-in with pasted credentials: a space at either end of the password, spaces / invisible characters / capitals in
// the email still sign in; a wrong password (or a space inside it) still fails. Uses a fresh test company.
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `lp${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })

;(async () => {
  const keys = await redis.keys('signup:*')
  if (keys.length) await redis.del(...keys)
  const email = `paste.${TAG}@example.com`
  const password = `Paste${TAG}x9`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Paste ${TAG}`, fullName: 'Pat Paste', email, password })
  if (r.status !== 201) throw new Error(`signup: ${JSON.stringify(r.data)}`)
  const tenantId = r.body.user.tenant.id
  const ok = async (label, body) => { r = await api(null, 'POST', '/auth/login', body); check(label, r.status === 200 && r.body.accessToken, r.data) }
  await ok('exact credentials sign in', { email, password })
  await ok('password with a trailing space (pasted) signs in', { email, password: `${password} ` })
  await ok('password with spaces around it signs in', { email, password: `  ${password}\t` })
  await ok('email with spaces, capitals and a zero-width space signs in', { email: ` ${email.toUpperCase()}​ `, password })
  r = await api(null, 'POST', '/auth/login', { email, password: `${password.slice(0, 4)} ${password.slice(4)}` })
  check('a space inside the password is still wrong (401)', r.status === 401, r.data)
  r = await api(null, 'POST', '/auth/login', { email, password: `${password}x` })
  check('a wrong password still fails (401)', r.status === 401, r.data)
  await redis.del(...(await redis.keys(`login:fail:${email}:*`)))
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await redis.quit()
  await done()
})().catch(async (e) => { console.error(e); await redis.quit(); await prisma.$disconnect(); process.exit(1) })

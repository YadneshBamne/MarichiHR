// Notification preferences: per person, per category, email / WhatsApp on or off; the bell always gets everything;
// mandatory categories (pay, policies) cannot be switched off.
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `np${Date.now() % 1e7}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const admin = await tokenFor('admin@marichihr.com')
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const john = await tokenFor('john.banda@marichihr.com')
  const before = await prisma.user.findUnique({ where: { id: jane.userId }, select: { notifyPrefs: true } })

  let r = await api(jane, 'GET', '/notifications/preferences')
  const cat = (k) => r.body.categories.find((c) => c.key === k)
  check('everyone sees the categories, all on by default', r.status === 200 && cat('workplace').email === true && cat('pay').mandatory === true, r.body?.categories?.map((c) => c.key))

  r = await api(jane, 'PUT', '/notifications/preferences', { prefs: { workplace: { email: false } } })
  check('Jane switches off workplace emails', r.status === 200 && r.body.workplace.email === false, r.data)
  r = await api(jane, 'PUT', '/notifications/preferences', { prefs: { pay: { email: false } } })
  r = await api(jane, 'GET', '/notifications/preferences')
  check('mandatory categories stay on (pay)', cat('pay').email === true && cat('workplace').email === false, r.body.categories)
  r = await api(jane, 'PUT', '/notifications/preferences', { prefs: { nonsense: { email: false } } })
  check('unknown categories are refused (400)', r.status === 400, r.status)

  // An announcement goes to everyone: Jane gets it in the bell but not by email; John gets both
  r = await api(admin, 'POST', '/announcements', { title: `Prefs ${TAG}`, body: 'Checking delivery choices' })
  const annId = r.body?.id
  let jn = null, jo = null
  for (let i = 0; i < 40 && !(jn && jo); i++) {
    ;[jn, jo] = await Promise.all([jane, john].map((u) => prisma.notification.findFirst({ where: { userId: u.userId, type: 'announcement', body: `Prefs ${TAG}` } })))
    if (!(jn && jo)) await sleep(500)
  }
  const email = (n) => (n?.deliveries ?? []).find((d) => d.channel === 'email')
  check('Jane still gets it in the bell', !!jn, jn)
  check('…but the email was skipped by her preference', email(jn)?.status === 'skipped', jn?.deliveries)
  check('John (no preference) gets the email', email(jo)?.status === 'sent', jo?.deliveries)

  await prisma.user.update({ where: { id: jane.userId }, data: { notifyPrefs: before.notifyPrefs ?? {} } })
  if (annId) await prisma.announcement.update({ where: { id: annId }, data: { active: false } }).catch(() => {})
  await done()
})()

// Holiday calendars: HR manages them; everyone reads; scoping by country; holidays are not leave days and show on the
// attendance calendar; copy to next year; tenant isolation. Uses 2031/2032 so it never touches real data; cleans up.
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `h${Date.now() % 1e6}`
const Y = 2031

;(async () => {
  const admin = await tokenFor('admin@marichihr.com')
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const made = []

  // ─── Manage ────────────────────────────────────────────────
  let r = await api(jane, 'POST', '/holidays/calendars', { name: `x ${TAG}`, year: Y })
  check('an employee cannot create a calendar (403)', r.status === 403, r.status)
  r = await api(admin, 'POST', '/holidays/calendars', { name: `Bad ${TAG}`, year: Y, holidays: [{ name: 'Wrong year', date: `${Y + 1}-01-01` }] })
  check('a holiday outside the calendar year is refused (400)', r.status === 400, r.data)
  r = await api(admin, 'POST', '/holidays/calendars', { name: `Dup ${TAG}`, year: Y, holidays: [{ name: 'A', date: `${Y}-01-01` }, { name: 'B', date: `${Y}-01-01` }] })
  check('two holidays on one date are refused (409)', r.status === 409, r.data)
  r = await api(admin, 'POST', '/holidays/calendars', { name: `Everyone ${TAG} ${Y}`, year: Y, holidays: [{ name: `Founders Day ${TAG}`, date: `${Y}-01-07` }, { name: `Optional ${TAG}`, date: `${Y}-01-08`, isOptional: true }] })
  const cal = r.body
  made.push(cal?.id)
  check('HR creates a calendar with holidays', r.status === 201 && cal.id, r.data)
  r = await api(admin, 'POST', '/holidays/calendars', { name: `Elsewhere ${TAG}`, year: Y, countryCode: 'zz', holidays: [{ name: `Elsewhere Day ${TAG}`, date: `${Y}-01-09` }] })
  made.push(r.body?.id)
  check('a country-scoped calendar is created (code upper-cased)', r.status === 201 && r.body.countryCode === 'ZZ', r.data)
  r = await api(admin, 'POST', `/holidays/calendars/${cal.id}/holidays`, { holidays: [{ name: `Late add ${TAG}`, date: `${Y}-03-03`, type: 'company' }] })
  check('HR adds holidays to a calendar', r.status === 201 && r.body.length === 3, r.data)
  r = await api(admin, 'POST', `/holidays/calendars/${cal.id}/holidays`, { holidays: [{ name: 'Clash', date: `${Y}-01-07` }] })
  check('adding a date that already has a holiday is refused (409)', r.status === 409, r.data)

  // ─── Read ──────────────────────────────────────────────────
  r = await api(jane, 'GET', `/holidays?year=${Y}`)
  const mineCal = r.body?.calendars?.find((c) => c.id === cal.id)
  const otherCal = r.body?.calendars?.find((c) => c.name === `Elsewhere ${TAG}`)
  check('employees can read the calendars', r.status === 200 && !!mineCal, r.data)
  check('a company-wide calendar applies to everyone; a ZZ-only one does not apply to Jane', mineCal?.appliesToMe === true && otherCal?.appliesToMe === false, { mine: mineCal?.appliesToMe, other: otherCal?.appliesToMe })
  r = await api(jane, 'GET', `/holidays/mine?from=${Y}-01-01&to=${Y}-01-31`)
  check("'mine' lists her holidays incl. optional (flagged), not other countries'", r.status === 200 && r.body.some((h) => h.name === `Founders Day ${TAG}` && !h.isOptional) && r.body.some((h) => h.isOptional) && !r.body.some((h) => h.name === `Elsewhere Day ${TAG}`), r.body)

  // ─── Leave and attendance use them ─────────────────────────
  const annual = (await api(admin, 'GET', '/leave/types')).body.find((t) => t.code === 'ANNUAL')
  await api(admin, 'POST', '/leave/allocations/manual', { employeeId: jane.employeeId, leaveTypeId: annual.id, daysAllocated: 3, validFrom: `${Y}-01-01`, reason: TAG })
  r = await api(jane, 'POST', '/leave/requests', { leaveTypeId: annual.id, startDate: `${Y}-01-06`, endDate: `${Y}-01-08`, reason: TAG })
  check('leave Mon–Wed over a public holiday counts 2 days (holiday skipped, optional one counted)', r.status === 201 && Number(r.body.totalDays) === 2, r.data)
  if (r.body?.id) await api(jane, 'POST', `/leave/requests/${r.body.id}/cancel`, {})
  r = await api(jane, 'POST', '/leave/requests', { leaveTypeId: annual.id, startDate: `${Y}-01-07`, endDate: `${Y}-01-07`, reason: TAG })
  check('leave only on a public holiday is refused (no working days)', r.status === 400, r.data)
  r = await api(jane, 'GET', `/attendance/calendar/me?year=${Y}&month=1`)
  const d7 = r.body?.calendar?.find((d) => d.date === `${Y}-01-07`)
  check('attendance calendar marks the holiday with its name', d7?.status === 'holiday' && d7.holiday === `Founders Day ${TAG}`, d7)

  // ─── Edit, copy, archive ───────────────────────────────────
  const h = (await prisma.holiday.findFirst({ where: { calendarId: cal.id, name: `Late add ${TAG}` } }))
  r = await api(admin, 'PATCH', `/holidays/${h.id}`, { name: `Renamed ${TAG}`, date: `${Y}-03-04` })
  check('HR edits a holiday', r.status === 200 && r.body.name === `Renamed ${TAG}`, r.data)
  r = await api(admin, 'PATCH', `/holidays/${h.id}`, { date: `${Y + 1}-03-04` })
  check('moving a holiday out of its year is refused (400)', r.status === 400, r.data)
  r = await api(admin, 'POST', `/holidays/calendars/${cal.id}/copy`, { year: Y + 1 })
  made.push(r.body?.id)
  const copied = r.body?.id && await prisma.holiday.findMany({ where: { calendarId: r.body.id } })
  check('copy to next year keeps names and day/month, renames the calendar', r.status === 201 && r.body.name === `Everyone ${TAG} ${Y + 1}` && copied.length === 3 && copied.some((x) => x.date.toISOString().startsWith(`${Y + 1}-01-07`)), r.data)
  r = await api(admin, 'POST', `/holidays/${h.id}/archive`)
  r = await api(jane, 'GET', `/holidays?year=${Y}`)
  check('an archived holiday disappears', !r.body.calendars.find((c) => c.id === cal.id).holidays.some((x) => x.id === h.id))

  // ─── Isolation ─────────────────────────────────────────────
  const otherTenant = await prisma.tenant.findFirst({ where: { slug: { not: 'marichi-labs' } } })
  const foreign = await prisma.holidayCalendar.create({ data: { tenantId: otherTenant.id, name: `Foreign ${TAG}`, year: Y, holidays: { create: [{ name: 'Foreign day', date: new Date(`${Y}-05-05T00:00:00Z`) }] } }, include: { holidays: true } })
  r = await api(admin, 'PATCH', `/holidays/calendars/${foreign.id}`, { name: 'hijack' })
  check("another company's calendar cannot be edited (404)", r.status === 404, r.status)
  r = await api(admin, 'POST', `/holidays/${foreign.holidays[0].id}/archive`)
  check("another company's holiday cannot be removed (404)", r.status === 404, r.status)
  r = await api(admin, 'GET', `/holidays?year=${Y}`)
  check("another company's calendars are not listed", !r.body.calendars.some((c) => c.id === foreign.id))

  // ─── Cleanup ───────────────────────────────────────────────
  for (const id of made.filter(Boolean)) await api(admin, 'POST', `/holidays/calendars/${id}/archive`)
  r = await api(jane, 'GET', `/holidays?year=${Y}`)
  check('archived calendars disappear', !r.body.calendars.some((c) => made.includes(c.id)))
  await prisma.holiday.deleteMany({ where: { calendarId: foreign.id } })
  await prisma.holidayCalendar.delete({ where: { id: foreign.id } })
  await done()
})()

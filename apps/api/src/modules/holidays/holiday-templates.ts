// Ready-made public holiday lists per country. Fixed dates and Easter-based dates are computed for any year; holidays
// that follow the moon (Eid, Maulud, Diwali...) are listed for 2026 and 2027 only and must be confirmed when the date
// is announced. Companies edit the calendar after creating it.
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10)
const addDays = (s: string, n: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10)

// Easter Sunday (anonymous Gregorian algorithm)
function easter(y: number) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1
  return iso(y, month, day)
}
// The nth Monday (or other weekday, 0 = Sunday) of a month
function nthWeekday(y: number, m: number, weekday: number, n: number) {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  return iso(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7)
}
// Moon-dependent dates (approximate until announced)
const LUNAR: Record<number, Record<string, string>> = {
  2026: { eidFitr: '2026-03-20', eidAdha: '2026-05-27', maulud: '2026-08-26', diwali: '2026-11-08', holi: '2026-03-04' },
  2027: { eidFitr: '2027-03-10', eidAdha: '2027-05-17', maulud: '2027-08-15', diwali: '2027-10-29', holi: '2027-03-22' },
}

type H = { name: string; date: string; isOptional?: boolean }
export const HOLIDAY_COUNTRIES = { ZM: 'Zambia', KE: 'Kenya', NG: 'Nigeria', IN: 'India' } as const

export function holidayTemplate(country: keyof typeof HOLIDAY_COUNTRIES, y: number): H[] {
  const e = easter(y), lunar = LUNAR[y] ?? {}
  const moon = (key: string, name: string, extraDay = false): H[] => lunar[key] ? [{ name: `${name} (date to confirm)`, date: lunar[key] }, ...(extraDay ? [{ name: `${name} holiday (date to confirm)`, date: addDays(lunar[key], 1) }] : [])] : []
  if (country === 'ZM') {
    const heroes = nthWeekday(y, 7, 1, 1)
    return [
      { name: "New Year's Day", date: iso(y, 1, 1) }, { name: "International Women's Day", date: iso(y, 3, 8) }, { name: 'Youth Day', date: iso(y, 3, 12) },
      { name: 'Good Friday', date: addDays(e, -2) }, { name: 'Holy Saturday', date: addDays(e, -1) }, { name: 'Easter Monday', date: addDays(e, 1) },
      { name: 'Kenneth Kaunda Day', date: iso(y, 4, 28) }, { name: 'Labour Day', date: iso(y, 5, 1) }, { name: 'Africa Freedom Day', date: iso(y, 5, 25) },
      { name: "Heroes' Day", date: heroes }, { name: 'Unity Day', date: addDays(heroes, 1) }, { name: "Farmers' Day", date: nthWeekday(y, 8, 1, 1) },
      { name: 'National Day of Prayer', date: iso(y, 10, 18) }, { name: 'Independence Day', date: iso(y, 10, 24) }, { name: 'Christmas Day', date: iso(y, 12, 25) },
    ]
  }
  if (country === 'KE') return [
    { name: "New Year's Day", date: iso(y, 1, 1) }, { name: 'Good Friday', date: addDays(e, -2) }, { name: 'Easter Monday', date: addDays(e, 1) },
    { name: 'Labour Day', date: iso(y, 5, 1) }, { name: 'Madaraka Day', date: iso(y, 6, 1) }, ...moon('eidFitr', 'Idd-ul-Fitr'),
    { name: 'Mazingira Day', date: iso(y, 10, 10) }, { name: 'Mashujaa Day', date: iso(y, 10, 20) }, { name: 'Jamhuri Day', date: iso(y, 12, 12) },
    { name: 'Christmas Day', date: iso(y, 12, 25) }, { name: 'Boxing Day', date: iso(y, 12, 26) },
  ]
  if (country === 'NG') return [
    { name: "New Year's Day", date: iso(y, 1, 1) }, { name: 'Good Friday', date: addDays(e, -2) }, { name: 'Easter Monday', date: addDays(e, 1) },
    { name: "Workers' Day", date: iso(y, 5, 1) }, { name: 'Democracy Day', date: iso(y, 6, 12) }, ...moon('eidFitr', 'Eid-el-Fitr', true), ...moon('eidAdha', 'Eid-el-Kabir', true),
    ...moon('maulud', 'Eid-el-Maulud'), { name: 'Independence Day', date: iso(y, 10, 1) }, { name: 'Christmas Day', date: iso(y, 12, 25) }, { name: 'Boxing Day', date: iso(y, 12, 26) },
  ]
  // India: the three national holidays are fixed; the rest vary by state and are offered as optional
  return [
    { name: 'Republic Day', date: iso(y, 1, 26) }, { name: 'Independence Day', date: iso(y, 8, 15) }, { name: 'Gandhi Jayanti', date: iso(y, 10, 2) },
    ...moon('holi', 'Holi').map((h) => ({ ...h, isOptional: true })), { name: 'Good Friday', date: addDays(e, -2), isOptional: true },
    ...moon('eidFitr', 'Id-ul-Fitr').map((h) => ({ ...h, isOptional: true })), ...moon('diwali', 'Diwali').map((h) => ({ ...h, isOptional: true })),
    { name: 'Christmas Day', date: iso(y, 12, 25), isOptional: true },
  ]
}

import { AppError } from '../../shared/utils/AppError'

// Plain input rules for people records (no database): dates, names and phone numbers. Used by Add person, edit, bulk import and the resume lines,
// so every route refuses the same bad values with the same clear 400 instead of a 500.

export const todayYmd = () => new Date().toISOString().slice(0, 10)
const addYears = (ymd: string, n: number) => `${Number(ymd.slice(0, 4)) + n}${ymd.slice(4)}`

// A real calendar date written YYYY-MM-DD (a time after it is ignored); anything else is a 400 that names the field
export function ymdOrThrow(v: unknown, label: string): string {
  const t = typeof v === 'string' ? v.trim() : ''
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/)
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null
  if (!m || !d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new AppError(`${label} is not a valid date. Use the form 2026-03-31.`, 400)
  return `${m[1]}-${m[2]}-${m[3]}`
}
const given = (v: unknown) => v != null && v !== ''

// Joining date: not before 1950, and not more than a year ahead. Birth date: a real past date, at least 14 and at most 100 years ago.
export function checkPersonDates(d: { hireDate?: unknown; dateOfBirth?: unknown; probationEndDate?: unknown; confirmationDate?: unknown }, today = todayYmd()) {
  const out: Record<string, string> = {}
  if (given(d.hireDate)) {
    const h = ymdOrThrow(d.hireDate, 'Joining date')
    if (h > addYears(today, 1)) throw new AppError('Joining date is more than a year in the future', 400)
    if (h < '1950-01-01') throw new AppError('Joining date is before 1950. Check the year.', 400)
    out.hireDate = h
  }
  if (given(d.dateOfBirth)) {
    const b = ymdOrThrow(d.dateOfBirth, 'Date of birth')
    if (b > today) throw new AppError('Date of birth is in the future', 400)
    if (b > addYears(today, -14)) throw new AppError('Date of birth makes this person younger than 14. Check the year.', 400)
    if (b < addYears(today, -100)) throw new AppError('Date of birth is more than 100 years ago. Check the year.', 400)
    out.dateOfBirth = b
  }
  if (given(d.probationEndDate)) out.probationEndDate = ymdOrThrow(d.probationEndDate, 'Probation end date')
  if (given(d.confirmationDate)) out.confirmationDate = ymdOrThrow(d.confirmationDate, 'Confirmation date')
  return out
}

// A name made only of spaces is refused; inner spaces are tidied
export function cleanName(v: unknown, label: string, max = 80): string {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  if (!t) throw new AppError(`${label} cannot be empty`, 400)
  if (t.length > max) throw new AppError(`${label} is too long (most ${max} characters)`, 400)
  return t
}

// Digits with an optional leading +, 7 to 15 of them (spaces, dashes, dots and brackets are tidied away); blank means "not given"
export function normMobile(v: unknown, label: string): string | undefined {
  if (!given(v)) return undefined
  const t = String(v).trim().replace(/[\s().-]/g, '')
  if (!/^\+?\d{7,15}$/.test(t)) throw new AppError(`${label} is not a valid phone number. Use digits, with a leading + for the country code if you like (7 to 15 digits).`, 400)
  return t
}

// Everything on a new or edited person that can be checked without the database; returns the cleaned values
export function cleanPersonInput<T extends Record<string, any>>(data: T, label = { first: 'First name', last: 'Last name' }): T {
  const out: Record<string, any> = { ...data }
  if (data.firstName !== undefined) out.firstName = cleanName(data.firstName, label.first)
  if (data.lastName !== undefined) out.lastName = cleanName(data.lastName, label.last)
  Object.assign(out, checkPersonDates(data))
  for (const [k, l] of [['mobilePersonal', 'Personal mobile'], ['mobileWork', 'Work mobile'], ['emergencyContactPhone', 'Emergency contact phone']] as const) {
    if (data[k] !== undefined) { const m = normMobile(data[k], l); if (m === undefined) delete out[k]; else out[k] = m }
  }
  for (const k of ['dateOfBirth', 'gender', 'nationality', 'personalEmail', 'taxJurisdiction', 'emergencyContactName', 'emergencyContactRelation']) if (out[k] === '') delete out[k]
  return out as T
}

// A resume line: both dates real, the end not before the start
export function checkResumeDates(start?: unknown, end?: unknown) {
  const s = given(start) ? ymdOrThrow(start, 'Start date') : undefined
  const e = given(end) ? ymdOrThrow(end, 'End date') : undefined
  if (s && e && e < s) throw new AppError('The end date is before the start date', 400)
  return { start: s, end: e }
}

// Self-check: node -r ts-node/register/transpile-only src/modules/employees/employees.rules.ts
if (require.main === module) {
  const fails = (f: () => unknown) => { try { f(); return false } catch (e: any) { return e?.statusCode === 400 } }
  console.assert(ymdOrThrow('2026-03-31', 'x') === '2026-03-31' && ymdOrThrow('2026-03-31T10:00:00Z', 'x') === '2026-03-31', 'real dates pass')
  console.assert(fails(() => ymdOrThrow('xyz', 'x')) && fails(() => ymdOrThrow('2026-02-30', 'x')) && fails(() => ymdOrThrow('', 'x')), 'junk and impossible dates are 400')
  console.assert(fails(() => checkPersonDates({ hireDate: '2099-01-01' }, '2026-11-25')) && !fails(() => checkPersonDates({ hireDate: '2027-06-01' }, '2026-11-25')), 'a joiner within a year is fine, 2099 is not')
  console.assert(fails(() => checkPersonDates({ dateOfBirth: '2030-01-01' }, '2026-11-25')) && fails(() => checkPersonDates({ dateOfBirth: '2020-01-01' }, '2026-11-25')) && !fails(() => checkPersonDates({ dateOfBirth: '1990-05-05' }, '2026-11-25')), 'birth date rules')
  console.assert(fails(() => cleanName('   ', 'Name')) && cleanName('  Mary   Jane ', 'Name') === 'Mary Jane', 'names')
  console.assert(normMobile('+260 97-123 4567', 'm') === '+260971234567' && normMobile('', 'm') === undefined && fails(() => normMobile('abc', 'm')) && fails(() => normMobile('123', 'm')), 'mobiles')
  console.assert(fails(() => checkResumeDates('2020-01-01', '2019-01-01')) && fails(() => checkResumeDates('xyz')) && checkResumeDates('2019-01-01', '2020-01-01').end === '2020-01-01', 'resume dates')
  console.log('employee rules check done')
}

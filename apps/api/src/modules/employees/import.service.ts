import crypto from 'crypto'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { employeeRepository } from './employees.repository'
import { employeeService, accessService } from './employees.service'

// Bulk employee import from a spreadsheet (the browser turns the CSV into rows of header -> text).
// A dry run checks every row and says what would happen; the real run creates any missing departments, positions
// and locations (when allowed), then the people, managers before their reports, and optionally issues logins
// whose temporary passwords come back once as a credentials sheet (never stored in plain text).

export const IMPORT_COLUMNS = [
  'employee_id', 'first_name', 'last_name', 'work_email', 'hire_date', 'department', 'job_title', 'manager', 'employment_type',
  'work_location', 'personal_email', 'mobile', 'date_of_birth', 'gender', 'nationality', 'tax_country',
] as const
type Row = Partial<Record<(typeof IMPORT_COLUMNS)[number], string>>
type Actor = { tenantId: string; userId: string; roleIds: string[]; employeeId?: string }
export interface ImportResult {
  dryRun: boolean
  rows: { row: number; name: string; email: string; employeeCode: string | null; status: 'ok' | 'error' | 'created'; errors: string[]; employeeId?: string }[]
  willCreate: { departments: string[]; positions: string[]; locations: string[] }
  created: number
  credentials?: Credential[]
}
export interface Credential { name: string; employeeCode: string; email: string; temporaryPassword: string }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
const TYPES: Record<string, string> = { fulltime: 'full_time', parttime: 'part_time', contractor: 'contractor', contract: 'contractor', intern: 'intern', internship: 'intern' }

// YYYY-MM-DD, or day-first DD/MM/YYYY or DD-MM-YYYY (as typed in India and Zambia); null if not a real date
export function parseDate(v: string): string | null {
  const t = v.trim()
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  let y: number, mo: number, d: number
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else return null
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null
}

// Run `fn` over items, `limit` at a time (each create is a couple of database round trips)
async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) await fn(items[i++]) }))
}

export async function importEmployees(actor: Actor, input: { rows: Row[]; dryRun: boolean; createMissing: boolean; grantLogin: boolean }): Promise<ImportResult> {
  const t = actor.tenantId
  const [units, positions, locations, existing, root] = await Promise.all([
    prisma.orgUnit.findMany({ where: { tenantId: t, active: true }, select: { id: true, name: true } }),
    prisma.jobPosition.findMany({ where: { tenantId: t }, select: { id: true, title: true, orgUnitId: true } }),
    prisma.workLocation.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { tenantId: t }, select: { id: true, employeeCode: true, workEmail: true, active: true, user: { select: { email: true } } } }),
    prisma.orgUnit.findFirst({ where: { tenantId: t, parentId: null, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } }),
  ])
  const byName = <X extends { id: string }>(list: X[], name: (x: X) => string) => {
    const m = new Map<string, X[]>()
    list.forEach((x) => m.set(key(name(x)), [...(m.get(key(name(x))) ?? []), x]))
    return m
  }
  const unitMap = byName(units, (u) => u.name), locMap = byName(locations, (l) => l.name)
  const takenEmails = new Set(existing.flatMap((e) => [e.workEmail, e.user?.email].filter(Boolean).map((x) => key(x!))))
  const takenCodes = new Set(existing.map((e) => e.employeeCode.toUpperCase()))
  const existingByRef = new Map<string, string>()
  existing.filter((e) => e.active).forEach((e) => { if (e.workEmail) existingByRef.set(key(e.workEmail), e.id); existingByRef.set(key(e.employeeCode), e.id) })

  // Keyed case-insensitively, so "Operations" and "operations" become one department
  const willCreate = { departments: new Map<string, string>(), positions: new Map<string, string>(), locations: new Map<string, string>() }
  const seenEmail = new Map<string, number>(), seenCode = new Map<string, number>()
  const needCodes = input.rows.filter((r) => !r.employee_id?.trim()).length
  const series = await employeeRepository.generateEmployeeCodes(t, needCodes)
  let nextSeries = 0

  const parsed = input.rows.map((raw, i) => {
    const r: Row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v ?? '').trim()]))
    const errors: string[] = []
    const n = i + 2 // spreadsheet row number (row 1 is the header)
    const email = key(r.work_email ?? '')
    if (!r.first_name) errors.push('first_name is required')
    if (!r.last_name) errors.push('last_name is required')
    if (!EMAIL.test(email)) errors.push('work_email is missing or not an email')
    else if (takenEmails.has(email)) errors.push(`${email} already belongs to someone in the company`)
    else if (seenEmail.has(email)) errors.push(`${email} is also on row ${seenEmail.get(email)}`)
    else seenEmail.set(email, n)
    const hireDate = parseDate(r.hire_date ?? '')
    if (!hireDate) errors.push('hire_date must be a date like 2026-10-01 or 01/10/2026')
    const dob = r.date_of_birth ? parseDate(r.date_of_birth) : null
    if (r.date_of_birth && !dob) errors.push('date_of_birth is not a valid date')
    if (r.personal_email && !EMAIL.test(r.personal_email)) errors.push('personal_email is not an email')
    if (r.tax_country && !/^[A-Za-z]{2}$/.test(r.tax_country)) errors.push('tax_country must be a 2-letter country code (ZM, IN…)')
    const type = r.employment_type ? TYPES[r.employment_type.toLowerCase().replace(/[^a-z]/g, '')] : 'full_time'
    if (!type) errors.push('employment_type must be full time, part time, contractor or intern')

    let code = r.employee_id?.toUpperCase() ?? ''
    if (code) {
      if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) errors.push('employee_id may use letters, digits and - (2-20 characters)')
      else if (takenCodes.has(code)) errors.push(`employee_id ${code} is already used`)
      else if (seenCode.has(code)) errors.push(`employee_id ${code} is also on row ${seenCode.get(code)}`)
      else seenCode.set(code, n)
    } else code = series[nextSeries++]

    // Department, position and location by name; missing ones are created only when allowed
    let unitId: string | null = null, unitName = r.department ?? ''
    const u = unitMap.get(key(unitName))
    if (!unitName) errors.push('department is required')
    else if (u && u.length > 1) errors.push(`there are ${u.length} departments called "${unitName}"; rename one first`)
    else if (u) unitId = u[0].id
    else if (input.createMissing) { if (!willCreate.departments.has(key(unitName))) willCreate.departments.set(key(unitName), unitName) }
    else errors.push(`no department called "${unitName}" (tick "create missing" or add it first)`)
    let positionId: string | null = null
    if (r.job_title) {
      const p = positions.filter((x) => key(x.title) === key(r.job_title!))
      const pick = p.find((x) => x.orgUnitId === unitId) ?? p[0]
      if (pick) positionId = pick.id
      else if (input.createMissing) { const k = `${key(r.job_title)}|${key(unitName)}`; if (!willCreate.positions.has(k)) willCreate.positions.set(k, `${r.job_title}|${unitName}`) }
      else errors.push(`no position called "${r.job_title}"`)
    }
    let locationId: string | null = null
    if (r.work_location) {
      const l = locMap.get(key(r.work_location))
      if (l) locationId = l[0].id
      else if (input.createMissing) { if (!willCreate.locations.has(key(r.work_location))) willCreate.locations.set(key(r.work_location), r.work_location) }
      else errors.push(`no work location called "${r.work_location}"`)
    }
    return { n, r, errors, email, code, hireDate, dob, type, unitId, unitName, positionId, locationId, managerRef: key(r.manager ?? ''), employeeId: undefined as string | undefined }
  })

  // Managers: someone already in the company (email or employee ID) or another row in this file
  const inFile = new Map<string, (typeof parsed)[number]>()
  parsed.forEach((p) => { if (p.email) inFile.set(p.email, p); inFile.set(key(p.code), p) })
  for (const p of parsed) {
    if (!p.managerRef) continue
    if (p.managerRef === p.email || p.managerRef === key(p.code)) p.errors.push('someone cannot be their own manager')
    else if (!existingByRef.has(p.managerRef) && !inFile.has(p.managerRef)) p.errors.push(`manager "${p.r.manager}" is not in the company or this file`)
  }
  // A manager in the file with errors fails their reports too; reporting loops inside the file are refused
  let changed = true
  while (changed) {
    changed = false
    for (const p of parsed) {
      const m = p.managerRef && !existingByRef.has(p.managerRef) ? inFile.get(p.managerRef) : undefined
      if (m && m.errors.length && !p.errors.some((e) => e.startsWith('their manager'))) { p.errors.push(`their manager (row ${m.n}) has errors`); changed = true }
    }
  }
  const level = (p: (typeof parsed)[number], seen = new Set<number>()): number => {
    const m = p.managerRef && !existingByRef.has(p.managerRef) ? inFile.get(p.managerRef) : undefined
    if (!m) return 0
    if (seen.has(p.n)) return Infinity
    seen.add(p.n)
    return 1 + level(m, seen)
  }
  for (const p of parsed) if (!p.errors.length && level(p) === Infinity) p.errors.push('reporting loop: this row is above itself through its managers')

  const result: ImportResult = {
    dryRun: input.dryRun, created: 0,
    rows: parsed.map((p) => ({ row: p.n, name: `${p.r.first_name ?? ''} ${p.r.last_name ?? ''}`.trim(), email: p.email, employeeCode: p.code || null, status: p.errors.length ? 'error' : 'ok', errors: p.errors })),
    willCreate: { departments: [...willCreate.departments.values()], positions: [...willCreate.positions.values()].map((x) => x.split('|')[0]), locations: [...willCreate.locations.values()] },
  }
  if (input.dryRun || parsed.some((p) => p.errors.length)) return result // all or nothing: fix the file and try again

  // Masters first, so every row can point at them
  const now = new Date()
  for (const name of willCreate.departments.values()) {
    const u = await prisma.orgUnit.create({ data: { tenantId: t, name, type: 'department', parentId: root?.id ?? null } })
    unitMap.set(key(name), [{ id: u.id, name }])
  }
  for (const pair of willCreate.positions.values()) {
    const [title, unit] = pair.split('|')
    const p = await prisma.jobPosition.create({ data: { tenantId: t, title, orgUnitId: unitMap.get(key(unit))![0].id } })
    positions.push({ id: p.id, title, orgUnitId: p.orgUnitId })
  }
  for (const name of willCreate.locations.values()) {
    const l = await prisma.workLocation.create({ data: { tenantId: t, name } })
    locMap.set(key(name), [{ id: l.id, name }])
  }
  for (const p of parsed) {
    p.unitId ??= unitMap.get(key(p.unitName))![0].id
    if (p.r.job_title && !p.positionId) p.positionId = positions.find((x) => key(x.title) === key(p.r.job_title!) && x.orgUnitId === p.unitId)?.id ?? null
    if (p.r.work_location && !p.locationId) p.locationId = locMap.get(key(p.r.work_location))![0].id
  }

  // People, one reporting level at a time so managers exist before their reports
  const byLevel = new Map<number, typeof parsed>()
  parsed.forEach((p) => byLevel.set(level(p), [...(byLevel.get(level(p)) ?? []), p]))
  for (const lv of [...byLevel.keys()].sort((a, b) => a - b)) {
    await pool(byLevel.get(lv)!, 4, async (p) => {
      const managerId = p.managerRef ? existingByRef.get(p.managerRef) ?? inFile.get(p.managerRef)?.employeeId : undefined
      try {
        const { employee } = await employeeService.create(t, {
          employeeCode: p.code, firstName: p.r.first_name!, lastName: p.r.last_name!, workEmail: p.email, hireDate: p.hireDate!, orgUnitId: p.unitId!,
          jobPositionId: p.positionId ?? undefined, workLocationId: p.locationId ?? undefined, managerId, employmentType: p.type as any,
          personalEmail: p.r.personal_email || undefined, mobilePersonal: p.r.mobile || undefined, dateOfBirth: p.dob ?? undefined,
          gender: p.r.gender || undefined, nationality: p.r.nationality || undefined, taxJurisdiction: p.r.tax_country?.toUpperCase() || undefined,
        }, actor.userId)
        p.employeeId = (employee as any).id
        const row = result.rows.find((x) => x.row === p.n)!
        Object.assign(row, { status: 'created', employeeId: p.employeeId })
        result.created++
      } catch (err: any) {
        result.rows.find((x) => x.row === p.n)!.errors.push(err?.message ?? 'could not be created')
        result.rows.find((x) => x.row === p.n)!.status = 'error'
      }
    })
  }
  await prisma.auditLog.create({ data: { tenantId: t, userId: actor.userId, action: 'EMPLOYEES_IMPORTED', entityType: 'employee', entityId: crypto.randomUUID(), newValue: { rows: parsed.length, created: result.created, mastersCreated: result.willCreate, at: now.toISOString() } } })
  if (input.grantLogin) {
    const ids = result.rows.filter((r) => r.status === 'created').map((r) => r.employeeId!)
    result.credentials = await issueCredentials(actor, ids)
  }
  return result
}

// Temporary passwords for many people at once (they must change it at first sign-in). Returned once, for the sheet.
export async function issueCredentials(actor: Actor, employeeIds: string[]): Promise<Credential[]> {
  const people = await prisma.employee.findMany({
    where: { id: { in: employeeIds }, tenantId: actor.tenantId, active: true, employmentStatus: { not: 'terminated' } },
    select: { id: true, firstName: true, lastName: true, employeeCode: true, userId: true, user: { select: { email: true } } },
  })
  if (people.length !== new Set(employeeIds).size) throw new AppError('Some people were not found or have left', 404)
  if (people.some((p) => p.userId === actor.userId)) throw new AppError('Your own password is changed from Security, not on a sheet', 400)
  const out: Credential[] = []
  await pool(people, 4, async (p) => {
    const res: any = await accessService.set(p.id, actor, { loginEnabled: true, password: 'generate' })
    out.push({ name: `${p.firstName} ${p.lastName}`, employeeCode: p.employeeCode, email: p.user.email, temporaryPassword: res.temporaryPassword })
  })
  await prisma.auditLog.create({ data: { tenantId: actor.tenantId, userId: actor.userId, action: 'CREDENTIALS_SHEET_ISSUED', entityType: 'employee', entityId: crypto.randomUUID(), newValue: { count: out.length, employeeIds } } })
  return out.sort((a, b) => a.employeeCode.localeCompare(b.employeeCode))
}

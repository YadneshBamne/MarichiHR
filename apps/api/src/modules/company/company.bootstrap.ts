import crypto from 'crypto'
import { prisma } from '../../infrastructure/database/prisma'
import { ALL_APPS, ROLE_DEFS, DEFAULT_LEAVE_TYPES, DEFAULT_ACTIVITY_TYPES, DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INPUT_TYPES } from './company.catalog'

// A new workspace is written in ONE SQL statement (data-modifying CTEs fed by a single JSON parameter), so signup costs
// one database round trip instead of ~30. Rows are complete: jsonb_populate_recordset fills missing keys with NULL,
// not column defaults, so every NOT NULL column with a default is set here explicitly.
// When a migration adds a NOT NULL column to one of these tables, add its value below (the signup test catches it).

const TABLES = [
  'tenants', 'roles', 'leave_types', 'activity_types', 'expense_categories', 'payroll_input_types', 'shift_templates',
  'resource_calendars', 'resource_calendar_days', 'org_units', 'users', 'user_roles', 'employees', 'leave_balances',
] as const
type Rows = Record<(typeof TABLES)[number], Record<string, unknown>[]>

const SQL = `WITH d AS (SELECT $1::jsonb AS j)
${TABLES.map((t, i) => `, w${i} AS (INSERT INTO "${t}" SELECT * FROM jsonb_populate_recordset(NULL::"${t}", (SELECT j->'${t}' FROM d)) RETURNING 1)`).join('\n')}
SELECT ${TABLES.map((_, i) => `(SELECT count(*) FROM w${i})`).join(' + ')} AS n`.replace('WITH d AS (SELECT $1::jsonb AS j)\n, ', 'WITH d AS (SELECT $1::jsonb AS j), ')

const LEAVE_TYPE_DEFAULTS = {
  isPaid: true, isStatutory: false, carryForward: false, allowNegative: false, encashable: false, halfDayAllowed: true,
  hourlyAllowed: false, leaveUnit: 'day', approvalLevels: 1, requiresHrForStatutory: false, sandwichRule: false, active: true,
}

// Google sign-ups have no password: passwordHash is null and googleSub links the Google account
export interface BootstrapInput { companyName: string; slug: string; email: string; fullName: string; passwordHash: string | null; googleSub?: string; avatarUrl?: string | null }

export async function bootstrapCompany(input: BootstrapInput) {
  const id = () => crypto.randomUUID()
  const now = new Date().toISOString()
  const today = now.slice(0, 10) + 'T00:00:00.000Z'
  const tenantId = id(), userId = id(), employeeId = id(), calendarId = id(), rootId = id()
  const [firstName, ...rest] = input.fullName.trim().split(/\s+/)
  const roleIds = Object.fromEntries(ROLE_DEFS.map((r) => [r.name, id()]))
  const leaveTypes = DEFAULT_LEAVE_TYPES.map((lt) => ({ ...LEAVE_TYPE_DEFAULTS, id: id(), tenantId, createdAt: now, ...lt }))

  const rows: Rows = {
    tenants: [{ id: tenantId, name: input.companyName, slug: input.slug, countryCodes: [], baseCurrency: 'USD', fiscalYearStart: `${now.slice(0, 4)}-01-01T00:00:00.000Z`, timezone: 'UTC', active: true, createdAt: now, updatedAt: now, modules: ALL_APPS, ownerUserId: userId }],
    roles: ROLE_DEFS.map((r) => ({ id: roleIds[r.name], tenantId, ...r, isSystemRole: true, createdAt: now })),
    leave_types: leaveTypes,
    activity_types: DEFAULT_ACTIVITY_TYPES.map((a) => ({ id: id(), tenantId, ...a, createdAt: now })),
    expense_categories: DEFAULT_EXPENSE_CATEGORIES.map((c) => ({ id: id(), tenantId, enforceLimit: false, active: true, createdAt: now, ...c })),
    payroll_input_types: DEFAULT_INPUT_TYPES.map((c) => ({ id: id(), tenantId, active: true, createdAt: now, ...c })),
    shift_templates: [{ id: id(), tenantId, name: 'Standard 9-6', shiftType: 'fixed', startTime: '09:00', endTime: '18:00', graceLateMinutes: 15, graceEarlyOutMinutes: 15, halfDayHours: 4, fullDayHours: 8, overtimeThresholdHours: 8, overnight: false, active: true, createdAt: now }],
    resource_calendars: [{ id: calendarId, tenantId, name: 'Standard 40h Mon-Fri', timezone: 'UTC', hoursPerWeek: 40, isFlexi: false, twoWeeksCalendar: false, active: true, createdAt: now }],
    resource_calendar_days: [0, 1, 2, 3, 4].map((d) => ({ id: id(), calendarId, dayOfWeek: d, hourFrom: 9, hourTo: 18 })),
    org_units: [{ id: rootId, tenantId, name: input.companyName, type: 'entity', active: true, createdAt: now, updatedAt: now }],
    users: [{ id: userId, tenantId, email: input.email, passwordHash: input.passwordHash, googleSub: input.googleSub ?? null, avatarUrl: input.avatarUrl ?? null, fullName: input.fullName.trim(), active: true, mfaEnabled: false, mustChangePassword: false, createdAt: now, updatedAt: now }],
    user_roles: ['employee', 'hr_admin', 'system_admin'].map((n) => ({ id: id(), userId, roleId: roleIds[n], scopeType: 'org', validFrom: now, createdAt: now })),
    employees: [{ id: employeeId, tenantId, userId, employeeCode: 'EMP0001', orgUnitId: rootId, resourceCalendarId: calendarId, firstName, lastName: rest.join(' ') || '-', workEmail: input.email, employmentType: 'full_time', employmentStatus: 'active', hireDate: today, bankVerified: false, active: true, createdAt: now, updatedAt: now }],
    leave_balances: leaveTypes.map((lt) => ({ employeeId, leaveTypeId: lt.id, balanceDays: 0, usedDays: 0, pendingDays: 0, encashedDays: 0, lapsedDays: 0, asOfDate: now })),
  }

  await prisma.$queryRawUnsafe(SQL, JSON.stringify(rows))
  return { tenantId, userId }
}

import crypto from 'crypto'
import mongoose from 'mongoose'
import { ROLE_DEFS, ALL_APPS, DEFAULT_LEAVE_TYPES, DEFAULT_ACTIVITY_TYPES, DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INPUT_TYPES } from './company.catalog'
import {
  connectMongo, syncMongoIndexes, Tenant, Role, User, OrgUnit, Employee, LeaveType, ActivityType, ExpenseCategory,
  PayrollInputType, ShiftTemplate, ResourceCalendar, LeaveBalance,
} from '../../infrastructure/mongo/mongo'

// MongoDB version of bootstrapCompany: the whole workspace is written in one transaction (all or nothing), one
// insertMany per collection. Same inputs and outputs as company.bootstrap.ts, which stays the Postgres version.

const LEAVE_TYPE_DEFAULTS = {
  isPaid: true, isStatutory: false, carryForward: false, allowNegative: false, allowOverBalance: true, encashable: false, halfDayAllowed: true,
  hourlyAllowed: false, leaveUnit: 'day', approvalLevels: 1, requiresHrForStatutory: false, sandwichRule: false, active: true,
}

export interface BootstrapInput { companyName: string; slug: string; email: string; fullName: string; passwordHash: string | null; googleSub?: string; avatarUrl?: string | null }

export async function bootstrapCompany(input: BootstrapInput) {
  const id = () => crypto.randomUUID()
  const now = new Date()
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
  const tenantId = id(), userId = id(), employeeId = id(), calendarId = id(), rootId = id()
  const [firstName, ...rest] = input.fullName.trim().split(/\s+/)
  const roles = ROLE_DEFS.map((r) => ({ _id: id(), tenantId, ...r, isSystemRole: true }))
  const roleByName = Object.fromEntries(roles.map((r) => [r.name, r]))
  const leaveTypes = DEFAULT_LEAVE_TYPES.map((lt) => ({ ...LEAVE_TYPE_DEFAULTS, _id: id(), tenantId, ...lt }))
  const withTenant = <T extends object>(rows: T[], extra: object = {}) => rows.map((r) => ({ _id: id(), tenantId, ...extra, ...r }))

  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const o = { session }
      await Tenant.create([{
        _id: tenantId, name: input.companyName, slug: input.slug, countryCodes: [], baseCurrency: 'USD', timezone: 'UTC',
        fiscalYearStart: new Date(`${now.getUTCFullYear()}-01-01T00:00:00.000Z`), active: true, modules: ALL_APPS, ownerUserId: userId,
        employeeCodePrefix: 'EMP', employeeCodeDigits: 4,
      }], o)
      await Role.insertMany(roles, o)
      await LeaveType.insertMany(leaveTypes, o)
      await ActivityType.insertMany(withTenant(DEFAULT_ACTIVITY_TYPES), o)
      await ExpenseCategory.insertMany(withTenant(DEFAULT_EXPENSE_CATEGORIES, { enforceLimit: false, active: true }), o)
      await PayrollInputType.insertMany(withTenant(DEFAULT_INPUT_TYPES, { active: true }), o)
      await ShiftTemplate.insertMany(withTenant([{
        name: 'Standard 9-6', shiftType: 'fixed', startTime: '09:00', endTime: '18:00', graceLateMinutes: 15, graceEarlyOutMinutes: 15,
        halfDayHours: 4, fullDayHours: 8, overtimeThresholdHours: 8, overnight: false, active: true,
      }]), o)
      // the calendar's working days are embedded (was resource_calendar_days)
      await ResourceCalendar.insertMany([{
        _id: calendarId, tenantId, name: 'Standard 40h Mon-Fri', timezone: 'UTC', hoursPerWeek: 40, isFlexi: false, twoWeeksCalendar: false, active: true,
        days: [0, 1, 2, 3, 4].map((d) => ({ dayOfWeek: d, hourFrom: 9, hourTo: 18 })),
      }], o)
      await OrgUnit.insertMany([{ _id: rootId, tenantId, name: input.companyName, type: 'entity', active: true }], o)
      await User.create([{
        _id: userId, tenantId, email: input.email, passwordHash: input.passwordHash, googleSub: input.googleSub ?? undefined,
        avatarUrl: input.avatarUrl ?? undefined, fullName: input.fullName.trim(), active: true, mfaEnabled: false, mustChangePassword: false,
        notifyPrefs: {}, hrScopeUnitIds: [],
        userRoles: ['employee', 'hr_admin', 'system_admin'].map((n) => ({ roleId: roleByName[n]._id, roleName: n, scopeType: 'org', validFrom: now })),
      }], o)
      await Employee.insertMany([{
        _id: employeeId, tenantId, userId, employeeCode: 'EMP0001', orgUnitId: rootId, resourceCalendarId: calendarId, firstName,
        lastName: rest.join(' ') || '-', workEmail: input.email, employmentType: 'full_time', employmentStatus: 'active', hireDate: today,
        bankVerified: false, active: true,
      }], o)
      await LeaveBalance.insertMany(leaveTypes.map((lt) => ({
        _id: id(), employeeId, leaveTypeId: lt._id, balanceDays: 0, usedDays: 0, pendingDays: 0, encashedDays: 0, lapsedDays: 0, asOfDate: now,
      })), o)
    })
  } finally {
    await session.endSession()
  }
  return { tenantId, userId }
}

// Self-check: npx ts-node --files src/modules/company/company.bootstrap.mongo.ts  (needs MONGO_URI; writes one workspace, then deletes it)
if (require.main === module) {
  ;(async () => {
    await connectMongo()
    await syncMongoIndexes()
    const slug = `selfcheck-${Date.now()}`
    const { tenantId, userId } = await bootstrapCompany({ companyName: 'Selfcheck Ltd', slug, email: `${slug}@example.com`, fullName: 'Self Check', passwordHash: 'x' })
    const count = (m: mongoose.Model<any>, q: object) => m.countDocuments(q)
    console.assert((await count(Tenant, { _id: tenantId })) === 1, 'tenant created')
    console.assert((await count(Role, { tenantId })) === ROLE_DEFS.length, 'all roles created')
    console.assert((await count(Employee, { tenantId, employeeCode: 'EMP0001' })) === 1, 'owner employee created')
    const u: any = await User.findById(userId).lean()
    console.assert(u.userRoles.map((r: any) => r.roleName).sort().join() === 'employee,hr_admin,system_admin', 'owner has 3 roles')
    console.assert((await count(LeaveType, { tenantId })) === DEFAULT_LEAVE_TYPES.length, 'leave types created')
    console.assert((await count(ResourceCalendar, { tenantId, 'days.4': { $exists: true } })) === 1, 'calendar has 5 days')
    // duplicate slug must be rejected and leave nothing behind (transaction rolled back)
    const before = await count(User, {})
    let rejected = false
    try { await bootstrapCompany({ companyName: 'Dup', slug, email: 'dup@example.com', fullName: 'Dup User', passwordHash: 'x' }) } catch { rejected = true }
    console.assert(rejected && (await count(User, {})) === before, 'duplicate slug rejected and rolled back')
    await LeaveBalance.deleteMany({ employeeId: (await Employee.findOne({ tenantId }))?._id })
    for (const m of [Role, User, OrgUnit, Employee, LeaveType, ActivityType, ExpenseCategory, PayrollInputType, ShiftTemplate, ResourceCalendar]) await m.deleteMany({ tenantId })
    await Tenant.deleteOne({ _id: tenantId })
    console.log('bootstrap self-check done')
    await mongoose.disconnect()
  })().catch((e) => { console.error(e); process.exit(1) })
}

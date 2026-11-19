import crypto from 'crypto'
import mongoose, { Schema, SchemaDefinition } from 'mongoose'

// MongoDB (Atlas) data layer. Collections keep the names of the old SQL tables and ids stay UUID strings, so API
// responses are unchanged: toJSON turns _id into id and drops __v.
// ponytail: strict:false "loose" models for collections whose module is not ported yet; give each a real schema when its stage is done.

export async function connectMongo() {
  if (mongoose.connection.readyState === 1) return mongoose
  const uri = process.env.MONGO_URI
  if (!uri) throw new Error('MONGO_URI is not set')
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB || 'marichihr', serverSelectionTimeoutMS: 20000 })
  return mongoose
}

const uuid = () => crypto.randomUUID()

function build(def: SchemaDefinition, strict: boolean) {
  const s = new Schema<any>({ _id: { type: String, default: uuid }, ...def }, { timestamps: true, strict, versionKey: false })
  s.set('toJSON', { virtuals: false, transform: (_d, r: any) => { r.id = r._id; delete r._id; return r } })
  return s
}

function model<T = any>(name: string, collection: string, def: SchemaDefinition, indexes: Array<[Record<string, 1 | -1>, Record<string, unknown>?]> = [], strict = true) {
  const s = build(def, strict)
  for (const [spec, opts] of indexes) s.index(spec, opts)
  return (mongoose.models[name] as mongoose.Model<T>) || mongoose.model<any>(name, s, collection) as mongoose.Model<T>
}

const S = String, B = Boolean, D = Date, N = Number

export const Tenant = model('Tenant', 'tenants', {
  name: { type: S, required: true }, slug: { type: S, required: true }, countryCodes: { type: [S], default: [] },
  baseCurrency: { type: S, default: 'USD' }, fiscalYearStart: { type: D, required: true }, timezone: { type: S, default: 'UTC' },
  logoUrl: S, ssoProvider: S, legalName: S, industry: S, companySize: S, primaryCountry: S,
  modules: { type: [S], default: [] }, employeeCodePrefix: { type: S, default: 'EMP' }, employeeCodeDigits: { type: N, default: 4 },
  ownerUserId: S, onboardedAt: D, active: { type: B, default: true }, payrollSignoffAbove: Schema.Types.Decimal128,
}, [[{ slug: 1 }, { unique: true }]])

export const Role = model('Role', 'roles', {
  tenantId: { type: S, required: true }, name: { type: S, required: true }, description: S, isSystemRole: { type: B, default: false },
}, [[{ tenantId: 1, name: 1 }, { unique: true }]])

// A user's roles are embedded (no join); roleName is kept next to roleId because the JWT carries role NAMES.
const UserRoleSub = new Schema<any>({
  _id: { type: S, default: uuid }, roleId: { type: S, required: true }, roleName: { type: S, required: true }, scopeType: S, scopeId: S,
  validFrom: { type: D, default: Date.now }, validUntil: D, delegatedBy: S, createdAt: { type: D, default: Date.now },
})

export const User = model('User', 'users', {
  tenantId: { type: S, required: true }, email: { type: S, required: true }, passwordHash: S, fullName: { type: S, required: true },
  phone: S, avatarUrl: S, active: { type: B, default: true }, archivedAt: D, archivedBy: S, archiveReason: S, lastLoginAt: D,
  mfaEnabled: { type: B, default: false }, mfaSecret: S, mfaLastStep: N, googleSub: S, tourDoneAt: D,
  mustChangePassword: { type: B, default: false }, locale: S, hrScopeUnitIds: { type: [S], default: [] },
  notifyPrefs: { type: Schema.Types.Mixed, default: {} }, userRoles: { type: [UserRoleSub], default: [] },
}, [
  [{ tenantId: 1, email: 1 }, { unique: true }],
  // unique only when a Google account is linked (many users have none)
  [{ tenantId: 1, googleSub: 1 }, { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } }],
])

export const OrgUnit = model('OrgUnit', 'org_units', {
  tenantId: { type: S, required: true }, name: { type: S, required: true }, type: { type: S, required: true },
  parentId: S, managerId: S, active: { type: B, default: true },
}, [[{ tenantId: 1 }]], false)

// Core employee fields; the 360 sub-records (addresses, family, documents...) join in the employees step.
export const Employee = model('Employee', 'employees', {
  tenantId: { type: S, required: true }, userId: { type: S, required: true }, employeeCode: { type: S, required: true },
  orgUnitId: { type: S, required: true }, jobPositionId: S, managerId: S, resourceCalendarId: S, workLocationId: S,
  taxJurisdiction: S, legalEntityId: S, payGroupId: S,
  firstName: { type: S, required: true }, lastName: { type: S, required: true }, dateOfBirth: D, gender: S, nationality: S,
  personalEmail: S, workEmail: S, mobilePersonal: S, mobileWork: S,
  employmentType: { type: S, default: 'full_time' }, employmentStatus: { type: S, default: 'active' },
  hireDate: { type: D, required: true }, probationEndDate: D, confirmationDate: D, exitDate: D, exitReason: S,
  customFields: Schema.Types.Mixed, bankName: S, bankAccountNo: S, bankIfscSwift: S, bankVerified: { type: B, default: false },
  bankVerifiedBy: S, bankVerifiedAt: D, active: { type: B, default: true }, archivedAt: D, archivedBy: S, archiveReason: S,
}, [
  [{ tenantId: 1, employeeCode: 1 }, { unique: true }],
  [{ userId: 1 }, { unique: true }],
  [{ tenantId: 1, managerId: 1 }],
], false)

export const RefreshToken = model('RefreshToken', 'refresh_tokens', {
  userId: { type: S, required: true }, token: { type: S, required: true }, expiresAt: { type: D, required: true }, revokedAt: D,
}, [[{ token: 1 }, { unique: true }], [{ expiresAt: 1 }, { expireAfterSeconds: 0 }]])

// Collections that signup fills but whose modules are ported later
const loose = (name: string, collection: string) => model(name, collection, {}, [], false)
export const LeaveType = loose('LeaveType', 'leave_types')
export const ActivityType = loose('ActivityType', 'activity_types')
export const ExpenseCategory = loose('ExpenseCategory', 'expense_categories')
export const PayrollInputType = loose('PayrollInputType', 'payroll_input_types')
export const ShiftTemplate = loose('ShiftTemplate', 'shift_templates')
export const ResourceCalendar = loose('ResourceCalendar', 'resource_calendars')
export const LeaveBalance = loose('LeaveBalance', 'leave_balances')
export const JobPosition = loose('JobPosition', 'job_positions')
export const AuditLog = loose('AuditLog', 'audit_logs')
export const WorkLocation = loose('WorkLocation', 'work_locations')
export const LegalEntity = loose('LegalEntity', 'legal_entities')
export const PayGroup = loose('PayGroup', 'pay_groups')
export const DomainEvent = loose('DomainEvent', 'domain_events')
export const PositionHistory = loose('PositionHistory', 'employee_position_history')

export const ALL_MODELS = [Tenant, Role, User, OrgUnit, Employee, RefreshToken, LeaveType, ActivityType, ExpenseCategory, PayrollInputType, ShiftTemplate, ResourceCalendar, LeaveBalance, JobPosition, AuditLog, WorkLocation, LegalEntity, PayGroup, DomainEvent, PositionHistory]

// Create collections and indexes up front (needed before the first transaction writes to them)
export async function syncMongoIndexes() {
  for (const m of ALL_MODELS) { await m.createCollection().catch(() => undefined); await m.syncIndexes() }
}

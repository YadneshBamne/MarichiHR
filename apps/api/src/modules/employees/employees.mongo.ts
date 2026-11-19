import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { CreateEmployeeDto, UpdateEmployeeDto } from './employees.types'
import { UpdateEmployeeSchema } from './employees.schema'
import { AppError } from '../../shared/utils/AppError'
import { buildMeta, getPagination } from '../../shared/utils/pagination'
import { encryptField, decryptField, last4 } from '../../shared/utils/crypto'
import { AccessUser } from '../../shared/utils/access'
import { assertProfileAccess, getReportingSubtreeIds, hrScope, clearHrScope } from '../../shared/utils/access.mongo'
import {
  connectMongo, syncMongoIndexes, Tenant, Role, User, OrgUnit, Employee, RefreshToken, JobPosition, AuditLog, WorkLocation, LegalEntity,
  PayGroup, DomainEvent, PositionHistory, LeaveType, LeaveBalance, ResourceCalendar,
} from '../../infrastructure/mongo/mongo'

// MongoDB version of the core of employees.service.ts / employees.repository.ts: directory, profile, create, update,
// bank details, archive, login access and the org chart. Same rules and response shapes.
// Not ported yet (kept on Postgres until their stage): org unit / job position / work location editing, skills and resume
// lines, masters validation (assertMasters), the mandatory-field check, and publishing events to the queue (events are recorded
// in domain_events only).
// ponytail: employee code collisions are caught by the unique index and retried, as in the SQL version.

const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }
const ids = (rows: any[], k: string) => [...new Set(rows.map((r) => r[k]).filter(Boolean))] as string[]
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const col = (name: string) => mongoose.connection.collection(name)
const audit = (a: Record<string, unknown>) => AuditLog.create(a)
const hasAnyRole = (user: AccessUser, ...roles: string[]) => roles.some((r) => user.roleIds.includes(r))
const CI = { locale: 'en', strength: 2 } as const

const LIST_USER = 'email avatarUrl lastLoginAt'

// Everything a list row or profile needs from other collections, looked up in a few batched queries
async function related(emps: any[], full = false) {
  const [users, units, jobs, locs, mgrs] = await Promise.all([
    User.find({ _id: { $in: ids(emps, 'userId') } }).lean() as Promise<any[]>,
    OrgUnit.find({ _id: { $in: ids(emps, 'orgUnitId') } }).lean() as Promise<any[]>,
    JobPosition.find({ _id: { $in: ids(emps, 'jobPositionId') } }).lean() as Promise<any[]>,
    WorkLocation.find({ _id: { $in: ids(emps, 'workLocationId') } }).lean() as Promise<any[]>,
    Employee.find({ _id: { $in: ids(emps, 'managerId') } }).lean() as Promise<any[]>,
  ])
  const mgrUsers: any[] = await User.find({ _id: { $in: ids(mgrs, 'userId') } }).select('fullName avatarUrl').lean()
  const by = (rows: any[]) => new Map(rows.map((r) => [r._id, r]))
  const U = by(users), O = by(units), J = by(jobs), L = by(locs), M = by(mgrs), MU = by(mgrUsers)
  return (e: any) => {
    const u = U.get(e.userId), o = O.get(e.orgUnitId), j = J.get(e.jobPositionId), l = L.get(e.workLocationId), m = M.get(e.managerId)
    const mu = m && MU.get(m.userId)
    return {
      ...ser(e),
      user: u && (full ? { id: u._id, email: u.email, avatarUrl: u.avatarUrl, lastLoginAt: u.lastLoginAt, mfaEnabled: u.mfaEnabled, userRoles: (u.userRoles || []).map((r: any) => ({ role: { id: r.roleId, name: r.roleName } })) } : { email: u.email, avatarUrl: u.avatarUrl, lastLoginAt: u.lastLoginAt }),
      orgUnit: o && { id: o._id, name: o.name, type: o.type },
      jobPosition: j && { id: j._id, title: j.title, ...(full && { gradeBand: j.gradeBand }) },
      workLocation: l ? (full ? ser(l) : { id: l._id, name: l.name, city: l.city }) : null,
      manager: m ? { ...ser(m), user: mu && { fullName: mu.fullName, avatarUrl: mu.avatarUrl } } : null,
    }
  }
}

export const employeeRepository = {
  async list(tenantId: string, o: { page?: number; limit?: number; search?: string; orgUnitId?: string; employmentType?: string; employmentStatus?: string; showArchived?: boolean; ids?: string[] }) {
    const { skip, take, page, limit } = getPagination(o)
    const re = o.search && new RegExp(esc(o.search), 'i')
    const where: any = {
      tenantId, ...(o.ids && { _id: { $in: o.ids } }), ...(!o.showArchived && { active: true }),
      ...(o.orgUnitId && { orgUnitId: o.orgUnitId }), ...(o.employmentType && { employmentType: o.employmentType }), ...(o.employmentStatus && { employmentStatus: o.employmentStatus }),
      ...(re && { $or: [{ firstName: re }, { lastName: re }, { workEmail: re }, { employeeCode: re }] }),
    }
    const [rows, total] = await Promise.all([
      Employee.find(where).collation(CI).sort({ firstName: 1, lastName: 1 }).skip(skip).limit(take).lean() as Promise<any[]>,
      Employee.countDocuments(where),
    ])
    const build = await related(rows)
    return { employees: rows.map(build), total, page, limit }
  },

  async findById(id: string, tenantId: string) {
    const e: any = await Employee.findOne({ _id: id, tenantId }).lean()
    if (!e) return null
    const [build, calendar, reports, contracts, nContracts, nLeave, nAtt] = await Promise.all([
      related([e], true),
      e.resourceCalendarId ? ResourceCalendar.findById(e.resourceCalendarId).lean() : null,
      Employee.find({ tenantId, managerId: id, active: true }).lean() as Promise<any[]>,
      col('employee_contracts').find({ employeeId: id, active: true }).sort({ effectiveFrom: -1 }).limit(1).toArray(),
      col('employee_contracts').countDocuments({ employeeId: id }),
      col('leave_requests').countDocuments({ employeeId: id }),
      col('attendance_records').countDocuments({ employeeId: id }),
    ])
    const rb = await related(reports)
    const row = build(e)
    return {
      ...row,
      resourceCalendar: calendar && { ...ser(calendar), days: (calendar as any).days ?? [] },
      directReports: reports.map((r) => { const x = rb(r); return { ...x, user: x.user && { fullName: undefined, avatarUrl: x.user.avatarUrl }, jobPosition: x.jobPosition && { title: x.jobPosition.title } } }),
      contracts: contracts.map(ser),
      skills: [], resumeLines: [],
      _count: { contracts: nContracts, leaveRequests: nLeave, attendanceRecords: nAtt },
    }
  },

  async generateEmployeeCodes(tenantId: string, count = 1): Promise<string[]> {
    const t: any = await Tenant.findById(tenantId).select('employeeCodePrefix employeeCodeDigits').lean()
    const prefix = t?.employeeCodePrefix ?? 'EMP'
    const rows: any[] = await Employee.find({ tenantId, employeeCode: new RegExp(`^${esc(prefix)}\\d+$`) }).select('employeeCode').lean()
    const max = rows.reduce((m, r) => Math.max(m, Number(r.employeeCode.slice(prefix.length))), 0)
    return Array.from({ length: count }, (_, i) => `${prefix}${String(max + 1 + i).padStart(t?.employeeCodeDigits ?? 4, '0')}`)
  },
}

// Every id a client supplies must point at a record in the caller's own tenant
export async function assertRefsInTenant(tenantId: string, refs: { parentOrgUnitId?: string; orgUnitId?: string; jobPositionId?: string; managerId?: string; workLocationId?: string; resourceCalendarId?: string; legalEntityId?: string | null; payGroupId?: string | null }) {
  const checks: [string | null | undefined, string, mongoose.Model<any>, object?][] = [
    [refs.parentOrgUnitId, 'Parent org unit', OrgUnit], [refs.orgUnitId, 'Org unit', OrgUnit], [refs.jobPositionId, 'Job position', JobPosition],
    [refs.managerId, 'Manager', Employee], [refs.workLocationId, 'Work location', WorkLocation], [refs.resourceCalendarId, 'Resource calendar', ResourceCalendar],
    [refs.legalEntityId, 'Legal entity', LegalEntity, { active: true }], [refs.payGroupId, 'Pay group', PayGroup, { active: true }],
  ]
  const present = checks.filter(([v]) => v)
  const found = await Promise.all(present.map(([v, , m, extra]) => m.exists({ _id: v, tenantId, ...extra })))
  const missing = present.find((_, i) => !found[i])
  if (missing) throw new AppError(`${missing[1]} not found`, 404)
}

function toSafeEmployee<T extends Record<string, any>>(employee: T) {
  const { bankAccountNo, ...rest } = employee
  let bankAccountLast4: string | null = null
  if (bankAccountNo) {
    try { bankAccountLast4 = last4(decryptField(bankAccountNo)) } catch { console.warn(`[bank] could not decrypt account number for employee ${rest.id}`) }
  }
  return { ...rest, bankAccountLast4 }
}

const UPDATABLE_FIELDS = new Set(Object.keys(UpdateEmployeeSchema.shape.body.shape))

function shapeEmployeeForViewer(employee: Record<string, any>, user: AccessUser) {
  const self = !!user.employeeId && user.employeeId === employee.id
  const canCompensation = self || hasAnyRole(user, 'payroll_admin', 'compliance_officer')
  const canBank = self || hasAnyRole(user, 'hr_admin', 'payroll_admin')
  const safe: Record<string, any> = toSafeEmployee(employee)
  if (!canCompensation) delete safe.contracts
  if (!canBank) for (const key of ['bankAccountLast4', 'bankName', 'bankIfscSwift', 'bankVerified', 'bankVerifiedBy', 'bankVerifiedAt']) delete safe[key]
  return safe
}

const dateOnly = (v?: string | null) => (v ? new Date(v.slice(0, 10) + 'T00:00:00.000Z') : undefined)
const PLACEMENT = ['orgUnitId', 'jobPositionId', 'managerId', 'workLocationId', 'employmentType']
const history = (employeeId: string, tenantId: string, by: string, fields: Record<string, unknown>, from: Date, reason: string) =>
  ({ _id: crypto.randomUUID(), employeeId, tenantId, changedBy: by, effectiveFrom: from, reason, appliedAt: new Date(), createdAt: new Date(), ...Object.fromEntries(PLACEMENT.filter((k) => fields[k] != null).map((k) => [k, fields[k]])) })
const event = (tenantId: string, type: string, payload: object) => ({ _id: crypto.randomUUID(), tenantId, type, payload, status: 'pending', createdAt: new Date() })

export const employeeService = {
  async list(tenantId: string, query: any, user: AccessUser) {
    let idList: string[] | undefined
    if (!hasAnyRole(user, 'hr_admin', 'payroll_admin', 'compliance_officer')) {
      if (!user.roleIds.includes('manager') || !user.employeeId) throw new AppError('You do not have access to the employee directory', 403)
      idList = [user.employeeId, ...(await getReportingSubtreeIds(user.employeeId, tenantId))]
    }
    const units = !hasAnyRole(user, 'payroll_admin', 'compliance_officer') ? await hrScope(user) : null
    if (units) {
      const inUnits: any[] = await Employee.find({ tenantId, orgUnitId: { $in: [...units] } }).select('_id').lean()
      idList = [...new Set([...inUnits.map((e) => e._id as string), ...(user.employeeId ? [user.employeeId] : [])])]
    }
    const result = await employeeRepository.list(tenantId, {
      page: parseInt(query.page) || 1, limit: parseInt(query.limit) || 25, search: query.search, orgUnitId: query.orgUnitId,
      employmentType: query.employmentType, employmentStatus: query.employmentStatus, showArchived: query.showArchived === 'true', ids: idList,
    })
    return { data: result.employees.map((e: any) => shapeEmployeeForViewer(e, user)), meta: buildMeta(result.total, result.page, result.limit) }
  },

  async getById(id: string, tenantId: string, user: AccessUser) {
    await assertProfileAccess(user, id)
    const employee = await employeeRepository.findById(id, tenantId)
    if (!employee) throw new AppError('Employee not found', 404)
    return shapeEmployeeForViewer(employee, user)
  },

  async create(tenantId: string, data: CreateEmployeeDto, createdBy: string) {
    const [existing, , [generated], employeeRole, leaveTypes, defaultCalendar]: any[] = await Promise.all([
      User.exists({ tenantId, email: data.workEmail }).collation(CI),
      assertRefsInTenant(tenantId, { orgUnitId: data.orgUnitId, jobPositionId: data.jobPositionId, managerId: data.managerId, workLocationId: data.workLocationId, legalEntityId: (data as any).legalEntityId, payGroupId: (data as any).payGroupId, resourceCalendarId: data.resourceCalendarId }),
      employeeRepository.generateEmployeeCodes(tenantId, 1),
      Role.findOne({ tenantId, name: 'employee' }).lean(),
      LeaveType.find({ tenantId, active: true }).select('_id').lean(),
      data.resourceCalendarId ? null : ResourceCalendar.findOne({ tenantId, active: true }).sort({ createdAt: 1 }).select('_id').lean(),
    ])
    if (existing) throw new AppError('An employee with this email already exists', 409)
    const calendarId = data.resourceCalendarId ?? defaultCalendar?._id
    const userId = crypto.randomUUID(), employeeId = crypto.randomUUID()
    const hireDate = dateOnly(data.hireDate)!
    const fullName = `${data.firstName} ${data.lastName}`
    let code = data.employeeCode ?? generated
    for (let attempt = 0; ; attempt++) {
      const session = await mongoose.startSession()
      try {
        await session.withTransaction(async () => {
          const o = { session }
          await User.create([{ _id: userId, tenantId, email: data.workEmail, fullName, passwordHash: null, active: true, mfaEnabled: false, mustChangePassword: false, notifyPrefs: {}, hrScopeUnitIds: [],
            userRoles: employeeRole ? [{ roleId: employeeRole._id, roleName: 'employee', scopeType: 'org', validFrom: new Date() }] : [] }], o)
          await Employee.create([{
            _id: employeeId, tenantId, userId, employeeCode: code, orgUnitId: data.orgUnitId, jobPositionId: data.jobPositionId, managerId: data.managerId, resourceCalendarId: calendarId,
            workLocationId: data.workLocationId, legalEntityId: (data as any).legalEntityId, payGroupId: (data as any).payGroupId, taxJurisdiction: data.taxJurisdiction,
            firstName: data.firstName, lastName: data.lastName, workEmail: data.workEmail, personalEmail: data.personalEmail, dateOfBirth: dateOnly(data.dateOfBirth), gender: data.gender,
            nationality: data.nationality, mobilePersonal: data.mobilePersonal, mobileWork: data.mobileWork, emergencyContactName: data.emergencyContactName,
            emergencyContactPhone: data.emergencyContactPhone, emergencyContactRelation: data.emergencyContactRelation, employmentType: data.employmentType ?? 'full_time',
            employmentStatus: 'active', hireDate, bankVerified: false, active: true,
          }], o)
          await PositionHistory.insertMany([history(employeeId, tenantId, createdBy, data as any, hireDate, 'Joined')], o)
          if (leaveTypes.length) await LeaveBalance.insertMany(leaveTypes.map((lt: any) => ({ _id: crypto.randomUUID(), employeeId, leaveTypeId: lt._id, balanceDays: 0, usedDays: 0, pendingDays: 0, encashedDays: 0, lapsedDays: 0, asOfDate: new Date() })), o)
          await DomainEvent.insertMany([event(tenantId, 'employee.created', { employeeId, employeeCode: code, name: fullName, email: data.workEmail, createdBy })], o)
        })
        break
      } catch (err: any) {
        const key = Object.keys(err?.keyPattern ?? {})
        if (err?.code === 11000 && key.includes('email')) throw new AppError('An employee with this email already exists', 409)
        if (err?.code !== 11000 || !key.includes('employeeCode') || attempt >= 4) throw err
        if (data.employeeCode) throw new AppError(`Employee ID ${code} is already used`, 409)
        code = code.replace(/\d+$/, (d: string) => String(Number(d) + 1 + attempt).padStart(d.length, '0'))
      } finally {
        await session.endSession()
      }
    }
    await audit({ tenantId, userId: createdBy, action: 'EMPLOYEE_CREATED', entityType: 'employee', entityId: employeeId, newValue: { employeeCode: code, name: fullName } })
    const created: any = await Employee.findById(employeeId).lean()
    return { employee: toSafeEmployee(ser(created)), message: 'Employee created. Grant login access to let them sign in.' }
  },

  async update(id: string, tenantId: string, data: UpdateEmployeeDto, updatedBy: string) {
    const employee: any = await Employee.findOne({ _id: id, tenantId }).lean()
    if (!employee) throw new AppError('Employee not found', 404)
    const safe = Object.fromEntries(Object.entries(data).filter(([k]) => UPDATABLE_FIELDS.has(k))) as any
    if (safe.managerId === id) throw new AppError('An employee cannot be their own manager', 400)
    await assertRefsInTenant(tenantId, { orgUnitId: safe.orgUnitId, jobPositionId: safe.jobPositionId, managerId: safe.managerId, workLocationId: safe.workLocationId, resourceCalendarId: safe.resourceCalendarId, legalEntityId: safe.legalEntityId, payGroupId: safe.payGroupId })
    const set: any = { ...safe }
    for (const k of ['dateOfBirth', 'probationEndDate', 'confirmationDate']) if (safe[k]) set[k] = new Date(safe[k])
    const updated: any = await Employee.findOneAndUpdate({ _id: id, tenantId }, { $set: set }, { returnDocument: 'after' }).lean()

    const show = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ?? null)
    const changed = Object.keys(safe).filter((k) => String(show(employee[k])) !== String(show(safe[k])))
    if (changed.length) {
      await audit({ tenantId, userId: updatedBy, action: 'EMPLOYEE_UPDATED', entityType: 'employee', entityId: id,
        oldValue: Object.fromEntries(changed.map((k) => [k, show(employee[k])])), newValue: Object.fromEntries(changed.map((k) => [k, show(safe[k])])) })
    }
    if (changed.some((k) => PLACEMENT.includes(k))) {
      const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)
      await PositionHistory.create(history(id, tenantId, updatedBy, safe, today, 'Profile edit'))
    }
    await DomainEvent.create(event(tenantId, 'employee.updated', { employeeId: id, updatedBy, changes: Object.keys(safe) }))
    return toSafeEmployee(ser(updated))
  },

  async updateBank(id: string, tenantId: string, userId: string, dto: { bankName: string; bankAccountNo: string; bankIfscSwift?: string }) {
    const updated: any = await Employee.findOneAndUpdate({ _id: id, tenantId },
      { $set: { bankName: dto.bankName, bankAccountNo: encryptField(dto.bankAccountNo), bankIfscSwift: dto.bankIfscSwift ?? null, bankVerified: false, bankVerifiedBy: null, bankVerifiedAt: null } }, { returnDocument: 'after' }).lean()
    if (!updated) throw new AppError('Employee not found', 404)
    await audit({ tenantId, userId, action: 'BANK_DETAILS_UPDATED', entityType: 'employee', entityId: id, newValue: { bankName: dto.bankName, last4: last4(dto.bankAccountNo) } })
    return toSafeEmployee(ser(updated))
  },

  // Maker-checker: a different user than the one who entered the details must verify them
  async verifyBank(id: string, tenantId: string, userId: string) {
    const employee: any = await Employee.findOne({ _id: id, tenantId }).lean()
    if (!employee) throw new AppError('Employee not found', 404)
    if (!employee.bankAccountNo || !employee.bankName) throw new AppError('This employee has no bank details to verify', 400)
    const lastWrite: any = await AuditLog.findOne({ tenantId, entityType: 'employee', entityId: id, action: 'BANK_DETAILS_UPDATED' }).sort({ createdAt: -1 }).lean()
    if (lastWrite?.userId === userId) throw new AppError('Bank details must be verified by a different user than the one who entered them', 403)
    const updated: any = await Employee.findOneAndUpdate({ _id: id, tenantId }, { $set: { bankVerified: true, bankVerifiedBy: userId, bankVerifiedAt: new Date() } }, { returnDocument: 'after' }).lean()
    await audit({ tenantId, userId, action: 'BANK_DETAILS_VERIFIED', entityType: 'employee', entityId: id, newValue: { bankName: employee.bankName } })
    return toSafeEmployee(ser(updated))
  },

  async archive(id: string, tenantId: string, archivedBy: string, reason: string) {
    const employee: any = await Employee.findOne({ _id: id, tenantId }).lean()
    if (!employee) throw new AppError('Employee not found', 404)
    if (!employee.active) throw new AppError('Employee is already archived', 400)
    const archived: any = await Employee.findOneAndUpdate({ _id: id, tenantId }, { $set: { active: false, archivedAt: new Date(), archivedBy, archiveReason: reason, employmentStatus: 'terminated' } }, { returnDocument: 'after' }).lean()
    await RefreshToken.updateMany({ userId: employee.userId, revokedAt: null }, { revokedAt: new Date() })
    await audit({ tenantId, userId: archivedBy, action: 'EMPLOYEE_ARCHIVED', entityType: 'employee', entityId: id, newValue: { reason } })
    await DomainEvent.create(event(tenantId, 'employee.archived', { employeeId: id, archivedBy, reason }))
    return toSafeEmployee(ser(archived))
  },
}

// ─── Login access (who can sign in, with which roles) ─────────────────────────
const randomPassword = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const body = Array.from(crypto.randomBytes(14), (b) => alphabet[b % alphabet.length]).join('')
  return body.slice(0, 4) + '-' + body.slice(4, 9) + '-' + body.slice(9) + '7'
}

export const accessService = {
  async get(employeeId: string, tenantId: string) {
    const emp: any = await Employee.findOne({ _id: employeeId, tenantId }).select('userId').lean()
    if (!emp) throw new AppError('Employee not found', 404)
    const u: any = await User.findById(emp.userId).lean()
    return {
      email: u.email, loginEnabled: u.active && (!!u.passwordHash || !!u.googleSub), active: u.active, hasPassword: !!u.passwordHash,
      googleLinked: !!u.googleSub, mfaEnabled: u.mfaEnabled, mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt,
      roles: (u.userRoles || []).map((r: any) => r.roleName), hrScopeUnitIds: u.hrScopeUnitIds ?? [],
    }
  },

  async set(employeeId: string, actor: { tenantId: string; userId: string; roleIds: string[] }, body: { roles?: string[]; loginEnabled?: boolean; password?: 'generate' | string; hrScopeUnitIds?: string[] }) {
    const emp: any = await Employee.findOne({ _id: employeeId, tenantId: actor.tenantId }).select('userId employmentStatus').lean()
    if (!emp) throw new AppError('Employee not found', 404)
    const [target, catalogue]: any[] = await Promise.all([User.findById(emp.userId).lean(), Role.find({ tenantId: actor.tenantId }).select('name').lean()])
    const isSys = actor.roleIds.includes('system_admin')
    const self = emp.userId === actor.userId
    const currentNames: string[] = (target.userRoles || []).map((r: any) => r.roleName)

    let roles = body.roles
    if (roles) {
      roles = [...new Set(['employee', ...roles])]
      const touched = ['system_admin', 'compliance_officer'].filter((r) => roles!.includes(r) !== currentNames.includes(r))
      if (touched.length && !isSys) throw new AppError('Only a system administrator can change system or compliance roles', 403)
      if (self && currentNames.some((r) => ['hr_admin', 'system_admin'].includes(r) && !roles!.includes(r))) throw new AppError('You cannot remove your own admin access', 400)
    }
    if (body.loginEnabled === false && self) throw new AppError('You cannot disable your own login', 400)
    if (body.hrScopeUnitIds) {
      if (!isSys) throw new AppError('Only a system administrator sets which departments an HR admin looks after', 403)
      if (self) throw new AppError('You cannot limit your own access', 400)
      const scoped = [...new Set(body.hrScopeUnitIds)]
      if (scoped.length && (await OrgUnit.countDocuments({ tenantId: actor.tenantId, _id: { $in: scoped } })) !== scoped.length) throw new AppError('Department not found', 404)
      await User.updateOne({ _id: emp.userId }, { hrScopeUnitIds: scoped })
      await audit({ tenantId: actor.tenantId, userId: actor.userId, action: 'HR_SCOPE_CHANGED', entityType: 'employee', entityId: employeeId, newValue: { departments: scoped } })
      clearHrScope(emp.userId)
    }
    if (emp.employmentStatus === 'terminated' && body.loginEnabled) throw new AppError('This person has left; their login cannot be enabled', 400)

    let issuedPassword: string | undefined
    if (body.password) {
      if (self) throw new AppError('Change your own password from Security', 400)
      issuedPassword = body.password === 'generate' ? randomPassword() : body.password
      if (!(issuedPassword.length >= 10 && /[A-Za-z]/.test(issuedPassword) && /\d/.test(issuedPassword))) throw new AppError('Use at least 10 characters with a letter and a number', 400)
    }

    const set: any = {}
    if (roles) {
      const keep = (target.userRoles || []).filter((r: any) => roles!.includes(r.roleName))
      const add = catalogue.filter((r: any) => roles!.includes(r.name) && !currentNames.includes(r.name))
        .map((r: any) => ({ _id: crypto.randomUUID(), roleId: r._id, roleName: r.name, scopeType: 'org', validFrom: new Date(), delegatedBy: actor.userId, createdAt: new Date() }))
      set.userRoles = [...keep, ...add]
    }
    if (body.loginEnabled !== undefined) set.active = body.loginEnabled
    if (issuedPassword) { set.passwordHash = await bcrypt.hash(issuedPassword, 12); set.mustChangePassword = true }
    const endSessions = !!(roles || issuedPassword || body.loginEnabled === false)

    const session = await mongoose.startSession()
    try {
      await session.withTransaction(async () => {
        const o = { session }
        if (Object.keys(set).length) await User.updateOne({ _id: emp.userId }, { $set: set }, o)
        if (endSessions) await RefreshToken.updateMany({ userId: emp.userId, revokedAt: null }, { revokedAt: new Date() }, o)
        await AuditLog.create([{ tenantId: actor.tenantId, userId: actor.userId, action: 'ACCESS_CHANGED', entityType: 'employee', entityId: employeeId,
          oldValue: { roles: currentNames }, newValue: { roles: roles ?? currentNames, loginEnabled: body.loginEnabled, passwordIssued: !!issuedPassword } }], o)
      })
    } finally { await session.endSession() }
    const view = await this.get(employeeId, actor.tenantId)
    return { ...view, ...(issuedPassword && { temporaryPassword: issuedPassword }) }
  },
}

// Org chart: the whole company as a reporting tree; only public fields; canOpen mirrors canAccessProfile
export const orgChartService = {
  async get(user: AccessUser) {
    const [rows, units]: any[] = await Promise.all([
      Employee.find({ tenantId: user.tenantId, active: true, employmentStatus: { $ne: 'terminated' } }).collation(CI).sort({ firstName: 1, lastName: 1 }).lean(),
      OrgUnit.find({ tenantId: user.tenantId, active: true }).sort({ name: 1 }).lean(),
    ])
    const [jobs, locs, users]: any[] = await Promise.all([
      JobPosition.find({ _id: { $in: ids(rows, 'jobPositionId') } }).select('title').lean(),
      WorkLocation.find({ _id: { $in: ids(rows, 'workLocationId') } }).select('name').lean(),
      User.find({ _id: { $in: ids(rows, 'userId') } }).select('avatarUrl').lean(),
    ])
    const J = new Map<string, any>(jobs.map((j: any) => [j._id, j])), L = new Map<string, any>(locs.map((l: any) => [l._id, l])), U = new Map<string, any>(users.map((u: any) => [u._id, u])), O = new Map<string, any>(units.map((o: any) => [o._id, o]))
    const present = new Set<string>(rows.map((r: any) => r._id))
    const managerOf = new Map<string, string | null>(rows.map((r: any) => [r._id, r.managerId && present.has(r.managerId) ? r.managerId : null]))
    const below = new Set<string>()
    if (user.employeeId) {
      const kids = new Map<string, string[]>()
      for (const [id, m] of managerOf) if (m) kids.set(m, [...(kids.get(m) ?? []), id])
      const stack = [...(kids.get(user.employeeId) ?? [])]
      while (stack.length) { const id = stack.pop()!; if (!below.has(id)) { below.add(id); stack.push(...(kids.get(id) ?? [])) } }
    }
    const isHR = user.roleIds.some((r) => ['hr_admin', 'system_admin', 'payroll_admin'].includes(r))
    return {
      people: rows.map((r: any) => ({
        id: r._id, name: `${r.firstName} ${r.lastName === '-' ? '' : r.lastName}`.trim(), title: J.get(r.jobPositionId)?.title ?? null,
        department: O.get(r.orgUnitId)?.name ?? null, departmentId: r.orgUnitId, location: L.get(r.workLocationId)?.name ?? null,
        avatarUrl: U.get(r.userId)?.avatarUrl ?? null, managerId: managerOf.get(r._id) ?? null, isMe: r._id === user.employeeId,
        canOpen: isHR || r._id === user.employeeId || below.has(r._id),
      })),
      departments: units.map((u: any) => ({ id: u._id, name: u.name, parentId: u.parentId ?? null, type: u.type })),
    }
  },
}

// Self-check: node -r dotenv/config -r ts-node/register/transpile-only src/modules/employees/employees.mongo.ts  (creates a workspace, then deletes it)
if (require.main === module) {
  ;(async () => {
    const { bootstrapCompany } = await import('../company/company.bootstrap.mongo')
    await connectMongo()
    await syncMongoIndexes()
    const slug = `empcheck-${Date.now()}`
    const { tenantId, userId } = await bootstrapCompany({ companyName: 'Empcheck Ltd', slug, email: `${slug}@example.com`, fullName: 'Owner One', passwordHash: await bcrypt.hash('Correct-horse-1', 4) })
    const owner: any = await Employee.findOne({ tenantId }).lean()
    const unit: any = await OrgUnit.findOne({ tenantId }).lean()
    const admin: AccessUser = { userId, tenantId, employeeId: owner._id, roleIds: ['employee', 'hr_admin', 'system_admin'] }
    const status = async (p: Promise<any>) => p.then(() => 0, (e) => e.statusCode ?? e.status ?? -1)
    try {
      const created: any = await employeeService.create(tenantId, { firstName: 'Mary', lastName: 'Banda', workEmail: `Mary.${slug}@example.com`, orgUnitId: unit._id, managerId: owner._id, hireDate: '2026-11-02', employmentType: 'full_time' } as any, userId)
      console.assert(created.employee.employeeCode === 'EMP0002', 'next employee code is EMP0002')
      console.assert((await status(employeeService.create(tenantId, { firstName: 'M', lastName: 'B', workEmail: `mary.${slug}@example.com`, orgUnitId: unit._id, hireDate: '2026-11-02', employmentType: 'full_time' } as any, userId))) === 409, 'duplicate email (any case) is 409')
      console.assert((await status(employeeService.create(tenantId, { firstName: 'X', lastName: 'Y', workEmail: 'x@y.com', orgUnitId: 'nope', hireDate: '2026-11-02', employmentType: 'full_time' } as any, userId))) === 404, 'org unit from nowhere is 404')
      const list: any = await employeeService.list(tenantId, { search: 'bAnDa' }, admin)
      console.assert(list.data.length === 1 && list.meta.total === 1 && list.data[0].manager?.user?.fullName === 'Owner One', 'directory search is case-insensitive and joins the manager')
      const mary = created.employee.id
      const prof: any = await employeeService.getById(mary, tenantId, admin)
      console.assert(prof.orgUnit.name === 'Empcheck Ltd' && prof.resourceCalendar.days.length === 5 && prof.user.email.toLowerCase().startsWith('mary.'), 'profile joins org unit, calendar days and user')
      const marySelf: AccessUser = { userId: created.employee.userId, tenantId, employeeId: mary, roleIds: ['employee'] }
      console.assert((await status(employeeService.getById(owner._id, tenantId, marySelf))) === 404, 'an employee cannot open someone else\'s profile')
      console.assert((await status(employeeService.list(tenantId, {}, marySelf))) === 403, 'an employee cannot list the directory')
      // access: grant a login, hand out the manager role, refuse own-admin removal and a non-admin touching system roles
      const granted: any = await accessService.set(mary, admin, { roles: ['manager'], password: 'generate', loginEnabled: true })
      console.assert(granted.temporaryPassword && granted.roles.sort().join() === 'employee,manager' && granted.mustChangePassword && granted.loginEnabled, 'access grant issues a temporary password and roles')
      const { authService } = await import('../auth/auth.mongo')
      const login: any = await authService.login({ email: `mary.${slug}@example.com`, password: granted.temporaryPassword, tenantSlug: slug }, 'selfcheck')
      console.assert(login.user.mustChangePassword && login.user.roles.map((r: any) => r.name).sort().join() === 'employee,manager', 'she signs in with the temporary password and must change it')
      console.assert((await status(accessService.set(owner._id, admin, { roles: ['employee'] }))) === 400, 'cannot remove your own admin access')
      console.assert((await status(accessService.set(mary, { ...admin, roleIds: ['hr_admin'] }, { roles: ['system_admin'] }))) === 403, 'only system admins change system roles')
      // bank details: maker-checker
      await employeeService.updateBank(mary, tenantId, userId, { bankName: 'FNB', bankAccountNo: '1234567890' })
      const prof2: any = await employeeService.getById(mary, tenantId, admin)
      console.assert(prof2.bankAccountLast4 === '7890' && !('bankAccountNo' in prof2), 'only the last 4 digits come back')
      console.assert((await status(employeeService.verifyBank(mary, tenantId, userId))) === 403, 'the person who entered bank details cannot verify them')
      console.assert((await employeeService.verifyBank(mary, tenantId, 'someone-else') as any).bankVerified === true, 'a different user can verify')
      // update + archive
      console.assert((await status(employeeService.update(mary, tenantId, { managerId: mary } as any, userId))) === 400, 'own manager refused')
      const upd: any = await employeeService.update(mary, tenantId, { gender: 'female' } as any, userId)
      console.assert(upd.gender === 'female', 'update applies')
      const chart: any = await orgChartService.get(admin)
      console.assert(chart.people.length === 2 && chart.people.find((p: any) => p.id === mary).managerId === owner._id, 'org chart nests Mary under the owner')
      await employeeService.archive(mary, tenantId, userId, 'left')
      console.assert((await status(authService.refresh(login.refreshToken))) === 401, 'archiving ends her sessions')
      console.assert((await employeeService.list(tenantId, {}, admin) as any).data.length === 1, 'archived people leave the directory')
      console.log('employees self-check done')
    } finally {
      const emps: any[] = await Employee.find({ tenantId }).select('_id').lean()
      await col('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } } as any)
      const users: any[] = await User.find({ tenantId }).select('_id').lean()
      await RefreshToken.deleteMany({ userId: { $in: users.map((u) => u._id) } })
      for (const c of ['roles', 'users', 'org_units', 'employees', 'audit_logs', 'domain_events', 'employee_position_history', 'leave_types', 'activity_types', 'expense_categories', 'payroll_input_types', 'shift_templates', 'resource_calendars']) await col(c).deleteMany({ tenantId } as any)
      await Tenant.deleteOne({ _id: tenantId })
      await mongoose.disconnect()
      ;(await import('../../infrastructure/cache/redis')).redis.disconnect()
    }
  })().catch((e) => { console.error(e); process.exit(1) })
}

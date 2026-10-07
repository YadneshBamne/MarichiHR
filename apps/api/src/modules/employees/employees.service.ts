import { employeeRepository, orgUnitRepository, jobPositionRepository, workLocationRepository } from './employees.repository'
import { CreateEmployeeDto, UpdateEmployeeDto, CreateOrgUnitDto, CreateJobPositionDto, CreateWorkLocationDto, AddSkillDto, AddResumeLineDto } from './employees.types'
import { AppError } from '../../shared/utils/AppError'
import { eventBus, prepareEvent } from '../../infrastructure/events/eventBus'
import { insertRows } from '../../infrastructure/database/insertRows'
import { buildMeta } from '../../shared/utils/pagination'
import { prisma } from '../../infrastructure/database/prisma'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { UpdateEmployeeSchema } from './employees.schema'
import { encryptField, decryptField, last4 } from '../../shared/utils/crypto'
import { AccessUser, assertProfileAccess, getReportingSubtreeIds } from '../../shared/utils/access'

// Every id supplied by a client must point at a record in the caller's own tenant
async function assertRefsInTenant(tenantId: string, refs: {
  parentOrgUnitId?: string
  orgUnitId?: string
  jobPositionId?: string
  managerId?: string
  workLocationId?: string
  resourceCalendarId?: string
}) {
  const checks: [string | undefined, string, () => Promise<unknown>][] = [
    [refs.parentOrgUnitId, 'Parent org unit', () => prisma.orgUnit.findFirst({ where: { id: refs.parentOrgUnitId, tenantId }, select: { id: true } })],
    [refs.orgUnitId, 'Org unit', () => prisma.orgUnit.findFirst({ where: { id: refs.orgUnitId, tenantId }, select: { id: true } })],
    [refs.jobPositionId, 'Job position', () => prisma.jobPosition.findFirst({ where: { id: refs.jobPositionId, tenantId }, select: { id: true } })],
    [refs.managerId, 'Manager', () => prisma.employee.findFirst({ where: { id: refs.managerId, tenantId }, select: { id: true } })],
    [refs.workLocationId, 'Work location', () => prisma.workLocation.findFirst({ where: { id: refs.workLocationId, tenantId }, select: { id: true } })],
    [refs.resourceCalendarId, 'Resource calendar', () => prisma.resourceCalendar.findFirst({ where: { id: refs.resourceCalendarId, tenantId }, select: { id: true } })],
  ]
  const present = checks.filter(([value]) => value)
  const found = await Promise.all(present.map(([, , lookup]) => lookup()))
  const missing = present.find((_, i) => !found[i])
  if (missing) throw new AppError(`${missing[1]} not found`, 404)
}

export const orgUnitService = {
  async getTree(tenantId: string) {
    const units = await orgUnitRepository.getTree(tenantId)
    return units.filter((u) => !u.parentId)
  },

  async getById(id: string, tenantId: string) {
    const unit = await orgUnitRepository.findById(id, tenantId)
    if (!unit) throw new AppError('Org unit not found', 404)
    return unit
  },

  async create(tenantId: string, data: CreateOrgUnitDto) {
    await assertRefsInTenant(tenantId, { parentOrgUnitId: data.parentId })
    return orgUnitRepository.create(tenantId, data)
  },

  async update(id: string, tenantId: string, data: Partial<CreateOrgUnitDto>, updatedBy: string) {
    const unit = await orgUnitRepository.findById(id, tenantId)
    if (!unit) throw new AppError('Org unit not found', 404)
    if (data.parentId === id) throw new AppError('An org unit cannot be its own parent', 400)
    await assertRefsInTenant(tenantId, { parentOrgUnitId: data.parentId })
    return orgUnitRepository.update(id, tenantId, data)
  },

  async archive(id: string, tenantId: string, archivedBy: string, reason: string) {
    const unit = await orgUnitRepository.findById(id, tenantId)
    if (!unit) throw new AppError('Org unit not found', 404)

    const employeeCount = unit._count.employees
    if (employeeCount > 0) {
      throw new AppError(`Cannot archive org unit with ${employeeCount} active employees`, 400)
    }

    return orgUnitRepository.archive(id, tenantId, archivedBy, reason)
  },
}

export const jobPositionService = {
  async list(tenantId: string, orgUnitId?: string) {
    return jobPositionRepository.list(tenantId, orgUnitId)
  },

  async create(tenantId: string, data: CreateJobPositionDto) {
    await assertRefsInTenant(tenantId, { orgUnitId: data.orgUnitId })
    return jobPositionRepository.create(tenantId, data)
  },

  async update(id: string, tenantId: string, data: Partial<CreateJobPositionDto>) {
    const position = await prisma.jobPosition.findFirst({ where: { id, tenantId }, select: { id: true } })
    if (!position) throw new AppError('Job position not found', 404)
    await assertRefsInTenant(tenantId, { orgUnitId: data.orgUnitId })
    return jobPositionRepository.update(id, data)
  },
}

export const workLocationService = {
  async list(tenantId: string) {
    return workLocationRepository.list(tenantId)
  },

  async create(tenantId: string, data: CreateWorkLocationDto) {
    return workLocationRepository.create(tenantId, data)
  },

  async update(id: string, tenantId: string, data: Partial<CreateWorkLocationDto>) {
    const location = await prisma.workLocation.findFirst({ where: { id, tenantId }, select: { id: true } })
    if (!location) throw new AppError('Work location not found', 404)
    return workLocationRepository.update(id, data)
  },
}

// Never return the stored (encrypted) account number — expose only the last 4 digits
function toSafeEmployee<T extends Record<string, any>>(employee: T) {
  const { bankAccountNo, ...rest } = employee
  let bankAccountLast4: string | null = null
  if (bankAccountNo) {
    try {
      bankAccountLast4 = last4(decryptField(bankAccountNo))
    } catch {
      console.warn(`[bank] could not decrypt account number for employee ${rest.id}`)
    }
  }
  return { ...rest, bankAccountLast4 }
}

const UPDATABLE_FIELDS = new Set(Object.keys(UpdateEmployeeSchema.shape.body.shape))

const hasAnyRole = (user: AccessUser, ...roles: string[]) => roles.some((r) => user.roleIds.includes(r))

// What this viewer may see on another person's record: compensation (contracts) and bank fields are
// limited to the person themself and payroll/HR staff (managers get neither)
function shapeEmployeeForViewer(employee: Record<string, any>, user: AccessUser) {
  const self = !!user.employeeId && user.employeeId === employee.id
  const canCompensation = self || hasAnyRole(user, 'hr_admin', 'payroll_admin', 'compliance_officer')
  const canBank = self || hasAnyRole(user, 'hr_admin', 'payroll_admin')

  const safe: Record<string, any> = toSafeEmployee(employee)
  if (!canCompensation) delete safe.contracts
  if (!canBank) {
    for (const key of ['bankAccountLast4', 'bankName', 'bankIfscSwift', 'bankVerified', 'bankVerifiedBy', 'bankVerifiedAt']) delete safe[key]
  }
  return safe
}

export const employeeService = {
  async list(tenantId: string, query: any, user: AccessUser) {
    // HR/payroll/compliance see everyone; managers see themselves and their reporting subtree; others nothing
    let ids: string[] | undefined
    if (!hasAnyRole(user, 'hr_admin', 'payroll_admin', 'compliance_officer')) {
      if (!user.roleIds.includes('manager') || !user.employeeId) throw new AppError('You do not have access to the employee directory', 403)
      ids = [user.employeeId, ...(await getReportingSubtreeIds(user.employeeId, tenantId))]
    }

    const result = await employeeRepository.list(tenantId, {
      page: parseInt(query.page) || 1,
      limit: parseInt(query.limit) || 25,
      search: query.search,
      orgUnitId: query.orgUnitId,
      employmentType: query.employmentType,
      employmentStatus: query.employmentStatus,
      showArchived: query.showArchived === 'true',
      ids,
    })

    return {
      data: result.employees.map((e: any) => shapeEmployeeForViewer(e, user)),
      meta: buildMeta(result.total, result.page, result.limit),
    }
  },

  async getById(id: string, tenantId: string, user: AccessUser) {
    await assertProfileAccess(user, id)
    const employee = await employeeRepository.findById(id, tenantId)
    if (!employee) throw new AppError('Employee not found', 404)
    return shapeEmployeeForViewer(employee, user)
  },

  async create(tenantId: string, data: CreateEmployeeDto, createdBy: string) {
    // Independent lookups go out together (each database round trip is expensive)
    const [existingUser, , employeeCode, employeeRole, leaveTypes, defaultCalendar] = await Promise.all([
      prisma.user.findFirst({ where: { tenantId, email: { equals: data.workEmail, mode: 'insensitive' } }, select: { id: true } }),
      assertRefsInTenant(tenantId, {
        orgUnitId: data.orgUnitId,
        jobPositionId: data.jobPositionId,
        managerId: data.managerId,
        workLocationId: data.workLocationId,
        resourceCalendarId: data.resourceCalendarId,
      }),
      employeeRepository.generateEmployeeCode(tenantId),
      prisma.role.findFirst({ where: { tenantId, name: 'employee' } }),
      prisma.leaveType.findMany({ where: { tenantId, active: true }, select: { id: true } }),
      data.resourceCalendarId ? null : prisma.resourceCalendar.findFirst({ where: { tenantId, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } }),
    ])
    if (existingUser) {
      throw new AppError('An employee with this email already exists', 409)
    }
    // New people follow the company's working week unless told otherwise (attendance and payroll rely on it)
    if (!data.resourceCalendarId && defaultCalendar) data = { ...data, resourceCalendarId: defaultCalendar.id }

    // User, role, employee, leave balances, the domain event and its chatter line go in as ONE statement
    const now = new Date().toISOString()
    const userId = crypto.randomUUID()
    const employeeId = crypto.randomUUID()
    const dateOnly = (v?: string) => (v ? new Date(v.slice(0, 10) + 'T00:00:00.000Z').toISOString() : null)
    const employeeRow: Record<string, unknown> = {
      id: employeeId, tenantId, userId, orgUnitId: data.orgUnitId, jobPositionId: data.jobPositionId ?? null, managerId: data.managerId ?? null,
      resourceCalendarId: data.resourceCalendarId ?? null, workLocationId: data.workLocationId ?? null, taxJurisdiction: data.taxJurisdiction ?? null,
      firstName: data.firstName, lastName: data.lastName, workEmail: data.workEmail, personalEmail: data.personalEmail ?? null,
      dateOfBirth: dateOnly(data.dateOfBirth), gender: data.gender ?? null, nationality: data.nationality ?? null,
      mobilePersonal: data.mobilePersonal ?? null, mobileWork: data.mobileWork ?? null, emergencyContactName: data.emergencyContactName ?? null,
      emergencyContactPhone: data.emergencyContactPhone ?? null, emergencyContactRelation: data.emergencyContactRelation ?? null,
      employmentType: data.employmentType ?? 'full_time', employmentStatus: 'active', hireDate: dateOnly(data.hireDate), bankVerified: false, active: true,
      createdAt: now, updatedAt: now,
    }
    // Codes come from the highest existing one, so two people added at the same moment can collide: take the next and retry
    let code = employeeCode
    for (let attempt = 0; ; attempt++) {
      const event = prepareEvent(tenantId, 'employee.created', { employeeId, employeeCode: code, name: `${data.firstName} ${data.lastName}`, email: data.workEmail, createdBy })
      try {
        await insertRows({
          users: [{ id: userId, tenantId, email: data.workEmail, fullName: `${data.firstName} ${data.lastName}`, passwordHash: null, active: true, mfaEnabled: false, mustChangePassword: false, createdAt: now, updatedAt: now }],
          user_roles: employeeRole ? [{ id: crypto.randomUUID(), userId, roleId: employeeRole.id, scopeType: 'org', validFrom: now, createdAt: now }] : [],
          employees: [{ ...employeeRow, employeeCode: code }],
          leave_balances: leaveTypes.map((lt) => ({ employeeId, leaveTypeId: lt.id, balanceDays: 0, usedDays: 0, pendingDays: 0, encashedDays: 0, lapsedDays: 0, asOfDate: now })),
          ...event.rows,
        })
        event.after()
        break
      } catch (err: any) {
        const dupCode = /employeeCode|employees_tenantId_employeeCode/.test(String(err?.message))
        if (/users_tenantId_email_key/.test(String(err?.message))) throw new AppError('An employee with this email already exists', 409)
        if (!dupCode || attempt >= 4) throw err
        code = `EMP${String(Number(code.slice(3)) + 1 + attempt).padStart(4, '0')}`
      }
    }
    const employee = { ...employeeRow, employeeCode: code, hireDate: new Date(employeeRow.hireDate as string), createdAt: new Date(now), updatedAt: new Date(now), bankAccountNo: null } as any

    return {
      employee: toSafeEmployee(employee),
      message: 'Employee created. Grant login access to let them sign in.',
    }
  },

  async update(id: string, tenantId: string, data: UpdateEmployeeDto, updatedBy: string) {
    const employee = await employeeRepository.findById(id, tenantId)
    if (!employee) throw new AppError('Employee not found', 404)

    // Only schema-declared fields may be written here; bank details go through updateBank/verifyBank
    const safeData = Object.fromEntries(
      Object.entries(data).filter(([key]) => UPDATABLE_FIELDS.has(key))
    ) as UpdateEmployeeDto

    if (safeData.managerId === id) throw new AppError('An employee cannot be their own manager', 400)
    await assertRefsInTenant(tenantId, {
      orgUnitId: safeData.orgUnitId,
      jobPositionId: safeData.jobPositionId,
      managerId: safeData.managerId,
      workLocationId: safeData.workLocationId,
      resourceCalendarId: safeData.resourceCalendarId,
    })

    const updated = await employeeRepository.update(id, safeData)

    await eventBus.publish(tenantId, 'employee.updated', {
      employeeId: id,
      updatedBy,
      changes: Object.keys(safeData),
    })

    return toSafeEmployee(updated)
  },

  async updateBank(id: string, tenantId: string, userId: string, dto: { bankName: string; bankAccountNo: string; bankIfscSwift?: string }) {
    const employee = await employeeRepository.findById(id, tenantId)
    if (!employee) throw new AppError('Employee not found', 404)

    const updated = await prisma.employee.update({
      where: { id },
      data: {
        bankName: dto.bankName,
        bankAccountNo: encryptField(dto.bankAccountNo),
        bankIfscSwift: dto.bankIfscSwift ?? null,
        bankVerified: false,
        bankVerifiedBy: null,
        bankVerifiedAt: null,
      },
    })

    await prisma.auditLog.create({
      data: {
        tenantId, userId, action: 'BANK_DETAILS_UPDATED', entityType: 'employee', entityId: id,
        newValue: { bankName: dto.bankName, last4: last4(dto.bankAccountNo) },
      },
    })

    return toSafeEmployee(updated)
  },

  async verifyBank(id: string, tenantId: string, userId: string) {
    const employee = await prisma.employee.findFirst({ where: { id, tenantId } })
    if (!employee) throw new AppError('Employee not found', 404)
    if (!employee.bankAccountNo || !employee.bankName) throw new AppError('This employee has no bank details to verify', 400)

    const lastWrite = await prisma.auditLog.findFirst({
      where: { tenantId, entityType: 'employee', entityId: id, action: 'BANK_DETAILS_UPDATED' },
      orderBy: { createdAt: 'desc' },
    })
    if (lastWrite?.userId === userId) {
      throw new AppError('Bank details must be verified by a different user than the one who entered them', 403)
    }

    const updated = await prisma.employee.update({
      where: { id },
      data: { bankVerified: true, bankVerifiedBy: userId, bankVerifiedAt: new Date() },
    })

    await prisma.auditLog.create({
      data: {
        tenantId, userId, action: 'BANK_DETAILS_VERIFIED', entityType: 'employee', entityId: id,
        newValue: { bankName: employee.bankName },
      },
    })

    return toSafeEmployee(updated)
  },

  async archive(id: string, tenantId: string, archivedBy: string, reason: string) {
    const employee = await employeeRepository.findById(id, tenantId)
    if (!employee) throw new AppError('Employee not found', 404)
    if (!employee.active) throw new AppError('Employee is already archived', 400)

    const archived = await employeeRepository.archive(id, archivedBy, reason)
    // Archived people are signed out everywhere
    await prisma.refreshToken.updateMany({ where: { userId: employee.userId, revokedAt: null }, data: { revokedAt: new Date() } })

    await eventBus.publish(tenantId, 'employee.archived', {
      employeeId: id,
      archivedBy,
      reason,
    })

    return toSafeEmployee(archived)
  },

  async addSkill(employeeId: string, tenantId: string, data: AddSkillDto) {
    const employee = await employeeRepository.findById(employeeId, tenantId)
    if (!employee) throw new AppError('Employee not found', 404)

    const skill = await prisma.skill.findFirst({ where: { id: data.skillId, skillType: { tenantId } }, select: { id: true } })
    if (!skill) throw new AppError('Skill not found', 404)
    if (data.skillLevelId) {
      const level = await prisma.skillLevel.findFirst({ where: { id: data.skillLevelId, skillId: data.skillId }, select: { id: true } })
      if (!level) throw new AppError('Skill level not found', 404)
    }
    return employeeRepository.addSkill(employeeId, data)
  },

  async removeSkill(skillId: string, employeeId: string, tenantId: string) {
    const employee = await employeeRepository.findById(employeeId, tenantId)
    if (!employee) throw new AppError('Employee not found', 404)
    await employeeRepository.removeSkill(skillId, employeeId)
  },

  async addResumeLine(employeeId: string, tenantId: string, data: AddResumeLineDto) {
    const employee = await employeeRepository.findById(employeeId, tenantId)
    if (!employee) throw new AppError('Employee not found', 404)
    return employeeRepository.addResumeLine(employeeId, data)
  },

  async updateResumeLine(id: string, employeeId: string, tenantId: string, data: Partial<AddResumeLineDto>) {
    const employee = await employeeRepository.findById(employeeId, tenantId)
    if (!employee) throw new AppError('Employee not found', 404)
    return employeeRepository.updateResumeLine(id, employeeId, data)
  },

  async removeResumeLine(id: string, employeeId: string, tenantId: string) {
    const employee = await employeeRepository.findById(employeeId, tenantId)
    if (!employee) throw new AppError('Employee not found', 404)
    await employeeRepository.removeResumeLine(id, employeeId)
  },

  async getSkillTypes(tenantId: string) {
    return employeeRepository.listSkillTypes(tenantId)
  },
}

// ─── Login access (who can sign in, with which roles) ─────────────────────────
const randomPassword = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(14)
  const body = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
  return body.slice(0, 4) + '-' + body.slice(4, 9) + '-' + body.slice(9) + '7'
}

export const accessService = {
  async get(employeeId: string, tenantId: string) {
    const emp = await prisma.employee.findFirst({
      where: { id: employeeId, tenantId },
      select: { user: { select: { id: true, email: true, active: true, passwordHash: true, mustChangePassword: true, lastLoginAt: true, googleSub: true, mfaEnabled: true, userRoles: { select: { role: { select: { name: true } } } } } } },
    })
    if (!emp) throw new AppError('Employee not found', 404)
    const u = emp.user
    return {
      email: u.email, loginEnabled: u.active && (!!u.passwordHash || !!u.googleSub), active: u.active, hasPassword: !!u.passwordHash,
      googleLinked: !!u.googleSub, mfaEnabled: u.mfaEnabled, mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt,
      roles: u.userRoles.map((r) => r.role.name),
    }
  },

  // HR (and system admins) decide who can sign in and with which roles; a temporary password must be changed at first sign-in
  async set(employeeId: string, actor: { tenantId: string; userId: string; roleIds: string[] }, body: { roles?: string[]; loginEnabled?: boolean; password?: 'generate' | string }) {
    const [emp, current, catalogue] = await Promise.all([
      prisma.employee.findFirst({ where: { id: employeeId, tenantId: actor.tenantId }, select: { userId: true, employmentStatus: true } }),
      prisma.userRole.findMany({ where: { user: { employee: { id: employeeId } }, role: { tenantId: actor.tenantId } }, select: { id: true, role: { select: { name: true } } } }),
      prisma.role.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, name: true } }),
    ])
    if (!emp) throw new AppError('Employee not found', 404)
    const isSys = actor.roleIds.includes('system_admin')
    const self = emp.userId === actor.userId
    const currentNames = current.map((c) => c.role.name)

    let roles = body.roles
    if (roles) {
      roles = [...new Set(['employee', ...roles])]
      // Only system admins hand out or take away system or compliance roles
      const sensitive = ['system_admin', 'compliance_officer']
      const touched = sensitive.filter((r) => roles!.includes(r) !== currentNames.includes(r))
      if (touched.length && !isSys) throw new AppError('Only a system administrator can change system or compliance roles', 403)
      if (self && currentNames.some((r) => ['hr_admin', 'system_admin'].includes(r) && !roles!.includes(r))) throw new AppError('You cannot remove your own admin access', 400)
    }
    if (body.loginEnabled === false && self) throw new AppError('You cannot disable your own login', 400)
    if (emp.employmentStatus === 'terminated' && body.loginEnabled) throw new AppError('This person has left; their login cannot be enabled', 400)

    let issuedPassword: string | undefined
    if (body.password) {
      if (self) throw new AppError('Change your own password from Security', 400)
      issuedPassword = body.password === 'generate' ? randomPassword() : body.password
      if (!(issuedPassword.length >= 10 && /[A-Za-z]/.test(issuedPassword) && /\d/.test(issuedPassword))) throw new AppError('Use at least 10 characters with a letter and a number', 400)
    }

    // Role changes, the user update, ending their sessions and the audit row: one statement, one round trip
    const now = new Date().toISOString()
    const remove = roles ? current.filter((c) => !roles!.includes(c.role.name)).map((c) => c.id) : []
    const add = roles ? catalogue.filter((r) => roles!.includes(r.name) && !currentNames.includes(r.name)) : []
    const passwordHash = issuedPassword ? await bcrypt.hash(issuedPassword, 12) : null
    const endSessions = !!(roles || issuedPassword || body.loginEnabled === false)
    await insertRows({
      user_roles: add.map((r) => ({ id: crypto.randomUUID(), userId: emp.userId, roleId: r.id, scopeType: 'org', validFrom: now, delegatedBy: actor.userId, createdAt: now })),
      audit_logs: [{ id: crypto.randomUUID(), tenantId: actor.tenantId, userId: actor.userId, action: 'ACCESS_CHANGED', entityType: 'employee', entityId: employeeId,
        oldValue: { roles: currentNames }, newValue: { roles: roles ?? currentNames, loginEnabled: body.loginEnabled, passwordIssued: !!issuedPassword }, createdAt: now }],
    }, [
      ...(remove.length ? [{ sql: 'DELETE FROM user_roles WHERE id = ANY($1::text[]) RETURNING 1', params: [remove] }] : []),
      ...(body.loginEnabled !== undefined || passwordHash ? [{
        sql: 'UPDATE users SET active = COALESCE($1::boolean, active), "passwordHash" = COALESCE($2::text, "passwordHash"), "mustChangePassword" = CASE WHEN $2::text IS NULL THEN "mustChangePassword" ELSE true END, "updatedAt" = now() WHERE id = $3 RETURNING 1',
        params: [body.loginEnabled ?? null, passwordHash, emp.userId],
      }] : []),
      ...(endSessions ? [{ sql: 'UPDATE refresh_tokens SET "revokedAt" = now() WHERE "userId" = $1 AND "revokedAt" IS NULL RETURNING 1', params: [emp.userId] }] : []),
    ])
    const view = await this.get(employeeId, actor.tenantId)
    return { ...view, ...(issuedPassword && { temporaryPassword: issuedPassword }) }
  },
}

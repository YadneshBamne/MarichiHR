import { employeeRepository, orgUnitRepository, jobPositionRepository, workLocationRepository } from './employees.repository'
import { CreateEmployeeDto, UpdateEmployeeDto, CreateOrgUnitDto, CreateJobPositionDto, CreateWorkLocationDto, AddSkillDto, AddResumeLineDto } from './employees.types'
import { AppError } from '../../shared/utils/AppError'
import { eventBus } from '../../infrastructure/events/eventBus'
import { buildMeta } from '../../shared/utils/pagination'
import { prisma } from '../../infrastructure/database/prisma'
import bcrypt from 'bcryptjs'
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
  for (const [value, label, lookup] of checks) {
    if (value && !(await lookup())) throw new AppError(`${label} not found`, 404)
  }
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
    const existingUser = await prisma.user.findFirst({
      where: { tenantId, email: data.workEmail },
    })
    if (existingUser) {
      throw new AppError('An employee with this email already exists', 409)
    }

    await assertRefsInTenant(tenantId, {
      orgUnitId: data.orgUnitId,
      jobPositionId: data.jobPositionId,
      managerId: data.managerId,
      workLocationId: data.workLocationId,
      resourceCalendarId: data.resourceCalendarId,
    })

    const employeeCode = await employeeRepository.generateEmployeeCode(tenantId)

    const tempPassword = `MarichiHR@${Math.floor(1000 + Math.random() * 9000)}`
    const passwordHash = await bcrypt.hash(tempPassword, 12)

    const employeeRole = await prisma.role.findFirst({
      where: { tenantId, name: 'employee' },
    })

    const user = await prisma.user.create({
      data: {
        tenantId,
        email: data.workEmail,
        fullName: `${data.firstName} ${data.lastName}`,
        passwordHash,
        active: true,
        userRoles: employeeRole
          ? {
              create: [{
                roleId: employeeRole.id,
                scopeType: 'org',
                validFrom: new Date(),
              }],
            }
          : undefined,
      },
    })

    const employee = await employeeRepository.create(tenantId, user.id, data, employeeCode)

    await eventBus.publish(tenantId, 'employee.created', {
      employeeId: employee.id,
      employeeCode,
      name: `${data.firstName} ${data.lastName}`,
      email: data.workEmail,
      createdBy,
      tempPassword,
    })

    const leaveTypes = await prisma.leaveType.findMany({
      where: { tenantId, active: true },
    })

    await prisma.leaveBalance.createMany({
      data: leaveTypes.map((lt) => ({
        employeeId: employee.id,
        leaveTypeId: lt.id,
        balanceDays: 0,
        usedDays: 0,
        pendingDays: 0,
        encashedDays: 0,
        lapsedDays: 0,
        asOfDate: new Date(),
      })),
      skipDuplicates: true,
    })

    return {
      employee: toSafeEmployee(employee),
      tempPassword,
      message: 'Employee created. Share the temporary password securely.',
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

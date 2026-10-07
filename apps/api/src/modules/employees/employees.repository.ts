import { prisma } from '../../infrastructure/database/prisma'
import { getPagination } from '../../shared/utils/pagination'
import {
  CreateEmployeeDto,
  UpdateEmployeeDto,
  CreateOrgUnitDto,
  CreateJobPositionDto,
  CreateWorkLocationDto,
  AddSkillDto,
  AddResumeLineDto,
} from './employees.types'

export const orgUnitRepository = {
  async getTree(tenantId: string) {
    return prisma.orgUnit.findMany({
      where: { tenantId, active: true },
      include: {
        children: {
          where: { active: true },
          include: {
            children: {
              where: { active: true },
              include: {
                children: { where: { active: true } },
              },
            },
          },
        },
        jobPositions: { where: { active: true }, select: { id: true, title: true, code: true } },
        _count: { select: { employees: true } },
      },
      orderBy: { name: 'asc' },
    })
  },

  async findById(id: string, tenantId: string) {
    return prisma.orgUnit.findFirst({
      where: { id, tenantId, active: true },
      include: {
        parent: { select: { id: true, name: true, type: true } },
        children: { where: { active: true }, select: { id: true, name: true, type: true } },
        jobPositions: { where: { active: true } },
        _count: { select: { employees: true } },
      },
    })
  },

  async create(tenantId: string, data: CreateOrgUnitDto) {
    return prisma.orgUnit.create({
      data: { ...data, tenantId },
    })
  },

  async update(id: string, tenantId: string, data: Partial<CreateOrgUnitDto>) {
    return prisma.orgUnit.update({
      where: { id },
      data,
    })
  },

  async archive(id: string, tenantId: string, archivedBy: string, reason: string) {
    return prisma.orgUnit.update({
      where: { id },
      data: { active: false, archivedAt: new Date(), archivedBy, archiveReason: reason },
    })
  },
}

export const jobPositionRepository = {
  async list(tenantId: string, orgUnitId?: string) {
    return prisma.jobPosition.findMany({
      where: { tenantId, active: true, ...(orgUnitId && { orgUnitId }) },
      include: {
        orgUnit: { select: { id: true, name: true } },
        _count: { select: { employees: true } },
      },
      orderBy: { title: 'asc' },
    })
  },

  async create(tenantId: string, data: CreateJobPositionDto) {
    return prisma.jobPosition.create({
      data: { ...data, tenantId },
    })
  },

  async update(id: string, data: Partial<CreateJobPositionDto>) {
    return prisma.jobPosition.update({ where: { id }, data })
  },
}

export const workLocationRepository = {
  async list(tenantId: string) {
    return prisma.workLocation.findMany({
      where: { tenantId, active: true },
      orderBy: { name: 'asc' },
    })
  },

  async create(tenantId: string, data: CreateWorkLocationDto) {
    return prisma.workLocation.create({
      data: { ...data, tenantId },
    })
  },

  async update(id: string, data: Partial<CreateWorkLocationDto>) {
    return prisma.workLocation.update({ where: { id }, data })
  },
}

export const employeeRepository = {
  async list(tenantId: string, options: {
    page?: number
    limit?: number
    search?: string
    orgUnitId?: string
    employmentType?: string
    employmentStatus?: string
    showArchived?: boolean
    ids?: string[]
  }) {
    const { skip, take, page, limit } = getPagination(options)
    const active = options.showArchived ? undefined : true

    const where: any = {
      tenantId,
      ...(options.ids && { id: { in: options.ids } }),
      ...(active !== undefined && { active }),
      ...(options.orgUnitId && { orgUnitId: options.orgUnitId }),
      ...(options.employmentType && { employmentType: options.employmentType }),
      ...(options.employmentStatus && { employmentStatus: options.employmentStatus }),
      ...(options.search && {
        OR: [
          { firstName: { contains: options.search, mode: 'insensitive' } },
          { lastName: { contains: options.search, mode: 'insensitive' } },
          { workEmail: { contains: options.search, mode: 'insensitive' } },
          { employeeCode: { contains: options.search, mode: 'insensitive' } },
        ],
      }),
    }

    const [employees, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        skip,
        take,
        include: {
          user: { select: { email: true, avatarUrl: true, lastLoginAt: true } },
          orgUnit: { select: { id: true, name: true, type: true } },
          jobPosition: { select: { id: true, title: true } },
          workLocation: { select: { id: true, name: true, city: true } },
          manager: {
            include: {
              user: { select: { fullName: true, avatarUrl: true } },
            },
          },
        },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      prisma.employee.count({ where }),
    ])

    return { employees, total, page, limit }
  },

  async findById(id: string, tenantId: string) {
    return prisma.employee.findFirst({
      where: { id, tenantId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            avatarUrl: true,
            lastLoginAt: true,
            mfaEnabled: true,
            userRoles: {
              include: { role: { select: { id: true, name: true } } },
            },
          },
        },
        orgUnit: { select: { id: true, name: true, type: true } },
        jobPosition: { select: { id: true, title: true, gradeBand: true } },
        workLocation: true,
        resourceCalendar: {
          include: { days: true },
        },
        manager: {
          include: {
            user: { select: { fullName: true, avatarUrl: true } },
          },
        },
        directReports: {
          where: { active: true },
          include: {
            user: { select: { fullName: true, avatarUrl: true } },
            jobPosition: { select: { title: true } },
          },
        },
        contracts: {
          where: { active: true },
          orderBy: { effectiveFrom: 'desc' },
          take: 1,
        },
        skills: {
          include: {
            skill: {
              include: { skillType: true },
            },
            skillLevel: true,
          },
        },
        resumeLines: { orderBy: { dateStart: 'desc' } },
        _count: {
          select: {
            contracts: true,
            leaveRequests: true,
            attendanceRecords: true,
          },
        },
      },
    })
  },

  async create(tenantId: string, userId: string, data: CreateEmployeeDto, employeeCode: string) {
    return prisma.employee.create({
      data: {
        tenantId,
        userId,
        employeeCode,
        orgUnitId: data.orgUnitId,
        jobPositionId: data.jobPositionId,
        managerId: data.managerId,
        resourceCalendarId: data.resourceCalendarId,
        workLocationId: data.workLocationId,
        firstName: data.firstName,
        lastName: data.lastName,
        workEmail: data.workEmail,
        personalEmail: data.personalEmail,
        hireDate: new Date(data.hireDate),
        employmentType: data.employmentType,
        taxJurisdiction: data.taxJurisdiction,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        gender: data.gender,
        nationality: data.nationality,
        mobilePersonal: data.mobilePersonal,
        mobileWork: data.mobileWork,
        emergencyContactName: data.emergencyContactName,
        emergencyContactPhone: data.emergencyContactPhone,
        emergencyContactRelation: data.emergencyContactRelation,
      },
    })
  },

  async update(id: string, data: UpdateEmployeeDto) {
    const updateData: any = { ...data }
    if (data.dateOfBirth) updateData.dateOfBirth = new Date(data.dateOfBirth)
    if (data.probationEndDate) updateData.probationEndDate = new Date(data.probationEndDate)
    if (data.confirmationDate) updateData.confirmationDate = new Date(data.confirmationDate)

    return prisma.employee.update({
      where: { id },
      data: updateData,
    })
  },

  async archive(id: string, archivedBy: string, reason: string) {
    return prisma.employee.update({
      where: { id },
      data: {
        active: false,
        archivedAt: new Date(),
        archivedBy,
        archiveReason: reason,
        employmentStatus: 'terminated',
      },
    })
  },

  async generateEmployeeCode(tenantId: string): Promise<string> {
    const count = await prisma.employee.count({ where: { tenantId } })
    return `EMP${String(count + 1).padStart(4, '0')}`
  },

  async addSkill(employeeId: string, data: AddSkillDto) {
    return prisma.employeeSkill.create({
      data: {
        employeeId,
        skillId: data.skillId,
        skillLevelId: data.skillLevelId,
        justification: data.justification,
      },
      include: {
        skill: { include: { skillType: true } },
        skillLevel: true,
      },
    })
  },

  async removeSkill(id: string, employeeId: string) {
    return prisma.employeeSkill.deleteMany({
      where: { id, employeeId },
    })
  },

  async addResumeLine(employeeId: string, data: AddResumeLineDto) {
    return prisma.resumeLine.create({
      data: {
        employeeId,
        lineType: data.lineType,
        name: data.name,
        description: data.description,
        dateStart: data.dateStart ? new Date(data.dateStart) : undefined,
        dateEnd: data.dateEnd ? new Date(data.dateEnd) : undefined,
        organisation: data.organisation,
      },
    })
  },

  async updateResumeLine(id: string, employeeId: string, data: Partial<AddResumeLineDto>) {
    const updateData: any = { ...data }
    if (data.dateStart) updateData.dateStart = new Date(data.dateStart)
    if (data.dateEnd) updateData.dateEnd = new Date(data.dateEnd)

    return prisma.resumeLine.updateMany({
      where: { id, employeeId },
      data: updateData,
    })
  },

  async removeResumeLine(id: string, employeeId: string) {
    return prisma.resumeLine.deleteMany({
      where: { id, employeeId },
    })
  },

  async listSkillTypes(tenantId: string) {
    return prisma.skillType.findMany({
      where: { tenantId },
      include: {
        skills: {
          include: { levels: { orderBy: { sequence: 'asc' } } },
        },
      },
      orderBy: { name: 'asc' },
    })
  },
}

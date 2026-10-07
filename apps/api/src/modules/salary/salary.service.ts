import { salaryRepository } from './salary.repository'
import { CreateSalaryStructureTypeDto, CreateSalaryStructureDto, CreateSalaryRuleDto, CreateGradeBandDto } from './salary.types'
import { AppError } from '../../shared/utils/AppError'
import { prisma } from '../../infrastructure/database/prisma'

export const salaryService = {
  async listStructureTypes(tenantId: string) {
    return salaryRepository.listStructureTypes(tenantId)
  },

  async createStructureType(tenantId: string, data: CreateSalaryStructureTypeDto) {
    return salaryRepository.createStructureType(tenantId, data)
  },

  async listStructures(tenantId: string, countryCode?: string) {
    return salaryRepository.listStructures(tenantId, countryCode)
  },

  async getStructureById(id: string, tenantId: string) {
    const structure = await salaryRepository.findStructureById(id)
    if (!structure || structure.tenantId !== tenantId) throw new AppError('Salary structure not found', 404)
    return structure
  },

  async createStructure(tenantId: string, data: CreateSalaryStructureDto) {
    const structureType = await prisma.salaryStructureType.findFirst({ where: { id: data.structureTypeId, tenantId }, select: { id: true } })
    if (!structureType) throw new AppError('Salary structure type not found', 404)
    return salaryRepository.createStructure(tenantId, data)
  },

  async listRuleCategories() {
    return salaryRepository.listRuleCategories()
  },

  async createRule(tenantId: string, data: CreateSalaryRuleDto) {
    const structure = await salaryRepository.findStructureById(data.salaryStructureId)
    if (!structure || structure.tenantId !== tenantId) throw new AppError('Salary structure not found', 404)
    const category = await prisma.salaryRuleCategory.findUnique({ where: { id: data.categoryId }, select: { id: true } })
    if (!category) throw new AppError('Rule category not found', 404)
    return salaryRepository.createRule(data)
  },

  async updateRule(id: string, tenantId: string, data: Partial<CreateSalaryRuleDto>) {
    const rule = await prisma.salaryRule.findFirst({ where: { id, structure: { tenantId } }, select: { id: true } })
    if (!rule) throw new AppError('Salary rule not found', 404)
    if (data.categoryId) {
      const category = await prisma.salaryRuleCategory.findUnique({ where: { id: data.categoryId }, select: { id: true } })
      if (!category) throw new AppError('Rule category not found', 404)
    }
    return salaryRepository.updateRule(id, data)
  },

  async deleteRule(id: string, tenantId: string) {
    const rule = await prisma.salaryRule.findFirst({ where: { id, structure: { tenantId } }, select: { id: true } })
    if (!rule) throw new AppError('Salary rule not found', 404)
    return salaryRepository.deleteRule(id)
  },

  async listGradeBands(tenantId: string) {
    return salaryRepository.listGradeBands(tenantId)
  },

  async createGradeBand(tenantId: string, data: CreateGradeBandDto) {
    return salaryRepository.createGradeBand(tenantId, data)
  },

  async updateGradeBand(id: string, tenantId: string, data: Partial<CreateGradeBandDto>) {
    const band = await prisma.gradeBand.findFirst({ where: { id, tenantId }, select: { id: true } })
    if (!band) throw new AppError('Grade band not found', 404)
    return salaryRepository.updateGradeBand(id, data)
  },

  async listInputTypes(tenantId: string) {
    return salaryRepository.listInputTypes(tenantId)
  },

  async createInputType(tenantId: string, data: { name: string; code: string; category: string; description?: string }) {
    return salaryRepository.createInputType(tenantId, data)
  },

  async linkContractToStructure(contractId: string, tenantId: string, salaryStructureId: string, gradeBandId?: string) {
    const contract = await prisma.employeeContract.findFirst({ where: { id: contractId, employee: { tenantId } }, select: { id: true } })
    if (!contract) throw new AppError('Contract not found', 404)
    const structure = await prisma.salaryStructure.findFirst({ where: { id: salaryStructureId, tenantId }, select: { id: true } })
    if (!structure) throw new AppError('Salary structure not found', 404)
    if (gradeBandId) {
      const band = await prisma.gradeBand.findFirst({ where: { id: gradeBandId, tenantId }, select: { id: true } })
      if (!band) throw new AppError('Grade band not found', 404)
    }

    return prisma.employeeContract.update({
      where: { id: contractId },
      data: {
        salaryStructureId,
        ...(gradeBandId && { gradeBandId }),
      },
      include: {
        salaryStructure: { include: { rules: { where: { active: true }, orderBy: { sequence: 'asc' } } } },
        gradeBand: true,
      },
    })
  },
}

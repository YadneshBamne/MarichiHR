import { prisma } from '../../infrastructure/database/prisma'
import {
  CreateSalaryStructureTypeDto,
  CreateSalaryStructureDto,
  CreateSalaryRuleDto,
  CreateGradeBandDto,
} from './salary.types'

export const salaryRepository = {
  // ─── STRUCTURE TYPES ──────────────────────────────────────
  async listStructureTypes(tenantId: string) {
    return prisma.salaryStructureType.findMany({
      where: { tenantId, active: true },
      include: { structures: { where: { active: true }, select: { id: true, name: true, code: true, countryCode: true } } },
      orderBy: { name: 'asc' },
    })
  },

  async createStructureType(tenantId: string, data: CreateSalaryStructureTypeDto) {
    return prisma.salaryStructureType.create({
      data: { tenantId, name: data.name, wageType: data.wageType },
    })
  },

  // ─── STRUCTURES ───────────────────────────────────────────
  async listStructures(tenantId: string, countryCode?: string) {
    return prisma.salaryStructure.findMany({
      where: { tenantId, active: true, ...(countryCode && { countryCode }) },
      include: {
        structureType: { select: { id: true, name: true, wageType: true } },
        rules: {
          where: { active: true },
          include: { category: true },
          orderBy: { sequence: 'asc' },
        },
        _count: { select: { contracts: true } },
      },
      orderBy: { name: 'asc' },
    })
  },

  async findStructureById(id: string) {
    return prisma.salaryStructure.findUnique({
      where: { id },
      include: {
        structureType: true,
        rules: {
          where: { active: true },
          include: { category: true },
          orderBy: { sequence: 'asc' },
        },
      },
    })
  },

  async createStructure(tenantId: string, data: CreateSalaryStructureDto) {
    return prisma.salaryStructure.create({
      data: {
        tenantId,
        structureTypeId: data.structureTypeId,
        name: data.name,
        code: data.code,
        countryCode: data.countryCode,
        description: data.description,
      },
      include: { structureType: true },
    })
  },

  // ─── SALARY RULES ─────────────────────────────────────────
  async listRuleCategories() {
    return prisma.salaryRuleCategory.findMany({ orderBy: { sequence: 'asc' } })
  },

  async createRule(data: CreateSalaryRuleDto) {
    return prisma.salaryRule.create({
      data: {
        salaryStructureId: data.salaryStructureId,
        categoryId: data.categoryId,
        name: data.name,
        code: data.code,
        sequence: data.sequence,
        amountType: data.amountType,
        amountFixed: data.amountFixed,
        amountPercentage: data.amountPercentage,
        amountPercentageBase: data.amountPercentageBase,
        pythonCode: data.pythonCode,
        conditionSelect: data.conditionSelect || 'always',
        conditionExpr: data.conditionExpr,
        appearsOnPayslip: data.appearsOnPayslip ?? true,
      },
      include: { category: true },
    })
  },

  async updateRule(id: string, data: Partial<CreateSalaryRuleDto>) {
    return prisma.salaryRule.update({
      where: { id },
      data,
      include: { category: true },
    })
  },

  async deleteRule(id: string) {
    return prisma.salaryRule.update({
      where: { id },
      data: { active: false },
    })
  },

  // ─── GRADE BANDS ──────────────────────────────────────────
  async listGradeBands(tenantId: string) {
    return prisma.gradeBand.findMany({
      where: { tenantId, active: true },
      orderBy: { code: 'asc' },
    })
  },

  async createGradeBand(tenantId: string, data: CreateGradeBandDto) {
    return prisma.gradeBand.create({
      data: {
        tenantId,
        code: data.code,
        name: data.name,
        salaryMin: data.salaryMin,
        salaryMid: data.salaryMid,
        salaryMax: data.salaryMax,
        currency: data.currency,
      },
    })
  },

  async updateGradeBand(id: string, data: Partial<CreateGradeBandDto>) {
    return prisma.gradeBand.update({ where: { id }, data })
  },

  // ─── PAYROLL INPUT TYPES ──────────────────────────────────
  async listInputTypes(tenantId: string) {
    return prisma.payrollInputType.findMany({
      where: { tenantId, active: true },
      orderBy: { name: 'asc' },
    })
  },

  async createInputType(tenantId: string, data: { name: string; code: string; category: string; description?: string }) {
    return prisma.payrollInputType.create({
      data: { tenantId, name: data.name, code: data.code, category: data.category, description: data.description },
    })
  },
}

import { salaryRepository } from './salary.repository'
import { CreateSalaryStructureTypeDto, CreateSalaryStructureDto, CreateSalaryRuleDto, CreateGradeBandDto } from './salary.types'
import { AppError } from '../../shared/utils/AppError'
import { prisma } from '../../infrastructure/database/prisma'
import { runPayrollEngine } from '../payroll/payroll.engine'

type RuleInput = Omit<CreateSalaryRuleDto, 'salaryStructureId'> & Record<string, any>

// Unique-constraint clashes (duplicate codes) are a 409, not a 500
async function uniq<T>(p: Promise<T>, what: string): Promise<T> {
  try {
    return await p
  } catch (err: any) {
    if (err?.code === 'P2002') throw new AppError(`${what} with this code already exists`, 409)
    throw err
  }
}

// Run the whole structure (candidate rule added, or swapped in when editing) through the real payroll engine on a sample
// contract. Catches bad formulas, unknown symbols, and references to rules that only run later in the sequence.
async function dryRun(tenantId: string, structureId: string, candidate: RuleInput, replaceRuleId?: string, sampleWage = 10000) {
  const structure = await prisma.salaryStructure.findFirst({
    where: { id: structureId, tenantId },
    include: { rules: { where: { active: true }, include: { category: true } } },
  })
  if (!structure) throw new AppError('Salary structure not found', 404)
  const category = await prisma.salaryRuleCategory.findUnique({ where: { id: candidate.categoryId } })
  if (!category) throw new AppError('Rule category not found', 404)

  const others = structure.rules.filter((r) => r.id !== replaceRuleId)
  if (others.some((r) => r.code === candidate.code)) throw new AppError(`Rule code ${candidate.code} is already used in this structure`, 409)
  if (candidate.amountType === 'python_code' && !candidate.pythonCode?.trim()) throw new AppError('A formula is required for formula rules', 400)
  if (candidate.amountType === 'percentage') {
    const base = candidate.amountPercentageBase || ''
    const known = others.some((r) => r.code === base && r.sequence < candidate.sequence) || ['BASIC', 'ALW', 'GROSS', 'EMP_CONTRIB', 'DED', 'TAX', 'NET'].includes(base)
    if (!known) throw new AppError(`Percentage base "${base}" must be a category code or an earlier rule's code`, 400)
  }
  if (candidate.conditionSelect === 'python_expression' && !candidate.conditionExpr?.trim()) throw new AppError('A condition expression is required', 400)
  for (const [, code] of `${candidate.pythonCode ?? ''} ${candidate.conditionExpr ?? ''}`.matchAll(/rules\.([A-Za-z0-9_]+)/g)) {
    const ref = others.find((r) => r.code === code)
    if (!ref) throw new AppError(`rules.${code} is not a rule in this structure`, 400)
    if (ref.sequence >= candidate.sequence) throw new AppError(`rules.${code} runs later (sequence ${ref.sequence}): give this rule a higher sequence than ${ref.sequence}`, 400)
  }

  const inputCodes = (await prisma.payrollInputType.findMany({ where: { tenantId, active: true }, select: { code: true } })).map((t) => t.code)
  const toEngine = (r: any, categoryCode: string) => ({
    id: r.id ?? 'candidate', code: r.code, name: r.name, sequence: r.sequence, categoryCode,
    amountType: r.amountType, amountFixed: r.amountFixed, amountPercentage: r.amountPercentage, amountPercentageBase: r.amountPercentageBase,
    pythonCode: r.pythonCode, conditionSelect: r.conditionSelect || 'always', conditionExpr: r.conditionExpr, appearsOnPayslip: r.appearsOnPayslip ?? true,
  })
  try {
    const result = runPayrollEngine({
      rules: [...others.map((r) => toEngine(r, r.category.code)), toEngine({ ...candidate, id: replaceRuleId }, category.code)],
      contract: { wageMonthly: sampleWage, fullWageMonthly: sampleWage, ctcAnnual: sampleWage * 12, variablePayPercent: 0 },
      factor: 1, workingDays: 22, paidDays: 22, lwpDays: 0, extraLines: [],
      inputsByCode: Object.fromEntries(inputCodes.map((c) => [c, 0])),
    })
    const own = result.lines.find((l) => l.code === candidate.code)
    return {
      ok: true, sampleWage, amount: own?.amount ?? null, skippedByCondition: !own, gross: result.gross, netPay: result.netPay,
      lines: result.lines.map((l) => ({ code: l.code, name: l.name, categoryCode: l.categoryCode, amount: l.amount })), warnings: result.warnings,
    }
  } catch (e: any) {
    throw new AppError(e.message, 400)
  }
}

export const salaryService = {
  async listStructureTypes(tenantId: string) {
    return salaryRepository.listStructureTypes(tenantId)
  },

  async createStructureType(tenantId: string, data: CreateSalaryStructureTypeDto) {
    try {
      return await salaryRepository.createStructureType(tenantId, data)
    } catch (err: any) {
      if (err?.code === 'P2002') throw new AppError('A structure type with this name already exists', 409)
      throw err
    }
  },

  async updateStructureType(id: string, tenantId: string, data: { name?: string; wageType?: string; active?: boolean }) {
    const existing = await prisma.salaryStructureType.findFirst({ where: { id, tenantId }, select: { id: true } })
    if (!existing) throw new AppError('Salary structure type not found', 404)
    return prisma.salaryStructureType.update({ where: { id }, data })
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
    return uniq(salaryRepository.createStructure(tenantId, data), 'A salary structure')
  },

  async updateStructure(id: string, tenantId: string, data: { structureTypeId?: string; name?: string; countryCode?: string | null; description?: string | null; active?: boolean }) {
    const existing = await prisma.salaryStructure.findFirst({ where: { id, tenantId }, select: { id: true } })
    if (!existing) throw new AppError('Salary structure not found', 404)
    if (data.structureTypeId) {
      const type = await prisma.salaryStructureType.findFirst({ where: { id: data.structureTypeId, tenantId }, select: { id: true } })
      if (!type) throw new AppError('Salary structure type not found', 404)
    }
    if (data.active === false) {
      const live = await prisma.employeeContract.count({ where: { salaryStructureId: id, active: true, status: { in: ['new', 'draft', 'confirmed', 'running'] } } })
      if (live) throw new AppError(`${live} live contract(s) use this structure: move them first`, 409)
    }
    return prisma.salaryStructure.update({ where: { id }, data, include: { structureType: true } })
  },

  checkRule(tenantId: string, body: { salaryStructureId: string; ruleId?: string; sampleWage?: number; rule: RuleInput }) {
    return dryRun(tenantId, body.salaryStructureId, body.rule, body.ruleId, body.sampleWage)
  },

  async listRuleCategories() {
    return salaryRepository.listRuleCategories()
  },

  async createRule(tenantId: string, data: CreateSalaryRuleDto) {
    const { salaryStructureId, ...rule } = data
    await dryRun(tenantId, salaryStructureId, rule)
    return uniq(salaryRepository.createRule(data), 'A rule')
  },

  async updateRule(id: string, tenantId: string, data: Partial<CreateSalaryRuleDto>) {
    const rule = await prisma.salaryRule.findFirst({ where: { id, active: true, structure: { tenantId } } })
    if (!rule) throw new AppError('Salary rule not found', 404)
    const { id: _id, salaryStructureId, createdAt: _c, active: _a, ...current } = rule
    await dryRun(tenantId, salaryStructureId, { ...current, ...data } as RuleInput, id)
    return uniq(salaryRepository.updateRule(id, data), 'A rule')
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
    return uniq(salaryRepository.createGradeBand(tenantId, data), 'A grade band')
  },

  async updateGradeBand(id: string, tenantId: string, data: Partial<CreateGradeBandDto> & { active?: boolean }) {
    const band = await prisma.gradeBand.findFirst({ where: { id, tenantId } })
    if (!band) throw new AppError('Grade band not found', 404)
    const merged = { ...band, ...data }
    if (!(merged.salaryMin <= merged.salaryMid && merged.salaryMid <= merged.salaryMax)) throw new AppError('Band must satisfy min ≤ mid ≤ max', 400)
    return uniq(salaryRepository.updateGradeBand(id, data), 'A grade band')
  },

  // Every live-record contract in the tenant, newest first, for the contracts admin screen
  listContracts(tenantId: string, status?: string) {
    return prisma.employeeContract.findMany({
      where: { employee: { tenantId }, active: true, ...(status && { status }) },
      include: {
        employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, active: true } },
        salaryStructure: { select: { id: true, name: true, code: true } },
        gradeBand: { select: { id: true, code: true, name: true, salaryMin: true, salaryMax: true, currency: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
    })
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

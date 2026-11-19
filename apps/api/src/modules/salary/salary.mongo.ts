import crypto from 'crypto'
import mongoose from 'mongoose'
import { statutoryFor } from '../tax/statutory'
import { enableMongoStatutory } from '../tax/statutory.mongo'
import { CreateSalaryStructureTypeDto, CreateSalaryStructureDto, CreateSalaryRuleDto, CreateGradeBandDto } from './salary.types'
import { TEMPLATES, CONTRACTOR } from './starter.service'
import { AppError } from '../../shared/utils/AppError'
import { runPayrollEngine } from '../payroll/payroll.engine'
import {
  Tenant, SalaryRuleCategory, SalaryStructureType, SalaryStructure, GradeBand, EmployeeContract, Employee, PayrollInputType, AuditLog,
} from '../../infrastructure/mongo/mongo'

// MongoDB version of salary.service.ts, salary.repository.ts and starter.service.ts. A structure's rules are embedded in the
// structure document, so reading a structure with its rules is one query. Same rules, same response shapes.
// Not ported yet (they belong to the payroll stage): salary revisions and pay review.

enableMongoStatutory()

type RuleInput = Omit<CreateSalaryRuleDto, 'salaryStructureId'> & Record<string, any>
const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }

// A duplicate key (E11000) is a 409, not a 500
async function uniq<T>(p: Promise<T>, what: string): Promise<T> {
  try { return await p } catch (err: any) {
    if (err?.code === 11000) throw new AppError(`${what} with this code already exists`, 409)
    throw err
  }
}

const categories = async () => new Map<string, any>((await SalaryRuleCategory.find().sort({ sequence: 1 }).lean() as any[]).map((c) => [c._id, ser(c)]))
const ruleView = (r: any, cats: Map<string, any>) => ({ ...ser(r), category: cats.get(r.categoryId) })
const activeRules = (s: any) => (s.rules || []).filter((r: any) => r.active).sort((a: any, b: any) => a.sequence - b.sequence)

// Run the whole structure (candidate rule added, or swapped in when editing) through the real payroll engine on a sample contract
async function dryRun(tenantId: string, structureId: string, candidate: RuleInput, replaceRuleId?: string, sampleWage = 10000) {
  const structure: any = await SalaryStructure.findOne({ _id: structureId, tenantId }).lean()
  if (!structure) throw new AppError('Salary structure not found', 404)
  const category: any = await SalaryRuleCategory.findById(candidate.categoryId).lean()
  if (!category) throw new AppError('Rule category not found', 404)

  const others = activeRules(structure).filter((r: any) => r._id !== replaceRuleId)
  if (others.some((r: any) => r.code === candidate.code)) throw new AppError(`Rule code ${candidate.code} is already used in this structure`, 409)
  if (candidate.amountType === 'python_code' && !candidate.pythonCode?.trim()) throw new AppError('A formula is required for formula rules', 400)
  if (candidate.amountType === 'percentage') {
    const base = candidate.amountPercentageBase || ''
    const known = others.some((r: any) => r.code === base && r.sequence < candidate.sequence) || ['BASIC', 'ALW', 'GROSS', 'EMP_CONTRIB', 'DED', 'TAX', 'NET'].includes(base)
    if (!known) throw new AppError(`Percentage base "${base}" must be a category code or an earlier rule's code`, 400)
  }
  if (candidate.conditionSelect === 'python_expression' && !candidate.conditionExpr?.trim()) throw new AppError('A condition expression is required', 400)
  for (const [, code] of `${candidate.pythonCode ?? ''} ${candidate.conditionExpr ?? ''}`.matchAll(/rules\.([A-Za-z0-9_]+)/g)) {
    const ref = others.find((r: any) => r.code === code)
    if (!ref) throw new AppError(`rules.${code} is not a rule in this structure`, 400)
    if (ref.sequence >= candidate.sequence) throw new AppError(`rules.${code} runs later (sequence ${ref.sequence}): give this rule a higher sequence than ${ref.sequence}`, 400)
  }

  const inputCodes = ((await PayrollInputType.find({ tenantId, active: true }).select('code').lean()) as any[]).map((t) => t.code)
  const toEngine = (r: any, categoryCode: string) => ({
    id: r._id ?? r.id ?? 'candidate', code: r.code, name: r.name, sequence: r.sequence, categoryCode,
    amountType: r.amountType, amountFixed: r.amountFixed, amountPercentage: r.amountPercentage, amountPercentageBase: r.amountPercentageBase,
    pythonCode: r.pythonCode, conditionSelect: r.conditionSelect || 'always', conditionExpr: r.conditionExpr, appearsOnPayslip: r.appearsOnPayslip ?? true,
  })
  const today = new Date().toISOString().slice(0, 10)
  try {
    const result = runPayrollEngine({
      rules: [...others.map((r: any) => toEngine(r, r.categoryCode)), toEngine({ ...candidate, id: replaceRuleId }, category.code)],
      contract: { wageMonthly: sampleWage, fullWageMonthly: sampleWage, ctcAnnual: sampleWage * 12, variablePayPercent: 0 },
      factor: 1, workingDays: 22, paidDays: 22, lwpDays: 0, extraLines: [],
      inputsByCode: Object.fromEntries(inputCodes.map((c) => [c, 0])),
      statutory: { at: today, tables: await statutoryFor(today, tenantId) },
    } as any)
    const own = result.lines.find((l: any) => l.code === candidate.code)
    return {
      ok: true, sampleWage, amount: own?.amount ?? null, skippedByCondition: !own, gross: result.gross, netPay: result.netPay,
      lines: result.lines.map((l: any) => ({ code: l.code, name: l.name, categoryCode: l.categoryCode, amount: l.amount })), warnings: result.warnings,
    }
  } catch (e: any) {
    throw new AppError(e.message, 400)
  }
}

const structureQuery = (tenantId: string, extra: object = {}) => ({ tenantId, ...extra })

export const salaryService = {
  async listStructureTypes(tenantId: string) {
    const [types, structures]: any[] = await Promise.all([SalaryStructureType.find({ tenantId, active: true }).sort({ name: 1 }).collation({ locale: 'en', strength: 2 }).lean(), SalaryStructure.find({ tenantId, active: true }).select('structureTypeId name code countryCode').lean()])
    return types.map((t: any) => ({ ...ser(t), structures: structures.filter((s: any) => s.structureTypeId === t._id).map((s: any) => ({ id: s._id, name: s.name, code: s.code, countryCode: s.countryCode ?? null })) }))
  },

  async createStructureType(tenantId: string, data: CreateSalaryStructureTypeDto) {
    try { return ser((await SalaryStructureType.create({ tenantId, name: data.name, wageType: data.wageType })).toObject()) } catch (err: any) {
      if (err?.code === 11000) throw new AppError('A structure type with this name already exists', 409)
      throw err
    }
  },

  async updateStructureType(id: string, tenantId: string, data: { name?: string; wageType?: string; active?: boolean }) {
    const updated = await SalaryStructureType.findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { returnDocument: 'after' }).lean()
    if (!updated) throw new AppError('Salary structure type not found', 404)
    return ser(updated)
  },

  async listStructures(tenantId: string, countryCode?: string) {
    const [rows, cats]: any[] = await Promise.all([SalaryStructure.find({ tenantId, active: true, ...(countryCode && { countryCode }) }).collation({ locale: 'en', strength: 2 }).sort({ name: 1 }).lean(), categories()])
    const types: any[] = await SalaryStructureType.find({ _id: { $in: rows.map((s: any) => s.structureTypeId) } }).lean()
    const counts: any[] = await EmployeeContract.aggregate([{ $match: { tenantId, salaryStructureId: { $in: rows.map((s: any) => s._id) } } }, { $group: { _id: '$salaryStructureId', n: { $sum: 1 } } }])
    const T = new Map(types.map((t) => [t._id, t])), C = new Map(counts.map((c) => [c._id, c.n]))
    return rows.map((s: any) => ({ ...ser({ ...s, rules: undefined }), structureType: T.get(s.structureTypeId) && { id: s.structureTypeId, name: T.get(s.structureTypeId).name, wageType: T.get(s.structureTypeId).wageType }, rules: activeRules(s).map((r: any) => ruleView(r, cats)), _count: { contracts: C.get(s._id) ?? 0 } }))
  },

  async getStructureById(id: string, tenantId: string) {
    const s: any = await SalaryStructure.findOne({ _id: id, tenantId }).lean()
    if (!s) throw new AppError('Salary structure not found', 404)
    const [cats, type]: any[] = await Promise.all([categories(), SalaryStructureType.findById(s.structureTypeId).lean()])
    return { ...ser({ ...s, rules: undefined }), structureType: ser(type), rules: activeRules(s).map((r: any) => ruleView(r, cats)) }
  },

  async createStructure(tenantId: string, data: CreateSalaryStructureDto) {
    const type: any = await SalaryStructureType.findOne({ _id: data.structureTypeId, tenantId }).lean()
    if (!type) throw new AppError('Salary structure type not found', 404)
    const created: any = await uniq(SalaryStructure.create({ tenantId, structureTypeId: data.structureTypeId, name: data.name, code: data.code, countryCode: data.countryCode, description: data.description }), 'A salary structure')
    return { ...ser(created.toObject()), structureType: ser(type) }
  },

  async updateStructure(id: string, tenantId: string, data: { structureTypeId?: string; name?: string; countryCode?: string | null; description?: string | null; active?: boolean }) {
    if (!(await SalaryStructure.exists({ _id: id, tenantId }))) throw new AppError('Salary structure not found', 404)
    if (data.structureTypeId && !(await SalaryStructureType.exists({ _id: data.structureTypeId, tenantId }))) throw new AppError('Salary structure type not found', 404)
    if (data.active === false) {
      const live = await EmployeeContract.countDocuments({ salaryStructureId: id, active: true, status: { $in: ['new', 'draft', 'confirmed', 'running'] } })
      if (live) throw new AppError(`${live} live contract(s) use this structure: move them first`, 409)
    }
    const updated: any = await SalaryStructure.findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { returnDocument: 'after' }).lean()
    const type: any = await SalaryStructureType.findById(updated.structureTypeId).lean()
    return { ...ser({ ...updated, rules: undefined }), structureType: ser(type) }
  },

  checkRule(tenantId: string, body: { salaryStructureId: string; ruleId?: string; sampleWage?: number; rule: RuleInput }) {
    return dryRun(tenantId, body.salaryStructureId, body.rule, body.ruleId, body.sampleWage)
  },

  async listRuleCategories() {
    return [...(await categories()).values()]
  },

  async createRule(tenantId: string, data: CreateSalaryRuleDto) {
    const { salaryStructureId, ...rule } = data
    await dryRun(tenantId, salaryStructureId, rule)
    const cat: any = await SalaryRuleCategory.findById(data.categoryId).lean()
    const sub = {
      _id: crypto.randomUUID(), categoryId: data.categoryId, categoryCode: cat.code, name: data.name, code: data.code, sequence: data.sequence, amountType: data.amountType,
      amountFixed: data.amountFixed, amountPercentage: data.amountPercentage, amountPercentageBase: data.amountPercentageBase, pythonCode: data.pythonCode,
      conditionSelect: data.conditionSelect || 'always', conditionExpr: data.conditionExpr, appearsOnPayslip: data.appearsOnPayslip ?? true, active: true, createdAt: new Date(),
    }
    // the filter makes the "code is unique within the structure" rule hold even when two requests race
    const r = await SalaryStructure.updateOne({ _id: salaryStructureId, tenantId, rules: { $not: { $elemMatch: { code: data.code, active: true } } } }, { $push: { rules: sub } })
    if (!r.matchedCount) throw new AppError('A rule with this code already exists', 409)
    return { ...ser(sub), salaryStructureId, category: ser(cat) }
  },

  async updateRule(id: string, tenantId: string, data: Partial<CreateSalaryRuleDto>) {
    const s: any = await SalaryStructure.findOne({ tenantId, rules: { $elemMatch: { _id: id, active: true } } }).lean()
    const rule = s?.rules.find((r: any) => r._id === id)
    if (!rule) throw new AppError('Salary rule not found', 404)
    const { _id, createdAt, active, categoryCode, ...current } = rule
    const { salaryStructureId: _drop, ...patch } = data as any
    await dryRun(tenantId, s._id, { ...current, ...patch } as RuleInput, id)
    const set: Record<string, unknown> = Object.fromEntries(Object.entries(patch).map(([k, v]) => [`rules.$[r].${k}`, v]))
    if (patch.categoryId) set['rules.$[r].categoryCode'] = ((await SalaryRuleCategory.findById(patch.categoryId).lean()) as any).code
    const updated: any = await uniq(SalaryStructure.findOneAndUpdate({ _id: s._id }, { $set: set }, { arrayFilters: [{ 'r._id': id }], returnDocument: 'after' }).lean(), 'A rule')
    const cats = await categories()
    return { ...ruleView(updated.rules.find((r: any) => r._id === id), cats), salaryStructureId: s._id }
  },

  async deleteRule(id: string, tenantId: string) {
    const r = await SalaryStructure.updateOne({ tenantId, 'rules._id': id }, { $set: { 'rules.$[r].active': false } }, { arrayFilters: [{ 'r._id': id }] })
    if (!r.matchedCount) throw new AppError('Salary rule not found', 404)
    return { id, active: false }
  },

  async listGradeBands(tenantId: string) {
    return ((await GradeBand.find({ tenantId, active: true }).sort({ code: 1 }).lean()) as any[]).map(ser)
  },

  async createGradeBand(tenantId: string, data: CreateGradeBandDto) {
    return ser((await uniq(GradeBand.create({ tenantId, ...data }), 'A grade band') as any).toObject())
  },

  async updateGradeBand(id: string, tenantId: string, data: Partial<CreateGradeBandDto> & { active?: boolean }) {
    const band: any = await GradeBand.findOne({ _id: id, tenantId }).lean()
    if (!band) throw new AppError('Grade band not found', 404)
    const merged = { ...band, ...data }
    if (!(merged.salaryMin <= merged.salaryMid && merged.salaryMid <= merged.salaryMax)) throw new AppError('Band must satisfy min ≤ mid ≤ max', 400)
    return ser(await uniq(GradeBand.findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { returnDocument: 'after' }).lean(), 'A grade band'))
  },

  // Every live-record contract in the company, newest first, for the contracts admin screen
  async listContracts(tenantId: string, status?: string) {
    const rows: any[] = await EmployeeContract.find({ tenantId, active: true, ...(status && { status }) }).sort({ createdAt: -1 }).lean()
    const [emps, structures, bands]: any[] = await Promise.all([
      Employee.find({ _id: { $in: rows.map((c) => c.employeeId) } }).select('employeeCode firstName lastName active').lean(),
      SalaryStructure.find({ _id: { $in: rows.map((c) => c.salaryStructureId).filter(Boolean) } }).select('name code').lean(),
      GradeBand.find({ _id: { $in: rows.map((c) => c.gradeBandId).filter(Boolean) } }).lean(),
    ])
    const E = new Map(emps.map((e: any) => [e._id, e])), S = new Map(structures.map((s: any) => [s._id, s])), G = new Map(bands.map((b: any) => [b._id, b]))
    return rows.map((c) => {
      const e: any = E.get(c.employeeId), s: any = S.get(c.salaryStructureId), g: any = G.get(c.gradeBandId)
      return { ...ser({ ...c, stateTransitions: undefined }), employee: e && { id: e._id, employeeCode: e.employeeCode, firstName: e.firstName, lastName: e.lastName, active: e.active },
        salaryStructure: s ? { id: s._id, name: s.name, code: s.code } : null, gradeBand: g ? { id: g._id, code: g.code, name: g.name, salaryMin: g.salaryMin, salaryMax: g.salaryMax, currency: g.currency } : null }
    })
  },

  async listInputTypes(tenantId: string) {
    return ((await PayrollInputType.find({ tenantId, active: true }).sort({ name: 1 }).lean()) as any[]).map(ser)
  },

  async createInputType(tenantId: string, data: { name: string; code: string; category: string; description?: string }) {
    return ser((await PayrollInputType.create({ tenantId, ...data, active: true })).toObject())
  },

  async linkContractToStructure(contractId: string, tenantId: string, salaryStructureId: string, gradeBandId?: string) {
    if (!(await EmployeeContract.exists({ _id: contractId, tenantId }))) throw new AppError('Contract not found', 404)
    const structure: any = await SalaryStructure.findOne({ _id: salaryStructureId, tenantId }).lean()
    if (!structure) throw new AppError('Salary structure not found', 404)
    let band: any = null
    if (gradeBandId) { band = await GradeBand.findOne({ _id: gradeBandId, tenantId }).lean(); if (!band) throw new AppError('Grade band not found', 404) }
    const updated: any = await EmployeeContract.findOneAndUpdate({ _id: contractId, tenantId }, { $set: { salaryStructureId, ...(gradeBandId && { gradeBandId }) } }, { returnDocument: 'after' }).lean()
    const cats = await categories()
    return { ...ser({ ...updated, stateTransitions: undefined }), salaryStructure: { ...ser({ ...structure, rules: undefined }), rules: activeRules(structure).map((r: any) => ruleView(r, cats)) }, gradeBand: ser(band) }
  },
}

// ─── One-click starter structure for the company's country ───
export async function createStarterStructure(tenantId: string, userId: string, kind: 'employee' | 'contractor' = 'employee') {
  const tenant: any = await Tenant.findById(tenantId).select('primaryCountry').lean()
  if (kind === 'contractor' && !(tenant?.primaryCountry && CONTRACTOR[tenant.primaryCountry])) throw new AppError('A contractor structure is ready for Zambia and India; set the company country first', 400)
  const key = tenant?.primaryCountry && TEMPLATES[tenant.primaryCountry] ? tenant.primaryCountry : 'DEFAULT'
  const t = kind === 'contractor' ? CONTRACTOR[key] : TEMPLATES[key]
  const code = `${key === 'DEFAULT' ? 'STD' : key}-${kind === 'contractor' ? 'CONTRACTOR' : 'MONTHLY'}-STARTER`
  if (await SalaryStructure.exists({ tenantId, code })) throw new AppError('The starter structure already exists; edit it under Structures & rules', 409)
  const cats = new Map<string, any>(((await SalaryRuleCategory.find().lean()) as any[]).map((c) => [c.code, c]))
  const type: any = (await SalaryStructureType.findOne({ tenantId, active: true, wageType: 'monthly' }).lean()) ?? (await SalaryStructureType.create({ tenantId, name: 'Monthly Employee', wageType: 'monthly' })).toObject()
  const structure: any = (await uniq(SalaryStructure.create({
    tenantId, structureTypeId: type._id, name: t.name, code, countryCode: key === 'DEFAULT' ? null : key, description: t.description,
    rules: t.rules.map((r, i) => ({ categoryId: cats.get(r.cat)._id, categoryCode: r.cat, name: r.name, code: r.code, sequence: (i + 1) * 10, amountType: r.fixed != null ? 'fixed' : 'python_code', amountFixed: r.fixed ?? undefined, pythonCode: r.formula, appearsOnPayslip: r.payslip ?? true })),
  }), 'The starter structure')).toObject()
  await AuditLog.create({ tenantId, userId, action: 'SALARY_STRUCTURE_CREATED', entityType: 'salary_structure', entityId: structure._id, newValue: { name: t.name, starter: true } })
  return ser({ ...structure, rules: undefined })
}

// Self-check: node -r dotenv/config -r ts-node/register/transpile-only src/modules/salary/salary.mongo.ts  (needs the reference data copy; creates a workspace, then deletes it)
if (require.main === module) {
  ;(async () => {
    const { connectMongo, syncMongoIndexes, DomainEvent } = await import('../../infrastructure/mongo/mongo')
    const { bootstrapCompany } = await import('../company/company.bootstrap.mongo')
    const { contractService } = await import('../employees/contracts.mongo')
    const { employeeService } = await import('../employees/employees.mongo')
    await connectMongo()
    await syncMongoIndexes()
    const slug = `salcheck-${Date.now()}`
    const { tenantId, userId } = await bootstrapCompany({ companyName: 'Salcheck Ltd', slug, email: `${slug}@example.com`, fullName: 'Owner One', passwordHash: 'x' })
    const status = async (p: Promise<any>) => p.then(() => 0, (e) => e.statusCode ?? e.status ?? -1)
    try {
      console.assert((await status(createStarterStructure(tenantId, userId))) === 0, 'starter (no country: standard) created')
      await Tenant.updateOne({ _id: tenantId }, { primaryCountry: 'ZM', baseCurrency: 'ZMW' })
      const zm: any = await createStarterStructure(tenantId, userId)
      console.assert(zm.code === 'ZM-MONTHLY-STARTER' && zm.name === 'Zambia Standard Monthly', 'Zambia starter created')
      console.assert((await status(createStarterStructure(tenantId, userId))) === 409, 'second starter is 409')
      const full: any = await salaryService.getStructureById(zm.id, tenantId)
      console.assert(full.rules.length === 10 && full.rules[0].category.code === 'BASIC' && full.rules[9].category.code === 'NET', 'structure reads back with 10 ordered rules and categories')
      // the real engine + the copied statutory tables: a K10,000 wage through the Zambia starter
      const probe: any = await salaryService.checkRule(tenantId, { salaryStructureId: zm.id, sampleWage: 10000, rule: { categoryId: full.rules[0].category.id, name: 'Probe', code: 'PROBE', sequence: 5, amountType: 'fixed', amountFixed: 0 } as any })
      const line = (c: string) => probe.lines.find((l: any) => l.code === c)?.amount
      console.assert(line('BASIC') === 6000 && line('HOUSING') === 2500 && line('TRANSPORT') === 1500, 'basic 60 / housing 25 / transport 15 of 10,000')
      console.assert(probe.gross === 10000 && line('PAYE_ZM') > 0 && line('NAPSA_EMP') > 0 && probe.netPay < 10000, 'gross, PAYE and NAPSA come from the statutory tables')
      // rule rules
      const alw: any = (await salaryService.listRuleCategories()).find((c: any) => c.code === 'ALW')
      const added: any = await salaryService.createRule(tenantId, { salaryStructureId: zm.id, categoryId: alw.id, name: 'Lunch', code: 'LUNCH', sequence: 25, amountType: 'fixed', amountFixed: 100 } as any)
      console.assert(added.id && added.category.code === 'ALW', 'rule added')
      console.assert((await status(salaryService.createRule(tenantId, { salaryStructureId: zm.id, categoryId: alw.id, name: 'Lunch 2', code: 'LUNCH', sequence: 26, amountType: 'fixed', amountFixed: 5 } as any))) === 409, 'duplicate rule code is 409')
      console.assert((await status(salaryService.createRule(tenantId, { salaryStructureId: zm.id, categoryId: alw.id, name: 'Bad', code: 'BAD', sequence: 27, amountType: 'python_code', pythonCode: 'result = rules.NOPE * 2' } as any))) === 400, 'a formula pointing at an unknown rule is 400')
      const edited: any = await salaryService.updateRule(added.id, tenantId, { amountFixed: 150 })
      console.assert(edited.amountFixed === 150, 'rule edited')
      await salaryService.deleteRule(added.id, tenantId)
      console.assert((await salaryService.getStructureById(zm.id, tenantId) as any).rules.length === 10, 'deleted rule leaves the list')
      // grade bands
      const band: any = await salaryService.createGradeBand(tenantId, { code: 'B1', name: 'Band 1', salaryMin: 1000, salaryMid: 2000, salaryMax: 3000, currency: 'ZMW' })
      console.assert((await status(salaryService.updateGradeBand(band.id, tenantId, { salaryMin: 5000 }))) === 400, 'band min above mid refused')
      // contracts: employee, minimum wage, create, link, walk the state machine
      const unit: any = await (await import('../../infrastructure/mongo/mongo')).OrgUnit.findOne({ tenantId }).lean()
      const emp: any = (await employeeService.create(tenantId, { firstName: 'Ruth', lastName: 'Phiri', workEmail: `ruth.${slug}@example.com`, orgUnitId: unit._id, hireDate: '2026-11-01', employmentType: 'full_time' } as any, userId)).employee
      const base = { employeeId: emp.id, ctcAnnual: 120000, wageMonthly: 10000, currency: 'ZMW', effectiveFrom: '2026-11-01', salaryStructureId: zm.id, gradeBandId: band.id }
      const minWage: any = (await statutoryFor('2026-11-02', tenantId))['ZM_MIN_WAGE']?.monthly
      if (minWage) console.assert((await status(contractService.create({ ...base, wageMonthly: minWage - 1 } as any, tenantId, userId))) === 400, `wage below the ${minWage} minimum is refused`)
      console.assert((await status(contractService.create({ ...base, salaryStructureId: 'nope' } as any, tenantId, userId))) === 404, 'unknown structure is 404')
      const c: any = await contractService.create(base as any, tenantId, userId)
      console.assert(c.status === 'new' && c.employee.employeeCode === 'EMP0002', 'contract created as new with the employee attached')
      console.assert((await status(contractService.transition(c.id, 'running', tenantId, userId))) === 400, 'new -> running is refused')
      for (const to of ['draft', 'confirmed', 'running'] as const) await contractService.transition(c.id, to, tenantId, userId)
      const owner: any = { userId, tenantId, employeeId: undefined, roleIds: ['payroll_admin'] }
      const got: any = await contractService.getById(c.id, owner)
      console.assert(got.status === 'running' && got.stateTransitions.length === 3 && got.stateTransitions[0].toState === 'running', 'three transitions recorded, newest first')
      console.assert((await status(contractService.getById(c.id, { ...owner, roleIds: ['hr_admin'] }))) === 404, 'HR admin cannot open a contract')
      console.assert((await status(contractService.getById(c.id, { ...owner, tenantId: 'other-company' }))) === 404, 'another company cannot open it')
      console.assert((await status(salaryService.updateStructure(zm.id, tenantId, { active: false }))) === 409, 'a structure with a live contract cannot be archived')
      const list: any = await salaryService.listContracts(tenantId, 'running')
      console.assert(list.length === 1 && list[0].salaryStructure.code === 'ZM-MONTHLY-STARTER' && list[0].gradeBand.code === 'B1', 'contract list joins employee, structure and band')
      // the daily jobs
      await EmployeeContract.updateOne({ _id: c.id }, { effectiveUntil: new Date('2026-10-31T00:00:00.000Z') })
      console.assert((await contractService.runAutoExpireCron(tenantId)) === 1, 'the expiry job expires a contract past its end date')
      console.assert(((await contractService.getById(c.id, owner)) as any).status === 'expired', 'and it is expired')
      console.assert((await DomainEvent.countDocuments({ tenantId, type: 'contract.expired' })) === 1, 'an event is recorded')
      console.log('salary + contracts self-check done')
    } finally {
      const emps: any[] = await Employee.find({ tenantId }).select('_id').lean()
      const col = (n: string) => mongoose.connection.collection(n)
      await col('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } } as any)
      const users: any[] = await (await import('../../infrastructure/mongo/mongo')).User.find({ tenantId }).select('_id').lean()
      await col('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } } as any)
      for (const n of ['roles', 'users', 'org_units', 'employees', 'audit_logs', 'domain_events', 'employee_position_history', 'leave_types', 'activity_types', 'expense_categories', 'payroll_input_types', 'shift_templates', 'resource_calendars', 'salary_structure_types', 'salary_structures', 'grade_bands', 'employee_contracts']) await col(n).deleteMany({ tenantId } as any)
      await Tenant.deleteOne({ _id: tenantId })
      await mongoose.disconnect()
    }
  })().catch((e) => { console.error(e); process.exit(1) })
}

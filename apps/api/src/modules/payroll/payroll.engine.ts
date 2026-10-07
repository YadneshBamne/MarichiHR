import { evaluateRuleExpression, evaluateCondition } from './payroll.expression'
import { computeZraPaye, computeIndiaTdsPlaceholder } from './payroll.config'

export interface EngineRule {
  id: string
  code: string
  name: string
  sequence: number
  categoryCode: string
  amountType: string
  amountFixed?: number | null
  amountPercentage?: number | null
  amountPercentageBase?: string | null
  pythonCode?: string | null
  conditionSelect: string
  conditionExpr?: string | null
  appearsOnPayslip: boolean
}

export interface EngineExtraLine {
  code: string
  name: string
  categoryCode: 'ALW' | 'DED'
  amount: number
  computationMethod: string
  sourceRefType: string
  sourceRefId: string
}

export interface EngineReimbursementLine {
  claimId: string
  categoryName: string
  expenseDate: string
  amount: number
}

export interface EngineInput {
  rules: EngineRule[]
  contract: {
    wageMonthly: number       // ALREADY prorated by the caller
    fullWageMonthly: number
    ctcAnnual: number
    variablePayPercent: number
  }
  factor: number
  workingDays: number
  paidDays: number
  lwpDays: number
  extraLines: EngineExtraLine[]
  inputsByCode: Record<string, number>
  // Paid after tax: never fed into any rule category, so gross and tax are unaffected
  reimbursementLines?: EngineReimbursementLine[]
}

export interface EngineLine {
  ruleId?: string
  code: string
  name: string
  categoryCode: string
  sequence: number
  amount: number
  computationMethod: string
  formulaUsed?: string
  sourceRefType?: string
  sourceRefId?: string
  appearsOnPayslip: boolean
}

export interface EngineResult {
  lines: EngineLine[]
  gross: number
  totalDeductions: number
  netPay: number
  reimbursementTotal: number
  categories: Record<string, number>
  warnings: string[]
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function runPayrollEngine(input: EngineInput): EngineResult {
  const categories: Record<string, number> = {
    BASIC: 0, ALW: 0, GROSS: 0, EMP_CONTRIB: 0, DED: 0, TAX: 0, NET: 0,
  }
  const rulesAmounts: Record<string, number> = {}
  const lines: EngineLine[] = []
  const warnings: string[] = []
  const ranCategories = new Set<string>()

  // Pre-seed overtime + approved payroll inputs so GROSS / DED rules include them
  for (const extra of input.extraLines) {
    const amount = round2(extra.amount)
    categories[extra.categoryCode] = round2((categories[extra.categoryCode] ?? 0) + amount)
    rulesAmounts[extra.code] = round2((rulesAmounts[extra.code] ?? 0) + amount)
    lines.push({
      code: extra.code,
      name: extra.name,
      categoryCode: extra.categoryCode,
      sequence: 1,
      amount,
      computationMethod: extra.computationMethod,
      sourceRefType: extra.sourceRefType,
      sourceRefId: extra.sourceRefId,
      appearsOnPayslip: true,
    })
  }

  const buildScope = () => ({
    contract: { ...input.contract },
    categories: { ...categories },
    rules: { ...rulesAmounts },
    inputs: { ...input.inputsByCode },
    payslip: {
      paidDays: input.paidDays,
      lwpDays: input.lwpDays,
      workingDays: input.workingDays,
      factor: input.factor,
    },
    compute_zra_paye: (x: number) => computeZraPaye(Number(x)),
    compute_india_tds: (_gross: number, _ded: number) => computeIndiaTdsPlaceholder(),
  })

  const sorted = [...input.rules].sort((a, b) => a.sequence - b.sequence)

  for (const rule of sorted) {
    const scope = buildScope()

    if (rule.conditionSelect === 'python_expression' && rule.conditionExpr) {
      let ok = true
      try {
        ok = evaluateCondition(rule.conditionExpr, scope)
      } catch (e: any) {
        throw new Error(`Rule ${rule.code} condition failed: ${e.message}`)
      }
      if (!ok) continue
    }

    let amount = 0
    let formula: string | undefined
    let method = rule.amountType

    try {
      if (rule.amountType === 'fixed') {
        amount = rule.amountFixed ?? 0
        if (rule.categoryCode === 'BASIC' || rule.categoryCode === 'ALW') amount *= input.factor
      } else if (rule.amountType === 'percentage') {
        const baseKey = rule.amountPercentageBase || ''
        const base = rulesAmounts[baseKey] ?? categories[baseKey] ?? 0
        amount = base * (rule.amountPercentage ?? 0)
        formula = `${baseKey} (${round2(base)}) × ${rule.amountPercentage}`
      } else if (rule.amountType === 'python_code') {
        if (!rule.pythonCode) throw new Error('No formula defined')
        amount = evaluateRuleExpression(rule.pythonCode, scope)
        formula = rule.pythonCode
      } else {
        throw new Error(`Unknown amount type: ${rule.amountType}`)
      }
    } catch (e: any) {
      throw new Error(`Rule ${rule.code} failed: ${e.message}`)
    }

    amount = round2(amount)
    categories[rule.categoryCode] = round2((categories[rule.categoryCode] ?? 0) + amount)
    rulesAmounts[rule.code] = amount
    ranCategories.add(rule.categoryCode)

    lines.push({
      ruleId: rule.id,
      code: rule.code,
      name: rule.name,
      categoryCode: rule.categoryCode,
      sequence: rule.sequence,
      amount,
      computationMethod: method,
      formulaUsed: formula,
      sourceRefType: 'salary_rule',
      sourceRefId: rule.id,
      appearsOnPayslip: rule.appearsOnPayslip,
    })
  }

  const gross = ranCategories.has('GROSS')
    ? categories.GROSS
    : round2(categories.BASIC + categories.ALW)
  const totalDeductions = round2(categories.DED + categories.TAX)
  const computedNet = round2(gross - totalDeductions)
  const netBeforeReimbursements = ranCategories.has('NET') ? categories.NET : computedNet

  if (!ranCategories.has('BASIC')) warnings.push('Structure has no BASIC rule')
  if (!ranCategories.has('GROSS')) warnings.push('Structure has no GROSS rule — gross computed as BASIC + ALW')
  if (ranCategories.has('NET') && Math.abs(netBeforeReimbursements - computedNet) > 0.01) {
    warnings.push(`NET rule (${netBeforeReimbursements}) differs from gross − deductions (${computedNet})`)
  }
  if (netBeforeReimbursements < 0) warnings.push('Net pay is negative')

  // Reimbursements are added to the final net only, after tax
  let reimbursementTotal = 0
  ;(input.reimbursementLines ?? []).forEach((r, i) => {
    const amount = round2(r.amount)
    reimbursementTotal = round2(reimbursementTotal + amount)
    lines.push({
      code: `REIMB_${i + 1}`,
      name: `Reimbursement — ${r.categoryName} (${r.expenseDate})`,
      categoryCode: 'REIMB',
      sequence: 900 + i,
      amount,
      computationMethod: 'reimbursement',
      sourceRefType: 'reimbursement_claim',
      sourceRefId: r.claimId,
      appearsOnPayslip: true,
    })
  })
  const netPay = round2(netBeforeReimbursements + reimbursementTotal)

  return { lines, gross, totalDeductions, netPay, reimbursementTotal, categories, warnings }
}

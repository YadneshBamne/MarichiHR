import { prisma } from '../../infrastructure/database/prisma'

// Statutory tables (statutory_tables) resolved for a date, plus the pure calculators the payroll engine exposes
// to salary-rule formulas: compute_zra_paye, napsa_employee/employer, nhima_employee/employer, compute_india_tds.

export type Band = { upTo: number | null; rate: number }
export type StatutoryParams = Record<string, any>
export interface IndiaYtd { gross: number; tax: number; monthsLeft: number } // monthsLeft includes the current month
export interface StatutoryContext { at: string; tables: Record<string, StatutoryParams>; indiaYtd?: IndiaYtd }

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

// Tax on `amount` across progressive bands
export function bandTax(amount: number, bands: Band[]): number {
  let tax = 0
  let lower = 0
  for (const b of bands) {
    if (amount <= lower) break
    const upper = b.upTo ?? Infinity
    tax += (Math.min(amount, upper) - lower) * b.rate
    lower = upper
  }
  return tax
}

// ponytail: rows cached for 10 minutes per process; tables only change through migrations
let cache: { at: number; rows: { code: string; effectiveFrom: Date; params: any }[] } | null = null
async function rows() {
  if (!cache || Date.now() - cache.at > 600_000) {
    cache = { at: Date.now(), rows: await prisma.statutoryTable.findMany({ select: { code: true, effectiveFrom: true, params: true }, orderBy: { effectiveFrom: 'asc' } }) }
  }
  return cache.rows
}

// The version of every table in force on `date` (YYYY-MM-DD)
export async function statutoryFor(date: string): Promise<Record<string, StatutoryParams>> {
  const out: Record<string, StatutoryParams> = {}
  for (const r of await rows()) if (r.effectiveFrom.toISOString().slice(0, 10) <= date) out[r.code] = r.params
  return out
}

function table(ctx: StatutoryContext, code: string) {
  const t = ctx.tables[code]
  if (!t) throw new Error(`No ${code} table is in force on ${ctx.at}`)
  return t
}

export function statutoryFunctions(ctx: StatutoryContext, warn: (w: string) => void) {
  const napsa = (gross: number, side: 'employeeRate' | 'employerRate') => {
    const t = table(ctx, 'ZM_NAPSA')
    return round2(Math.min(Math.max(0, Number(gross)), t.monthlyCeiling) * t[side])
  }
  const nhima = (basic: number, side: 'employeeRate' | 'employerRate') => round2(Math.max(0, Number(basic)) * table(ctx, 'ZM_NHIMA')[side])
  return {
    // Zambia: monthly, non-cumulative, on gross emoluments
    compute_zra_paye: (x: number) => round2(bandTax(Math.max(0, Number(x)), table(ctx, 'ZM_PAYE').bands)),
    napsa_employee: (gross: number) => napsa(gross, 'employeeRate'),
    napsa_employer: (gross: number) => napsa(gross, 'employerRate'),
    nhima_employee: (basic: number) => nhima(basic, 'employeeRate'),
    nhima_employer: (basic: number) => nhima(basic, 'employerRate'),
    // India, new regime, cumulative method: project the year's income from what was paid so far plus this month
    // for the rest of the year, take the year's tax less tax already deducted, and spread it over the months left
    compute_india_tds: (gross: number, _ded?: number) => {
      const t = table(ctx, 'IN_TDS_NEW')
      const ytd = ctx.indiaYtd ?? { gross: 0, tax: 0, monthsLeft: 12 }
      const { annualTax, taxable } = indiaAnnualTax(ytd.gross + Math.max(0, Number(gross)) * ytd.monthsLeft, t)
      if (taxable > t.surchargeFrom) warn(`Projected taxable income ${Math.round(taxable)} is above ${t.surchargeFrom}: surcharge is not computed, check TDS by hand`)
      return round2(Math.max(0, (annualTax - ytd.tax) / ytd.monthsLeft))
    },
  }
}

// Annual tax on a projected gross salary: standard deduction, slabs, rebate (with marginal relief just above the limit), cess
export function indiaAnnualTax(projectedGross: number, t: StatutoryParams) {
  const taxable = Math.max(0, projectedGross - t.standardDeduction)
  let tax = bandTax(taxable, t.slabs)
  if (taxable <= t.rebateIncomeLimit) tax = Math.max(0, tax - t.rebateMax)
  else tax = Math.min(tax, taxable - t.rebateIncomeLimit)
  return { taxable, annualTax: round2(tax * (1 + t.cess)) }
}

// Months from the pay period's month to the end of India's financial year (April-March), counting this one
export function indiaMonthsLeft(periodStart: string, fyStartMonth = 4) {
  const m = Number(periodStart.slice(5, 7))
  return ((fyStartMonth - 1 - m + 12) % 12) + 1
}
export function indiaFyStart(periodStart: string, fyStartMonth = 4) {
  const y = Number(periodStart.slice(0, 4)), m = Number(periodStart.slice(5, 7))
  return `${m >= fyStartMonth ? y : y - 1}-${String(fyStartMonth).padStart(2, '0')}-01`
}

import { prisma } from '../../infrastructure/database/prisma'

// Statutory tables (statutory_tables) resolved for a date, plus the pure calculators the payroll engine exposes
// to salary-rule formulas: compute_zra_paye, napsa_employee/employer, nhima_employee/employer, compute_india_tds.

export type Band = { upTo: number | null; rate: number }
export type StatutoryParams = Record<string, any>
export interface IndiaYtd { gross: number; tax: number; monthsLeft: number; exemption?: number } // monthsLeft includes the current month; exemption = verified declarations allowed under the regime
// versions: code -> "<code> <effectiveFrom>[ (company)]"; used: codes read while one rule runs (the engine fills it per line)
export interface StatutoryContext { at: string; tables: Record<string, StatutoryParams>; versions?: Record<string, string>; used?: Set<string>; indiaYtd?: IndiaYtd }

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

// ponytail: rows cached for 10 minutes per process (cleared when a company saves a version); per-instance cache, so with
// several API instances a new company version can take up to 10 minutes to reach the others
type Row = { code: string; effectiveFrom: Date; params: any; tenantId: string | null }
let cache: { at: number; rows: Row[] } | null = null
async function rows() {
  if (!cache || Date.now() - cache.at > 600_000) {
    const all = await prisma.statutoryTable.findMany({ select: { code: true, effectiveFrom: true, params: true, tenantId: true } })
    // Oldest first; on the same date a company's own version comes after (and so wins over) the shared one
    all.sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime() || (a.tenantId ? 1 : 0) - (b.tenantId ? 1 : 0))
    cache = { at: Date.now(), rows: all }
  }
  return cache.rows
}
export const clearStatutoryCache = () => { cache = null }

// The version of every table in force on `date` (YYYY-MM-DD) for a company: its own versions, else the shared ones
export async function statutoryContext(date: string, tenantId?: string): Promise<{ tables: Record<string, StatutoryParams>; versions: Record<string, string> }> {
  const tables: Record<string, StatutoryParams> = {}
  const versions: Record<string, string> = {}
  for (const r of await rows()) {
    const from = r.effectiveFrom.toISOString().slice(0, 10)
    if (from > date || (r.tenantId && r.tenantId !== tenantId)) continue
    tables[r.code] = r.params
    versions[r.code] = `${r.code} ${from}${r.tenantId ? ' (company)' : ''}`
  }
  return { tables, versions }
}
export async function statutoryFor(date: string, tenantId?: string): Promise<Record<string, StatutoryParams>> {
  return (await statutoryContext(date, tenantId)).tables
}

function table(ctx: StatutoryContext, code: string) {
  ctx.used?.add(code)
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
    // Kenya: NSSF (6% up to the upper earnings limit), SHIF (2.75%, a minimum), housing levy (1.5% each side);
    // PAYE on pay after those three, less the monthly personal relief
    ke_nssf_employee: (gross: number) => { const t = table(ctx, 'KE_NSSF'); return round2(Math.min(Math.max(0, Number(gross)), t.upperLimit) * t.rate) },
    ke_nssf_employer: (gross: number) => { const t = table(ctx, 'KE_NSSF'); return round2(Math.min(Math.max(0, Number(gross)), t.upperLimit) * t.rate) },
    ke_shif: (gross: number) => { const t = table(ctx, 'KE_SHIF'); return Number(gross) > 0 ? round2(Math.max(t.minimum, Number(gross) * t.rate)) : 0 },
    ke_ahl_employee: (gross: number) => round2(Math.max(0, Number(gross)) * table(ctx, 'KE_AHL').employeeRate),
    ke_ahl_employer: (gross: number) => round2(Math.max(0, Number(gross)) * table(ctx, 'KE_AHL').employerRate),
    compute_ke_paye: (taxable: number) => { const t = table(ctx, 'KE_PAYE'); return round2(Math.max(0, bandTax(Math.max(0, Number(taxable)), t.bands) - t.personalRelief)) },
    // Nigeria: pension 8% / 10% of basic + housing + transport; PAYE on annualised pay less pension, nothing at or
    // below the minimum wage
    ng_pension_employee: (base: number) => round2(Math.max(0, Number(base)) * table(ctx, 'NG_PENSION').employeeRate),
    ng_pension_employer: (base: number) => round2(Math.max(0, Number(base)) * table(ctx, 'NG_PENSION').employerRate),
    compute_ng_paye: (gross: number, pension: number) => {
      const t = table(ctx, 'NG_PAYE')
      if (Number(gross) <= t.minimumWageMonthly) return 0
      return round2(bandTax(Math.max(0, (Number(gross) - Number(pension ?? 0)) * 12), t.bands) / 12)
    },
    // Contractors: a flat withholding on the fee (rates marked to confirm in the statutory tables)
    zm_withholding: (fee: number) => round2(Math.max(0, Number(fee)) * table(ctx, 'ZM_WHT_CONTRACTOR').rate),
    // ponytail: monthly rate on each payment; the 194J annual threshold is not tracked across the year
    in_tds_194j: (fee: number) => round2(Math.max(0, Number(fee)) * table(ctx, 'IN_TDS_194J').rate),
    // India, new regime, cumulative method: project the year's income from what was paid so far plus this month
    // for the rest of the year, take the year's tax less tax already deducted, and spread it over the months left
    compute_india_tds: (gross: number, _ded?: number) => {
      const t = table(ctx, 'IN_TDS_NEW')
      const ytd = ctx.indiaYtd ?? { gross: 0, tax: 0, monthsLeft: 12 }
      const { annualTax, taxable } = indiaAnnualTax(Math.max(0, ytd.gross + Math.max(0, Number(gross)) * ytd.monthsLeft - (ytd.exemption ?? 0)), t)
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

// ─── Gratuity on exit ─────────────────────────────────────────
export interface GratuityInput { country: string | null; hireDate: string; lastWorkingDate: string; exitType: string; basicMonthly: number; basicEarnedInContract: number; contractFrom: string; contractUntil: string | null }
export interface GratuityResult { amount: number; formula?: string; warning?: string }
const months = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) - (Number(b.slice(8, 10)) < Number(a.slice(8, 10)) ? 1 : 0)

export function computeGratuity(g: GratuityInput, tables: Record<string, StatutoryParams>): GratuityResult {
  if (g.country === 'IN') {
    const t = tables.IN_GRATUITY
    if (!t) return { amount: 0, warning: 'No India gratuity table in force' }
    const m = months(g.hireDate, g.lastWorkingDate)
    const fullYears = Math.floor(m / 12)
    if (fullYears < t.minYears && !t.exemptExitTypes.includes(g.exitType)) return { amount: 0, warning: `No gratuity: ${fullYears} completed year(s), the Act needs ${t.minYears}` }
    const years = fullYears + (m % 12 >= t.roundUpMonths ? 1 : 0)
    const raw = round2(g.basicMonthly * t.daysPerYear * years / t.divisor)
    const amount = Math.min(raw, t.ceiling)
    return { amount, formula: `basic ${g.basicMonthly} × ${t.daysPerYear} ÷ ${t.divisor} × ${years} year(s)${raw > t.ceiling ? `, capped at ${t.ceiling}` : ''}` }
  }
  if (g.country === 'ZM') {
    const t = tables.ZM_GRATUITY
    if (!t) return { amount: 0, warning: 'No Zambia gratuity table in force' }
    if (!g.contractUntil) return { amount: 0, warning: 'Permanent contract: Zambian gratuity (s.73) is for long-term contracts; whether permanent contracts qualify is contested, add it as a manual line if your policy pays it' }
    if (months(g.contractFrom, g.contractUntil) + 1 < t.minContractMonths) return { amount: 0, warning: `No gratuity: contract shorter than ${t.minContractMonths} months` }
    return { amount: round2(g.basicEarnedInContract * t.rate), formula: `${t.rate * 100}% of basic earned since ${g.contractFrom} (${g.basicEarnedInContract})` }
  }
  return { amount: 0, warning: `No statutory gratuity rule for ${g.country ?? 'an employee without a tax country'}; add it as a manual line if due` }
}

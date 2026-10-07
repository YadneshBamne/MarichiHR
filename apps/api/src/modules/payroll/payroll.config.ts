export const PAYROLL_CONFIG = {
  HALF_DAY_LWP_FACTOR: 0.5,
  VARIANCE_THRESHOLD: 0.10,
  STANDARD_HOURS_PER_DAY: 8,
  DEFAULT_WORKING_DAYS: [0, 1, 2, 3, 4],
}

// ILLUSTRATIVE ONLY — verify against the current ZRA PAYE schedule before real use.
// Phase 3 replaces this with the versioned tax_rules / tax_slabs tables.
export const ZRA_PAYE_BANDS = [
  { upTo: 5100, rate: 0 },
  { upTo: 7100, rate: 0.2 },
  { upTo: 9200, rate: 0.3 },
  { upTo: Infinity, rate: 0.37 },
]

export function computeZraPaye(taxable: number): number {
  if (!(taxable > 0)) return 0
  let tax = 0
  let lower = 0
  for (const band of ZRA_PAYE_BANDS) {
    if (taxable > lower) {
      const slice = Math.min(taxable, band.upTo) - lower
      tax += slice * band.rate
    }
    lower = band.upTo
    if (taxable <= band.upTo) break
  }
  return Math.round(tax * 100) / 100
}

// PLACEHOLDER — India TDS (cumulative method) is built in Phase 3. Returns 0 for now.
export function computeIndiaTdsPlaceholder(): number {
  return 0
}

// REPLACE WITH YOUR CHART OF ACCOUNTS
export const GL_ACCOUNTS = {
  SALARY_EXPENSE: { code: '5000', name: 'Salaries & Wages Expense' },
  EMPLOYER_CONTRIB_EXPENSE: { code: '5010', name: 'Employer Statutory Contributions Expense' },
  NET_PAYABLE: { code: '2100', name: 'Net Salaries Payable' },
  TAX_PAYABLE: { code: '2110', name: 'PAYE Payable' },
  DEDUCTIONS_PAYABLE: { code: '2120', name: 'Employee Deductions Payable' },
  EMPLOYER_CONTRIB_PAYABLE: { code: '2130', name: 'Employer Contributions Payable' },
  // REPLACE WITH YOUR CHART OF ACCOUNTS
  REIMBURSEMENT_EXPENSE: { code: '5020', name: 'Employee Reimbursements Expense' },
}

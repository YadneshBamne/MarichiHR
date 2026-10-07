import { GL_ACCOUNTS } from './payroll.config'

// ─── CSV ──────────────────────────────────────────────────────

// Quotes values containing , " or newlines; neutralises spreadsheet formulas; numbers get 2 decimals
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return value.toFixed(2)
  let s = String(value)
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',')

const cents = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100)
const fromCents = (c: number) => c / 100

// ─── BANK FILE ────────────────────────────────────────────────

export interface BankFileRow {
  employeeCode: string
  name: string
  bankName: string
  accountNumber: string
  branchSwift: string
  amount: number
  currency: string
  reference: string
}

export function formatBankFile(rows: BankFileRow[], format: 'generic_csv' = 'generic_csv'): string {
  if (format !== 'generic_csv') throw new Error(`Unsupported bank file format: ${format}`)
  const header = ['Employee Code', 'Beneficiary Name', 'Bank Name', 'Account Number', 'Branch/SWIFT', 'Amount', 'Currency', 'Payment Reference']
  const total = fromCents(rows.reduce((s, r) => s + cents(r.amount), 0))
  const currency = rows[0]?.currency ?? ''
  const lines = [
    csvRow(header),
    ...rows.map((r) => csvRow([r.employeeCode, r.name, r.bankName, r.accountNumber, r.branchSwift, r.amount, r.currency, r.reference])),
    csvRow(['TOTAL', '', '', '', '', total, currency, '']),
  ]
  return lines.join('\r\n') + '\r\n'
}

// ─── GL JOURNAL ───────────────────────────────────────────────

export interface GlPayslip {
  grossEarnings: number
  netPay: number
  lines: { category: string; code: string; name: string; amount: number }[]
}

export interface GlLine {
  accountCode: string
  accountName: string
  description: string
  debit: number
  credit: number
}

export function buildGlLines(payslips: GlPayslip[], periodLabel: string) {
  let gross = 0, net = 0, tax = 0, employer = 0, reimbursements = 0
  const deductions = new Map<string, { name: string; cents: number }>()

  for (const p of payslips) {
    gross += cents(p.grossEarnings)
    net += cents(p.netPay)
    for (const l of p.lines) {
      if (l.category === 'TAX') tax += cents(l.amount)
      else if (l.category === 'EMP_CONTRIB') employer += cents(l.amount)
      else if (l.category === 'REIMB') reimbursements += cents(l.amount)
      else if (l.category === 'DED') {
        const cur = deductions.get(l.code) ?? { name: l.name, cents: 0 }
        cur.cents += cents(l.amount)
        deductions.set(l.code, cur)
      }
    }
  }

  const lines: GlLine[] = [
    { accountCode: GL_ACCOUNTS.SALARY_EXPENSE.code, accountName: GL_ACCOUNTS.SALARY_EXPENSE.name, description: `Gross salaries ${periodLabel}`, debit: fromCents(gross), credit: 0 },
    { accountCode: GL_ACCOUNTS.EMPLOYER_CONTRIB_EXPENSE.code, accountName: GL_ACCOUNTS.EMPLOYER_CONTRIB_EXPENSE.name, description: `Employer contributions ${periodLabel}`, debit: fromCents(employer), credit: 0 },
    { accountCode: GL_ACCOUNTS.REIMBURSEMENT_EXPENSE.code, accountName: GL_ACCOUNTS.REIMBURSEMENT_EXPENSE.name, description: `Employee reimbursements ${periodLabel}`, debit: fromCents(reimbursements), credit: 0 },
    { accountCode: GL_ACCOUNTS.NET_PAYABLE.code, accountName: GL_ACCOUNTS.NET_PAYABLE.name, description: `Net salaries payable ${periodLabel}`, debit: 0, credit: fromCents(net) },
    { accountCode: GL_ACCOUNTS.TAX_PAYABLE.code, accountName: GL_ACCOUNTS.TAX_PAYABLE.name, description: `PAYE withheld ${periodLabel}`, debit: 0, credit: fromCents(tax) },
    ...Array.from(deductions.entries()).map(([code, d]) => ({
      accountCode: GL_ACCOUNTS.DEDUCTIONS_PAYABLE.code,
      accountName: GL_ACCOUNTS.DEDUCTIONS_PAYABLE.name,
      description: `${code} ${d.name} ${periodLabel}`,
      debit: 0,
      credit: fromCents(d.cents),
    })),
    { accountCode: GL_ACCOUNTS.EMPLOYER_CONTRIB_PAYABLE.code, accountName: GL_ACCOUNTS.EMPLOYER_CONTRIB_PAYABLE.name, description: `Employer contributions payable ${periodLabel}`, debit: 0, credit: fromCents(employer) },
  ]

  const totalDebit = fromCents(lines.reduce((s, l) => s + cents(l.debit), 0))
  const totalCredit = fromCents(lines.reduce((s, l) => s + cents(l.credit), 0))
  return { lines, totalDebit, totalCredit, difference: fromCents(cents(totalDebit) - cents(totalCredit)) }
}

export function formatGlCsv(lines: GlLine[], date: string, journalRef: string): string {
  const header = ['Date', 'Journal Ref', 'Account Code', 'Account Name', 'Description', 'Debit', 'Credit']
  return [
    csvRow(header),
    ...lines.map((l) => csvRow([date, journalRef, l.accountCode, l.accountName, l.description, l.debit, l.credit])),
  ].join('\r\n') + '\r\n'
}

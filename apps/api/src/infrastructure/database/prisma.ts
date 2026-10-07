import { Prisma, PrismaClient } from '@prisma/client'

// Money columns are NUMERIC in Postgres (exact storage and exact SQL sums). The app reads them back as JS numbers and
// rounds every computed amount to cents (round2), so payroll arithmetic is unchanged.
// ponytail: number arithmetic after the read; switch the engine to Decimal math if amounts ever exceed ~2^53 cents.
type Dec = Prisma.Decimal
const num = <K extends string>(key: K) => ({
  needs: { [key]: true } as { [P in K]: true },
  compute: (row: { [P in K]: Dec }) => Number(row[key]),
})
const optNum = <K extends string>(key: K) => ({
  needs: { [key]: true } as { [P in K]: true },
  compute: (row: { [P in K]: Dec | null }) => (row[key] == null ? null : Number(row[key])),
})

function createClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  }).$extends({
    result: {
      employeeContract: { ctcAnnual: num('ctcAnnual'), wageMonthly: num('wageMonthly') },
      salaryRule: { amountFixed: optNum('amountFixed') },
      gradeBand: { salaryMin: num('salaryMin'), salaryMid: num('salaryMid'), salaryMax: num('salaryMax') },
      payslip: { grossEarnings: num('grossEarnings'), totalDeductions: num('totalDeductions'), netPay: num('netPay') },
      payslipLine: { amount: num('amount') },
      payrollInput: { amount: num('amount') },
      expenseCategory: { maxAmount: optNum('maxAmount'), receiptRequiredAbove: optNum('receiptRequiredAbove') },
      perDiemRate: { ratePerDay: num('ratePerDay') },
      fxRate: { rate: num('rate') },
      reimbursementClaim: { expenseAmount: num('expenseAmount'), fxRate: num('fxRate'), homeAmount: num('homeAmount') },
      employeeExit: { totalEarnings: optNum('totalEarnings'), totalDeductions: optNum('totalDeductions'), netPayable: optNum('netPayable') },
    },
  })
}

const globalForPrisma = globalThis as unknown as { prisma: ReturnType<typeof createClient> | undefined }

export const prisma = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

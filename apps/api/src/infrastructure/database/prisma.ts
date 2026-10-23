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

const READS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy'])

function createClient() {
  return new PrismaClient({
    log: process.env.PRISMA_LOG_QUERIES === 'true' ? ['query', 'error', 'warn'] : ['error', 'warn'],
  }).$extends({
    // Neon drops a connection now and then (P1001/P1017, pool timeout P2024): retry a read once instead of showing an error.
    // Writes are never retried, so nothing is applied twice.
    query: {
      $allModels: {
        async $allOperations({ operation, args, query }) {
          try {
            return await query(args)
          } catch (e: any) {
            if (!READS.has(operation) || !['P1001', 'P1017', 'P2024'].includes(e?.code ?? e?.errorCode)) throw e
            await new Promise((r) => setTimeout(r, 400))
            return query(args)
          }
        },
      },
    },
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
      expenseRequest: { amount: num('amount') },
      employeeExit: { totalEarnings: optNum('totalEarnings'), totalDeductions: optNum('totalDeductions'), netPayable: optNum('netPayable') },
    },
  })
}

const globalForPrisma = globalThis as unknown as { prisma: ReturnType<typeof createClient> | undefined }

export const prisma = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

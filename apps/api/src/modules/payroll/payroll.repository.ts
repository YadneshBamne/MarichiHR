import { prisma } from '../../infrastructure/database/prisma'

export const payrollRepository = {
  // ─── CYCLES ───────────────────────────────────────────────
  createCycle(tenantId: string, data: { payPeriodStart: Date; payPeriodEnd: Date; cycleType: string }) {
    return prisma.payrollCycle.create({ data: { tenantId, ...data, status: 'draft' } })
  },

  findOverlappingCycle(tenantId: string, start: Date, end: Date) {
    return prisma.payrollCycle.findFirst({
      where: { tenantId, payPeriodStart: { lte: end }, payPeriodEnd: { gte: start } },
    })
  },

  listCycles(tenantId: string) {
    return prisma.payrollCycle.findMany({
      where: { tenantId },
      include: { _count: { select: { payslips: true } } },
      orderBy: { payPeriodStart: 'desc' },
    })
  },

  findCycleById(id: string) {
    return prisma.payrollCycle.findUnique({
      where: { id },
      include: { _count: { select: { payslips: true } } },
    })
  },

  updateCycle(id: string, data: any) {
    return prisma.payrollCycle.update({ where: { id }, data })
  },

  findPreviousCycle(tenantId: string, before: Date) {
    return prisma.payrollCycle.findFirst({
      where: { tenantId, payPeriodEnd: { lt: before } },
      orderBy: { payPeriodEnd: 'desc' },
    })
  },

  aggregateTotals(cycleId: string) {
    return prisma.payslip.aggregate({
      where: { payrollCycleId: cycleId },
      _sum: { grossEarnings: true, totalDeductions: true, netPay: true },
      _count: true,
    })
  },

  // ─── DATA GATHERING ───────────────────────────────────────
  listPayrollEmployees(tenantId: string) {
    return prisma.employee.findMany({
      where: { tenantId, active: true, employmentStatus: { not: 'terminated' } },
      include: {
        user: { select: { fullName: true } },
        resourceCalendar: { include: { days: true } },
      },
      orderBy: { employeeCode: 'asc' },
    })
  },

  findContractForPeriod(employeeId: string, start: Date, end: Date) {
    return prisma.employeeContract.findFirst({
      where: {
        employeeId,
        active: true,
        status: { in: ['running', 'expired'] },
        effectiveFrom: { lte: end },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: start } }],
      },
      include: {
        salaryStructure: {
          include: {
            rules: {
              where: { active: true },
              include: { category: true },
              orderBy: { sequence: 'asc' },
            },
          },
        },
      },
      orderBy: { effectiveFrom: 'desc' },
    })
  },

  listAttendance(employeeId: string, start: Date, end: Date) {
    return prisma.attendanceRecord.findMany({
      where: { employeeId, date: { gte: start, lte: end } },
    })
  },

  listApprovedLeave(employeeId: string, start: Date, end: Date) {
    return prisma.leaveRequest.findMany({
      where: { employeeId, status: 'approved', startDate: { lte: end }, endDate: { gte: start } },
      include: { leaveType: { select: { isPaid: true, name: true } } },
    })
  },

  listApprovedOvertime(employeeId: string, start: Date, end: Date) {
    return prisma.overtimeRequest.findMany({
      where: { employeeId, status: 'approved', date: { gte: start, lte: end } },
    })
  },

  listInputTypes(tenantId: string) {
    return prisma.payrollInputType.findMany({ where: { tenantId, active: true } })
  },

  // ─── INPUTS ───────────────────────────────────────────────
  createInput(data: { payrollCycleId: string; employeeId: string; inputTypeId: string; amount: number; description?: string; addedBy: string }) {
    return prisma.payrollInput.create({ data, include: { inputType: true } })
  },

  listCycleInputs(cycleId: string) {
    return prisma.payrollInput.findMany({
      where: { payrollCycleId: cycleId },
      include: { inputType: true },
      orderBy: { createdAt: 'asc' },
    })
  },

  findInputById(id: string) {
    return prisma.payrollInput.findUnique({ where: { id }, include: { inputType: true } })
  },

  approveInput(id: string, approvedBy: string) {
    return prisma.payrollInput.update({
      where: { id },
      data: { approvedBy, approvedAt: new Date() },
      include: { inputType: true },
    })
  },

  // ─── PAYSLIPS ─────────────────────────────────────────────
  async deletePayslipsForCycle(cycleId: string) {
    return prisma.$transaction([
      prisma.payslipLine.deleteMany({ where: { payslip: { payrollCycleId: cycleId } } }),
      prisma.payslipWorkedDay.deleteMany({ where: { payslip: { payrollCycleId: cycleId } } }),
      prisma.payslip.deleteMany({ where: { payrollCycleId: cycleId } }),
    ])
  },

  createPayslip(data: any) {
    return prisma.payslip.create({ data })
  },

  countPayslips(cycleId: string) {
    return prisma.payslip.count({ where: { payrollCycleId: cycleId } })
  },

  setPayslipStatus(cycleId: string, status: string, disbursedAt?: Date) {
    return prisma.payslip.updateMany({
      where: { payrollCycleId: cycleId },
      data: { status, ...(disbursedAt && { disbursedAt }) },
    })
  },

  listCyclePayslips(cycleId: string) {
    return prisma.payslip.findMany({
      where: { payrollCycleId: cycleId },
      include: {
        employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
        lines: { select: { sourceRefType: true } },
      },
      orderBy: { employee: { employeeCode: 'asc' } },
    })
  },

  listPayslipsForExport(cycleId: string) {
    return prisma.payslip.findMany({
      where: { payrollCycleId: cycleId },
      include: {
        employee: {
          select: {
            employeeCode: true, firstName: true, lastName: true,
            bankName: true, bankAccountNo: true, bankIfscSwift: true, bankVerified: true,
          },
        },
        lines: { select: { category: true, code: true, name: true, amount: true } },
      },
      orderBy: { employee: { employeeCode: 'asc' } },
    })
  },

  findPayslipById(id: string) {
    return prisma.payslip.findUnique({
      where: { id },
      include: {
        lines: { orderBy: [{ sequence: 'asc' }, { code: 'asc' }] },
        workedDays: true,
        payrollCycle: true,
        employee: {
          select: { id: true, employeeCode: true, firstName: true, lastName: true, bankName: true, tenantId: true },
        },
      },
    })
  },

  listReleasedPayslips(employeeId: string) {
    return prisma.payslip.findMany({
      where: { employeeId, payrollCycle: { status: { in: ['disbursed', 'locked'] } } },
      include: { payrollCycle: { select: { payPeriodStart: true, payPeriodEnd: true, status: true } } },
      orderBy: { payrollCycle: { payPeriodEnd: 'desc' } },
    })
  },

  // ─── AUDIT ────────────────────────────────────────────────
  createAudit(data: { tenantId: string; userId?: string; action: string; entityType: string; entityId: string; oldValue?: any; newValue?: any }) {
    return prisma.auditLog.create({ data })
  },
}

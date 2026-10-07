import { prisma } from '../../infrastructure/database/prisma'
import { CreateContractDto } from './contracts.types'

export const contractRepository = {
  async create(data: CreateContractDto, tenantId: string, createdBy: string) {
    return prisma.employeeContract.create({
      data: {
        employeeId: data.employeeId,
        ctcAnnual: data.ctcAnnual,
        wageMonthly: data.wageMonthly,
        currency: data.currency,
        variablePayPercent: data.variablePayPercent ?? 0,
        effectiveFrom: new Date(data.effectiveFrom),
        effectiveUntil: data.effectiveUntil ? new Date(data.effectiveUntil) : undefined,
        salaryStructureId: data.salaryStructureId,
        gradeBandId: data.gradeBandId,
        revisionReason: data.revisionReason,
        status: 'new',
      },
      include: { employee: { select: { firstName: true, lastName: true, employeeCode: true } } },
    })
  },

  async findById(id: string) {
    return prisma.employeeContract.findUnique({
      where: { id },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true, tenantId: true } },
        stateTransitions: { orderBy: { createdAt: 'desc' } },
      },
    })
  },

  async findByEmployee(employeeId: string) {
    return prisma.employeeContract.findMany({
      where: { employeeId, active: true },
      include: { stateTransitions: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { effectiveFrom: 'desc' },
    })
  },

  async findRunningContract(employeeId: string, date: Date) {
    return prisma.employeeContract.findFirst({
      where: {
        employeeId,
        status: 'running',
        active: true,
        effectiveFrom: { lte: date },
        OR: [
          { effectiveUntil: null },
          { effectiveUntil: { gte: date } },
        ],
      },
    })
  },

  async transition(id: string, toStatus: string, transitionedBy: string, reason?: string) {
    const contract = await prisma.employeeContract.findUnique({ where: { id } })
    if (!contract) throw new Error('Contract not found')

    const [updated] = await prisma.$transaction([
      prisma.employeeContract.update({
        where: { id },
        data: {
          status: toStatus,
          stateChangedAt: new Date(),
          stateChangedBy: transitionedBy,
        },
      }),
      prisma.contractStateTransition.create({
        data: {
          contractId: id,
          fromState: contract.status,
          toState: toStatus,
          transitionedBy,
          reason: reason ?? null,
        },
      }),
    ])

    return updated
  },

  async findConfirmedReadyToActivate() {
    return prisma.employeeContract.findMany({
      where: {
        status: 'confirmed',
        active: true,
        effectiveFrom: { lte: new Date() },
      },
      include: { employee: { select: { id: true, tenantId: true, firstName: true, lastName: true } } },
    })
  },

  async findRunningReadyToExpire() {
    return prisma.employeeContract.findMany({
      where: {
        status: 'running',
        active: true,
        effectiveUntil: { lte: new Date() },
      },
      include: { employee: { select: { id: true, tenantId: true, firstName: true, lastName: true } } },
    })
  },

  async findExpiringSoon(daysAhead: number) {
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + daysAhead)

    return prisma.employeeContract.findMany({
      where: {
        status: 'running',
        active: true,
        expiryAlertSent: false,
        effectiveUntil: {
          not: null,
          lte: futureDate,
          gte: new Date(),
        },
      },
      include: { employee: { select: { id: true, tenantId: true, firstName: true, lastName: true, workEmail: true } } },
    })
  },

  async markExpiryAlertSent(id: string) {
    return prisma.employeeContract.update({
      where: { id },
      data: { expiryAlertSent: true },
    })
  },
}

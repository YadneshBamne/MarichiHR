import { dateOnly } from '../../shared/utils/businessDate'
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
        noticePeriodDays: data.noticePeriodDays ?? 30,
        effectiveFrom: dateOnly(data.effectiveFrom),
        effectiveUntil: data.effectiveUntil ? dateOnly(data.effectiveUntil) : undefined,
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

  async findConfirmedReadyToActivate(tenantId?: string) {
    return prisma.employeeContract.findMany({
      where: {
        status: 'confirmed',
        active: true,
        ...(tenantId && { employee: { tenantId } }),
        effectiveFrom: { lte: new Date() },
      },
      include: { employee: { select: { id: true, tenantId: true, firstName: true, lastName: true } } },
    })
  },

  async findRunningReadyToExpire(tenantId?: string) {
    return prisma.employeeContract.findMany({
      where: {
        status: 'running',
        active: true,
        ...(tenantId && { employee: { tenantId } }),
        // effectiveUntil is the last day covered (UTC-midnight date): expire from the following day
        effectiveUntil: { lt: new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z') },
      },
      include: { employee: { select: { id: true, tenantId: true, firstName: true, lastName: true } } },
    })
  },

  async findExpiringSoon(daysAhead: number, tenantId?: string) {
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + daysAhead)

    return prisma.employeeContract.findMany({
      where: {
        status: 'running',
        active: true,
        ...(tenantId && { employee: { tenantId } }),
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

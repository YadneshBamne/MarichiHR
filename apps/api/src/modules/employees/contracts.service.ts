import { contractRepository } from './contracts.repository'
import { CreateContractDto, CONTRACT_TRANSITIONS, ContractStatus } from './contracts.types'
import { AppError } from '../../shared/utils/AppError'
import { eventBus } from '../../infrastructure/events/eventBus'
import { prisma } from '../../infrastructure/database/prisma'
import { AccessUser, assertCompensationAccess } from '../../shared/utils/access'

export const contractService = {
  async create(data: CreateContractDto, tenantId: string, createdBy: string) {
    const employee = await prisma.employee.findFirst({ where: { id: data.employeeId, tenantId }, select: { id: true } })
    if (!employee) throw new AppError('Employee not found', 404)
    if (data.salaryStructureId) {
      const structure = await prisma.salaryStructure.findFirst({ where: { id: data.salaryStructureId, tenantId }, select: { id: true } })
      if (!structure) throw new AppError('Salary structure not found', 404)
    }
    if (data.gradeBandId) {
      const band = await prisma.gradeBand.findFirst({ where: { id: data.gradeBandId, tenantId }, select: { id: true } })
      if (!band) throw new AppError('Grade band not found', 404)
    }
    return contractRepository.create(data, tenantId, createdBy)
  },

  async getById(id: string, user: AccessUser) {
    const contract = await contractRepository.findById(id)
    if (!contract || contract.employee.tenantId !== user.tenantId) throw new AppError('Contract not found', 404)
    await assertCompensationAccess(user, contract.employee.id)
    return contract
  },

  async getByEmployee(employeeId: string, user: AccessUser) {
    await assertCompensationAccess(user, employeeId)
    return contractRepository.findByEmployee(employeeId)
  },

  async transition(id: string, toStatus: ContractStatus, tenantId: string, userId: string, reason?: string) {
    const contract = await contractRepository.findById(id)
    if (!contract) throw new AppError('Contract not found', 404)
    if (contract.employee.tenantId !== tenantId) throw new AppError('Contract not found', 404)

    const currentStatus = contract.status as ContractStatus
    const allowedTransitions = CONTRACT_TRANSITIONS[currentStatus]

    if (!allowedTransitions.includes(toStatus)) {
      throw new AppError(
        `Cannot transition contract from '${currentStatus}' to '${toStatus}'. Allowed: ${allowedTransitions.join(', ') || 'none'}`,
        400
      )
    }

    const updated = await contractRepository.transition(id, toStatus, userId, reason)

    await eventBus.publish(tenantId, `contract.${toStatus}`, {
      contractId: id,
      employeeId: contract.employee.id,
      fromStatus: currentStatus,
      toStatus,
      transitionedBy: userId,
    })

    return updated
  },

  async runAutoActivateCron() {
    const contracts = await contractRepository.findConfirmedReadyToActivate()
    let activated = 0

    for (const contract of contracts) {
      try {
        await contractRepository.transition(contract.id, 'running', 'system', 'Auto-activated by cron on effective date')
        await eventBus.publish(contract.employee.tenantId, 'contract.activated', {
          contractId: contract.id,
          employeeId: contract.employee.id,
          name: `${contract.employee.firstName} ${contract.employee.lastName}`,
        })
        activated++
      } catch (err) {
        console.error(`Failed to auto-activate contract ${contract.id}:`, err)
      }
    }

    console.log(`Contract auto-activate cron: ${activated} contracts activated`)
    return activated
  },

  async runAutoExpireCron() {
    const contracts = await contractRepository.findRunningReadyToExpire()
    let expired = 0

    for (const contract of contracts) {
      try {
        await contractRepository.transition(contract.id, 'expired', 'system', 'Auto-expired by cron on effective-until date')
        await eventBus.publish(contract.employee.tenantId, 'contract.expired', {
          contractId: contract.id,
          employeeId: contract.employee.id,
          name: `${contract.employee.firstName} ${contract.employee.lastName}`,
        })
        expired++
      } catch (err) {
        console.error(`Failed to auto-expire contract ${contract.id}:`, err)
      }
    }

    console.log(`Contract auto-expire cron: ${expired} contracts expired`)
    return expired
  },

  async runExpiryAlertCron() {
    const contracts = await contractRepository.findExpiringSoon(30)
    let alerted = 0

    for (const contract of contracts) {
      try {
        await eventBus.publish(contract.employee.tenantId, 'contract.expiring.soon', {
          contractId: contract.id,
          employeeId: contract.employee.id,
          name: `${contract.employee.firstName} ${contract.employee.lastName}`,
          email: contract.employee.workEmail,
          effectiveUntil: contract.effectiveUntil,
          daysRemaining: Math.ceil(
            (new Date(contract.effectiveUntil!).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
          ),
        })
        await contractRepository.markExpiryAlertSent(contract.id)
        alerted++
      } catch (err) {
        console.error(`Failed to send expiry alert for contract ${contract.id}:`, err)
      }
    }

    console.log(`Contract expiry alert cron: ${alerted} alerts sent`)
    return alerted
  },
}

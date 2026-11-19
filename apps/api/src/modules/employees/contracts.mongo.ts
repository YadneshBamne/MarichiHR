import crypto from 'crypto'
import { CreateContractDto, CONTRACT_TRANSITIONS, ContractStatus } from './contracts.types'
import { AppError } from '../../shared/utils/AppError'
import { dateOnly } from '../../shared/utils/businessDate'
import { AccessUser } from '../../shared/utils/access'
import { assertCompensationAccess } from '../../shared/utils/access.mongo'
import { statutoryFor } from '../tax/statutory'
import { enableMongoStatutory } from '../tax/statutory.mongo'
import { Tenant, Employee, EmployeeContract, SalaryStructure, GradeBand, AuditLog, DomainEvent } from '../../infrastructure/mongo/mongo'

// MongoDB version of contracts.service.ts / contracts.repository.ts. A contract carries tenantId itself (no join to the
// employee to scope it) and its state transitions are embedded. Same rules, same response shapes.
// ponytail: events are recorded in domain_events only (not published to the queue) until the events stage is ported.

enableMongoStatutory()

const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }
const byNewest = (t: any[]) => [...(t || [])].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).map(ser)
const brief = (e: any) => e && { firstName: e.firstName, lastName: e.lastName, employeeCode: e.employeeCode }
const event = (tenantId: string, type: string, payload: object) => ({ _id: crypto.randomUUID(), tenantId, type, payload, status: 'pending', createdAt: new Date() })

// A contract below the country's minimum wage is refused (the figure is in the statutory tables, marked to confirm)
export async function assertMinimumWage(tenantId: string, employeeId: string, wageMonthly: number, employmentType?: string | null) {
  if (employmentType === 'contractor' || employmentType === 'intern') return
  const [emp, tenant]: any[] = await Promise.all([Employee.findById(employeeId).select('taxJurisdiction').lean(), Tenant.findById(tenantId).select('primaryCountry').lean()])
  const country = emp?.taxJurisdiction ?? tenant?.primaryCountry
  if (!country) return
  const t = (await statutoryFor(new Date().toISOString().slice(0, 10), tenantId))[`${country}_MIN_WAGE`]
  if (t?.monthly && wageMonthly < t.monthly) throw new AppError(`The monthly wage is below ${country}'s minimum wage of ${Number(t.monthly).toLocaleString()} (see Tax & compliance › Rates)`, 400)
}

async function withEmployee(c: any, extra = false) {
  const e: any = await Employee.findById(c.employeeId).select('firstName lastName employeeCode tenantId workEmail').lean()
  return { ...ser(c), employee: e && (extra ? { id: e._id, ...brief(e), tenantId: e.tenantId } : brief(e)) }
}

export const contractRepository = {
  async findById(id: string) {
    const c: any = await EmployeeContract.findById(id).lean()
    if (!c) return null
    const row: any = await withEmployee(c, true)
    return { ...row, stateTransitions: byNewest(c.stateTransitions) }
  },
  async findByEmployee(employeeId: string) {
    const rows: any[] = await EmployeeContract.find({ employeeId, active: true }).sort({ effectiveFrom: -1 }).lean()
    return rows.map((c) => ({ ...ser(c), stateTransitions: byNewest(c.stateTransitions).slice(0, 1) }))
  },
  async findRunningContract(employeeId: string, date: Date) {
    return ser(await EmployeeContract.findOne({ employeeId, status: 'running', active: true, effectiveFrom: { $lte: date }, $or: [{ effectiveUntil: null }, { effectiveUntil: { $exists: false } }, { effectiveUntil: { $gte: date } }] }).lean())
  },
  // The status check in the filter makes a transition atomic: two people moving the same contract cannot both win
  async transition(id: string, from: string, toStatus: string, transitionedBy: string, reason?: string) {
    const updated: any = await EmployeeContract.findOneAndUpdate({ _id: id, status: from },
      { $set: { status: toStatus, stateChangedAt: new Date(), stateChangedBy: transitionedBy }, $push: { stateTransitions: { _id: crypto.randomUUID(), fromState: from, toState: toStatus, transitionedBy, reason: reason ?? null, createdAt: new Date() } } },
      { returnDocument: 'after' }).lean()
    if (!updated) throw new AppError('The contract changed while you were editing it. Reload and try again.', 409)
    return ser(updated)
  },
}

export const contractService = {
  async create(data: CreateContractDto, tenantId: string, createdBy: string) {
    const employee: any = await Employee.findOne({ _id: data.employeeId, tenantId }).select('employmentType').lean()
    if (!employee) throw new AppError('Employee not found', 404)
    await assertMinimumWage(tenantId, employee._id, Number(data.wageMonthly), employee.employmentType)
    if (data.salaryStructureId && !(await SalaryStructure.exists({ _id: data.salaryStructureId, tenantId }))) throw new AppError('Salary structure not found', 404)
    if (data.gradeBandId && !(await GradeBand.exists({ _id: data.gradeBandId, tenantId }))) throw new AppError('Grade band not found', 404)
    const created: any = (await EmployeeContract.create({
      tenantId, employeeId: data.employeeId, ctcAnnual: data.ctcAnnual, wageMonthly: data.wageMonthly, currency: data.currency, variablePayPercent: data.variablePayPercent ?? 0,
      noticePeriodDays: data.noticePeriodDays ?? 30, effectiveFrom: dateOnly(data.effectiveFrom), effectiveUntil: data.effectiveUntil ? dateOnly(data.effectiveUntil) : undefined,
      salaryStructureId: data.salaryStructureId, gradeBandId: data.gradeBandId, revisionReason: data.revisionReason, status: 'new',
    })).toObject()
    return withEmployee(created)
  },

  async getById(id: string, user: AccessUser) {
    const contract: any = await contractRepository.findById(id)
    if (!contract || contract.tenantId !== user.tenantId) throw new AppError('Contract not found', 404)
    await assertCompensationAccess(user, contract.employee.id)
    return contract
  },

  async getByEmployee(employeeId: string, user: AccessUser) {
    await assertCompensationAccess(user, employeeId)
    return contractRepository.findByEmployee(employeeId)
  },

  async transition(id: string, toStatus: ContractStatus, tenantId: string, userId: string, reason?: string) {
    const contract: any = await contractRepository.findById(id)
    if (!contract || contract.tenantId !== tenantId) throw new AppError('Contract not found', 404)
    const currentStatus = contract.status as ContractStatus
    const allowed = CONTRACT_TRANSITIONS[currentStatus]
    if (!allowed.includes(toStatus)) throw new AppError(`Cannot transition contract from '${currentStatus}' to '${toStatus}'. Allowed: ${allowed.join(', ') || 'none'}`, 400)
    const updated = await contractRepository.transition(id, currentStatus, toStatus, userId, reason)
    await AuditLog.create({ tenantId, userId, action: `CONTRACT_${toStatus.toUpperCase()}`, entityType: 'contract', entityId: id, oldValue: { status: currentStatus }, newValue: { status: toStatus } })
    await DomainEvent.create(event(tenantId, `contract.${toStatus}`, { contractId: id, employeeId: contract.employee.id, fromStatus: currentStatus, toStatus, transitionedBy: userId }))
    return updated
  },

  // ─── Daily jobs (per company when tenantId is given) ───
  async runAutoActivateCron(tenantId?: string) {
    const due: any[] = await EmployeeContract.find({ status: 'confirmed', active: true, ...(tenantId && { tenantId }), effectiveFrom: { $lte: new Date() } }).lean()
    let activated = 0
    for (const c of due) {
      try {
        await contractRepository.transition(c._id, 'confirmed', 'running', 'system', 'Auto-activated by cron on effective date')
        await DomainEvent.create(event(c.tenantId, 'contract.activated', { contractId: c._id, employeeId: c.employeeId }))
        activated++
      } catch (err) { console.error(`Failed to auto-activate contract ${c._id}:`, err) }
    }
    return activated
  },

  async runAutoExpireCron(tenantId?: string) {
    // effectiveUntil is the last day covered (UTC-midnight date): expire from the following day
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z')
    const due: any[] = await EmployeeContract.find({ status: 'running', active: true, ...(tenantId && { tenantId }), effectiveUntil: { $lt: today } }).lean()
    let expired = 0
    for (const c of due) {
      try {
        await contractRepository.transition(c._id, 'running', 'expired', 'system', 'Auto-expired by cron on effective-until date')
        await DomainEvent.create(event(c.tenantId, 'contract.expired', { contractId: c._id, employeeId: c.employeeId }))
        expired++
      } catch (err) { console.error(`Failed to auto-expire contract ${c._id}:`, err) }
    }
    return expired
  },

  async runExpiryAlertCron(tenantId?: string) {
    const soon = new Date(Date.now() + 30 * 86_400_000)
    const due: any[] = await EmployeeContract.find({ status: 'running', active: true, ...(tenantId && { tenantId }), expiryAlertSent: false, effectiveUntil: { $ne: null, $lte: soon, $gte: new Date() } }).lean()
    let alerted = 0
    for (const c of due) {
      try {
        await DomainEvent.create(event(c.tenantId, 'contract.expiring.soon', { contractId: c._id, employeeId: c.employeeId, effectiveUntil: c.effectiveUntil, daysRemaining: Math.ceil((+new Date(c.effectiveUntil) - Date.now()) / 86_400_000) }))
        await EmployeeContract.updateOne({ _id: c._id }, { expiryAlertSent: true })
        alerted++
      } catch (err) { console.error(`Failed to send expiry alert for contract ${c._id}:`, err) }
    }
    return alerted
  },
}

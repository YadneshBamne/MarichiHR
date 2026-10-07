export interface CreateContractDto {
  employeeId: string
  ctcAnnual: number
  wageMonthly: number
  currency: string
  variablePayPercent?: number
  noticePeriodDays?: number
  effectiveFrom: string
  effectiveUntil?: string
  salaryStructureId?: string
  gradeBandId?: string
  revisionReason?: string
}

export type ContractStatus = 'new' | 'draft' | 'confirmed' | 'running' | 'expired' | 'cancelled'

export const CONTRACT_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  new:       ['draft', 'cancelled'],
  draft:     ['confirmed', 'cancelled'],
  confirmed: ['running', 'cancelled'],
  running:   ['expired', 'cancelled'],
  expired:   [],
  cancelled: [],
}

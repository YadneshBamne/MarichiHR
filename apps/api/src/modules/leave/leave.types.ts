export interface ApplyLeaveDto {
  leaveTypeId: string
  startDate: string
  endDate: string
  startHalf?: 'first_half' | 'second_half'
  endHalf?: 'first_half' | 'second_half'
  reason?: string
  attachmentDocumentId?: string
}

export interface ApproveLeaveDto {
  comments?: string
  // Days asked beyond the balance: 'paid' (balance goes negative, HR is told) or 'unpaid' (those days become LWP)
  shortfall?: 'paid' | 'unpaid'
}

export interface RejectLeaveDto {
  comments: string
}

export interface LeaveAllocationRequestDto {
  leaveTypeId: string
  requestedDays: number
  reason: string
  supportingRefType?: string
  supportingRefId?: string
}

export interface ManualAllocationDto {
  employeeId: string
  leaveTypeId: string
  daysAllocated: number
  validFrom: string
  validUntil?: string
  reason: string
}

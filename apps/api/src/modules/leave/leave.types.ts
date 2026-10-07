export interface ApplyLeaveDto {
  leaveTypeId: string
  startDate: string
  endDate: string
  startHalf?: 'first_half' | 'second_half'
  endHalf?: 'first_half' | 'second_half'
  reason?: string
  attachmentUrl?: string
}

export interface ApproveLeaveDto {
  comments?: string
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

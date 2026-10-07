export interface CreateActivityDto {
  activityTypeId: string
  entityType: 'employee' | 'leave_request' | 'contract' | 'grievance' | 'attendance_regularisation'
  entityId: string
  title: string
  note?: string
  assignedToId: string
  dueDate: string
}

export interface CompleteActivityDto {
  doneNote: string
}

export interface CreateChatterMessageDto {
  entityType: string
  entityId: string
  body: string
  isInternal?: boolean
  messageType?: 'comment' | 'note'
}

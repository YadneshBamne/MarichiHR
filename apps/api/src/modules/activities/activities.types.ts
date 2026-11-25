export interface CreateActivityDto {
  activityTypeId: string
  entityType?: string // what the task is about; left out = nothing in particular ('general')
  entityId?: string
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

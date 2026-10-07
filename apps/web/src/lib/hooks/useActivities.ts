import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api'

export function useMyActivities(status?: string) {
  return useQuery({
    queryKey: ['activities-mine', status],
    queryFn: async () => {
      const res = await api.get('/activities/mine', { params: status ? { status } : {} })
      return res.data.data
    },
  })
}

export function useActivitiesForEntity(entityType: string, entityId: string) {
  return useQuery({
    queryKey: ['activities', entityType, entityId],
    queryFn: async () => {
      const res = await api.get(`/activities/${entityType}/${entityId}`)
      return res.data.data
    },
    enabled: !!entityId,
  })
}

export function useActivityTypes() {
  return useQuery({
    queryKey: ['activity-types'],
    queryFn: async () => {
      const res = await api.get('/activities/mine')
      return res.data.data
    },
  })
}

export function useCreateActivity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: {
      activityTypeId: string
      entityType: string
      entityId: string
      title: string
      note?: string
      assignedToId: string
      dueDate: string
    }) => {
      const res = await api.post('/activities', data)
      return res.data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['activities-mine'] })
    },
  })
}

export function useCompleteActivity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, doneNote }: { id: string; doneNote: string }) => {
      const res = await api.post(`/activities/${id}/complete`, { doneNote })
      return res.data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['activities-mine'] })
    },
  })
}

export function useCancelActivity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.post(`/activities/${id}/cancel`)
      return res.data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['activities-mine'] })
    },
  })
}

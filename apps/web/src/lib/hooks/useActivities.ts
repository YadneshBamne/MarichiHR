import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api'

// Tasks (activities). "Mine" are the ones assigned to me; "created" are the ones I made for other people.
const refreshTasks = (qc: ReturnType<typeof useQueryClient>) => ['activities-mine', 'activities-created', 'my-activities', 'dashboard', 'nav-counts'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }))

export function useMyActivities(status?: string) {
  return useQuery({
    queryKey: ['activities-mine', status],
    queryFn: async () => (await api.get('/activities/mine', { params: status ? { status } : {} })).data.data as any[],
  })
}

export function useCreatedActivities(enabled = true) {
  return useQuery({ queryKey: ['activities-created'], enabled, queryFn: async () => (await api.get('/activities/created')).data.data as any[] })
}

export function useActivitiesForEntity(entityType: string, entityId: string) {
  return useQuery({
    queryKey: ['activities', entityType, entityId],
    queryFn: async () => (await api.get(`/activities/${entityType}/${entityId}`)).data.data,
    enabled: !!entityId,
  })
}

export function useActivityTypes() {
  return useQuery({ queryKey: ['activity-types'], staleTime: 300_000, queryFn: async () => (await api.get('/activities/types')).data.data as { id: string; name: string; icon: string | null }[] })
}

export function useCreateActivity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: { activityTypeId: string; title: string; note?: string; assignedToId: string; dueDate: string; entityType?: string; entityId?: string }) => (await api.post('/activities', data)).data.data,
    onSuccess: () => refreshTasks(qc),
  })
}

export function useCompleteActivity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, doneNote }: { id: string; doneNote: string }) => (await api.post(`/activities/${id}/complete`, { doneNote })).data.data,
    onSuccess: () => refreshTasks(qc),
  })
}

export function useCancelActivity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => (await api.post(`/activities/${id}/cancel`)).data.data,
    onSuccess: () => refreshTasks(qc),
  })
}

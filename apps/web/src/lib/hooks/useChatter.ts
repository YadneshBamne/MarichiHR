import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api'

export function useChatter(entityType: string, entityId: string) {
  return useQuery({
    queryKey: ['chatter', entityType, entityId],
    queryFn: async () => {
      const res = await api.get(`/activities/chatter/${entityType}/${entityId}`)
      return res.data.data
    },
    enabled: !!entityId,
    refetchInterval: 30000,
  })
}

export function usePostChatterMessage(entityType: string, entityId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: { body: string; messageType?: string; isInternal?: boolean }) => {
      const res = await api.post('/activities/chatter', {
        entityType,
        entityId,
        ...data,
      })
      return res.data.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chatter', entityType, entityId] }),
  })
}

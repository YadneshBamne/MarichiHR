import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api'

export function useExits(enabled: boolean) {
  return useQuery({ queryKey: ['exits', 'list'], enabled, queryFn: async () => (await api.get('/exits')).data.data })
}

export function useExit(id: string) {
  return useQuery({ queryKey: ['exits', id], enabled: !!id, retry: false, queryFn: async () => (await api.get(`/exits/${id}`)).data.data })
}

export function useMyClearances() {
  return useQuery({ queryKey: ['exits', 'mine'], queryFn: async () => (await api.get('/exits/clearances/mine')).data.data })
}

// The signed-in person's own exit (steps and who has signed off, never pay) and whether they may hand in a resignation
export function useMyExit() {
  return useQuery({ queryKey: ['exits', 'my-exit'], retry: false, queryFn: async () => (await api.get('/exits/mine')).data.data as { exit: any | null; canResign: boolean } })
}

export function useResign() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: { reason: string; lastWorkingDate?: string }) => (await api.post('/exits/resign', data)).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exits'] }),
  })
}

export function useAssignableUsers(enabled: boolean) {
  return useQuery({ queryKey: ['exits', 'assignable-users'], enabled, queryFn: async () => (await api.get('/exits/assignable-users')).data.data })
}

export function useInitiateExit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => (await api.post('/exits', data)).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exits'] }),
  })
}

// path: compute | approve | pay | cancel | accept | decline | recovery | restore-login | clearances/<DEPT>/sign
export function useExitAction(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: Record<string, unknown> }) => (await api.post(`/exits/${id}/${path}`, body ?? {})).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exits'] }),
  })
}

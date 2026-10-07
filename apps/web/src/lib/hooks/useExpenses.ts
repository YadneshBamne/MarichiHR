import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api'

export function useExpenseCategories() {
  return useQuery({ queryKey: ['expenses', 'categories'], queryFn: async () => (await api.get('/expenses/categories')).data.data })
}

export function useMyClaims() {
  return useQuery({ queryKey: ['expenses', 'mine'], queryFn: async () => (await api.get('/expenses/claims/me')).data.data })
}

export function usePendingClaims(enabled: boolean) {
  return useQuery({ queryKey: ['expenses', 'pending'], enabled, queryFn: async () => (await api.get('/expenses/claims/pending')).data.data })
}

export function useAwaitingFinance(enabled: boolean) {
  return useQuery({ queryKey: ['expenses', 'finance'], enabled, queryFn: async () => (await api.get('/expenses/claims/awaiting-finance')).data.data })
}

export function usePerDiemQuote(params: { countryCode: string; city?: string; days: number; date: string }, enabled: boolean) {
  return useQuery({
    queryKey: ['expenses', 'per-diem-quote', params],
    enabled,
    retry: false,
    queryFn: async () => (await api.get('/expenses/per-diem/quote', { params: { ...params, city: params.city || undefined } })).data.data,
  })
}

export function useFxQuote(currency: string, date: string, enabled: boolean) {
  return useQuery({
    queryKey: ['expenses', 'fx-quote', currency, date],
    enabled,
    retry: false,
    queryFn: async () => (await api.get('/expenses/fx/quote', { params: { currency, date } })).data.data,
  })
}

export function useCreateClaim() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => (await api.post('/expenses/claims', data)).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  })
}

export function useWithdrawClaim() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => (await api.post(`/expenses/claims/${id}/withdraw`)).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  })
}

// action: approve | reject | finance-approve | finance-reject (reject variants need a reason)
export function useClaimAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, action, reason }: { id: string; action: string; reason?: string }) =>
      (await api.post(`/expenses/claims/${id}/${action}`, reason !== undefined ? { reason } : undefined)).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  })
}

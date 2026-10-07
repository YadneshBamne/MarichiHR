import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api'

export function useMyLeaveBalances() {
  return useQuery({
    queryKey: ['leave-balances-me'],
    queryFn: async () => {
      const res = await api.get('/leave/balances/me')
      return res.data.data
    },
  })
}

export function useEmployeeLeaveBalances(employeeId: string) {
  return useQuery({
    queryKey: ['leave-balances', employeeId],
    queryFn: async () => {
      const res = await api.get(`/leave/balances/${employeeId}`)
      return res.data.data
    },
    enabled: !!employeeId,
  })
}

export function useLeaveTypes() {
  return useQuery({
    queryKey: ['leave-types'],
    queryFn: async () => {
      const res = await api.get('/leave/types')
      return res.data.data
    },
  })
}

export function useMyLeaveRequests(params?: { status?: string; page?: number }) {
  return useQuery({
    queryKey: ['leave-requests-me', params],
    queryFn: async () => {
      const res = await api.get('/leave/requests/me', { params })
      return res.data.data
    },
  })
}

export function usePendingLeaveApprovals() {
  return useQuery({
    queryKey: ['leave-pending-approvals'],
    queryFn: async () => {
      const res = await api.get('/leave/requests/pending')
      return res.data.data
    },
    refetchInterval: 30000,
  })
}

export function useTeamLeaveCalendar(startDate: string, endDate: string) {
  return useQuery({
    queryKey: ['team-leave-calendar', startDate, endDate],
    queryFn: async () => {
      const res = await api.get('/leave/calendar/team', {
        params: { startDate, endDate },
      })
      return res.data.data
    },
    enabled: !!startDate && !!endDate,
  })
}

export function useApplyLeave() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: {
      leaveTypeId: string
      startDate: string
      endDate: string
      startHalf?: string
      endHalf?: string
      reason?: string
    }) => {
      const res = await api.post('/leave/requests', data)
      return res.data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave-balances-me'] })
      qc.invalidateQueries({ queryKey: ['leave-requests-me'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useApproveLeave() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, comments }: { id: string; comments?: string }) => {
      const res = await api.post(`/leave/requests/${id}/approve`, { comments })
      return res.data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave-pending-approvals'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useRejectLeave() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, comments }: { id: string; comments: string }) => {
      const res = await api.post(`/leave/requests/${id}/reject`, { comments })
      return res.data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave-pending-approvals'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useCancelLeave() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.post(`/leave/requests/${id}/cancel`)
      return res.data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave-requests-me'] })
      qc.invalidateQueries({ queryKey: ['leave-balances-me'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useRequestAllocation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: {
      leaveTypeId: string
      requestedDays: number
      reason: string
      supportingRefType?: string
    }) => {
      const res = await api.post('/leave/allocation-requests', data)
      return res.data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave-balances-me'] })
    },
  })
}

export function useLeaveAllocations(employeeId: string) {
  return useQuery({
    queryKey: ['leave-allocations', employeeId],
    queryFn: async () => {
      const res = await api.get(`/leave/allocations/${employeeId}`)
      return res.data.data
    },
    enabled: !!employeeId,
  })
}

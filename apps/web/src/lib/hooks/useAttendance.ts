import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api'

export function useTodayAttendance() {
  return useQuery({
    queryKey: ['attendance-today'],
    queryFn: async () => {
      const res = await api.get('/attendance/today')
      return res.data.data
    },
    refetchInterval: 60000,
  })
}

export function useMyAttendanceCalendar(year: number, month: number) {
  return useQuery({
    queryKey: ['attendance-calendar-me', year, month],
    queryFn: async () => {
      const res = await api.get('/attendance/calendar/me', { params: { year, month } })
      return res.data.data
    },
  })
}

export function useEmployeeAttendanceCalendar(employeeId: string, year: number, month: number) {
  return useQuery({
    queryKey: ['attendance-calendar', employeeId, year, month],
    queryFn: async () => {
      const res = await api.get(`/attendance/calendar/${employeeId}`, { params: { year, month } })
      return res.data.data
    },
    enabled: !!employeeId,
  })
}

export function useTeamAttendanceToday() {
  return useQuery({
    queryKey: ['team-attendance-today'],
    queryFn: async () => {
      const res = await api.get('/attendance/team/today')
      return res.data.data
    },
    refetchInterval: 120000,
  })
}

export function useClockIn() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: { method?: string; latitude?: number; longitude?: number; locationId?: string }) => {
      const res = await api.post('/attendance/clock-in', data)
      return res.data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attendance-today'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useClockOut() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: { method?: string; latitude?: number; longitude?: number }) => {
      const res = await api.post('/attendance/clock-out', data)
      return res.data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attendance-today'] })
      qc.invalidateQueries({ queryKey: ['attendance-calendar-me'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useRaiseRegularisation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: { date: string; actualIn: string; actualOut: string; reason: string }) => {
      const res = await api.post('/attendance/regularisations', data)
      return res.data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attendance-calendar-me'] })
      qc.invalidateQueries({ queryKey: ['my-regularisations'] })
    },
  })
}

export function useMyRegularisations() {
  return useQuery({
    queryKey: ['my-regularisations'],
    queryFn: async () => {
      const res = await api.get('/attendance/regularisations/me')
      return res.data.data
    },
  })
}

export function usePendingRegularisations(enabled = true) {
  return useQuery({
    queryKey: ['pending-regularisations'],
    enabled,
    queryFn: async () => {
      const res = await api.get('/attendance/regularisations/pending')
      return res.data.data
    },
    refetchInterval: 30000,
  })
}

export function useApproveRegularisation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.post(`/attendance/regularisations/${id}/approve`)
      return res.data.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending-regularisations'] }),
  })
}

export function useRejectRegularisation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.post(`/attendance/regularisations/${id}/reject`)
      return res.data.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending-regularisations'] }),
  })
}

export function useRequestOvertime() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: { date: string; overtimeHours: number; reason: string }) => {
      const res = await api.post('/attendance/overtime', data)
      return res.data.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-overtime'] }),
  })
}

export function useMyOvertime() {
  return useQuery({
    queryKey: ['my-overtime'],
    queryFn: async () => {
      const res = await api.get('/attendance/overtime/me')
      return res.data.data
    },
  })
}

export function usePendingOvertime(enabled = true) {
  return useQuery({
    queryKey: ['pending-overtime'],
    enabled,
    queryFn: async () => {
      const res = await api.get('/attendance/overtime/pending')
      return res.data.data
    },
    refetchInterval: 30000,
  })
}

export function useApproveOvertime() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, approvedRate }: { id: string; approvedRate?: number }) => {
      const res = await api.post(`/attendance/overtime/${id}/approve`, { approvedRate: approvedRate ?? 1.5 })
      return res.data.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending-overtime'] }),
  })
}

export function useRejectOvertime() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.post(`/attendance/overtime/${id}/reject`)
      return res.data.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending-overtime'] }),
  })
}

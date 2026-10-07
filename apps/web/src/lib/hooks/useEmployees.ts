import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api'

export function useEmployees(params?: {
  page?: number
  limit?: number
  search?: string
  orgUnitId?: string
  employmentType?: string
  showArchived?: boolean
}) {
  return useQuery({
    queryKey: ['employees', params],
    queryFn: async () => {
      const res = await api.get('/employees', { params })
      return res.data
    },
  })
}

export function useEmployee(id: string) {
  return useQuery({
    queryKey: ['employee', id],
    queryFn: async () => {
      const res = await api.get(`/employees/${id}`)
      return res.data.data
    },
    enabled: !!id,
  })
}

export function useOrgTree() {
  return useQuery({
    queryKey: ['org-tree'],
    queryFn: async () => {
      const res = await api.get('/employees/org-units/tree')
      return res.data.data
    },
  })
}

export function useJobPositions(orgUnitId?: string) {
  return useQuery({
    queryKey: ['job-positions', orgUnitId],
    queryFn: async () => {
      const res = await api.get('/employees/job-positions', {
        params: orgUnitId ? { orgUnitId } : {},
      })
      return res.data.data
    },
  })
}

export function useWorkLocations() {
  return useQuery({
    queryKey: ['work-locations'],
    queryFn: async () => {
      const res = await api.get('/employees/work-locations')
      return res.data.data
    },
  })
}

export function useSkillTypes() {
  return useQuery({
    queryKey: ['skill-types'],
    queryFn: async () => {
      const res = await api.get('/employees/skill-types')
      return res.data.data
    },
  })
}

export function useCreateEmployee() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: any) => {
      const res = await api.post('/employees', data)
      return res.data.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  })
}

export function useUpdateEmployee(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: any) => {
      const res = await api.patch(`/employees/${id}`, data)
      return res.data.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employee', id] })
      qc.invalidateQueries({ queryKey: ['employees'] })
    },
  })
}

export function useArchiveEmployee() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const res = await api.post(`/employees/${id}/archive`, { reason })
      return res.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  })
}

export function useAddSkill(employeeId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: any) => {
      const res = await api.post(`/employees/${employeeId}/skills`, data)
      return res.data.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employee', employeeId] }),
  })
}

export function useRemoveSkill(employeeId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (skillId: string) => {
      await api.delete(`/employees/${employeeId}/skills/${skillId}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employee', employeeId] }),
  })
}

export function useAddResumeLine(employeeId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: any) => {
      const res = await api.post(`/employees/${employeeId}/resume`, data)
      return res.data.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employee', employeeId] }),
  })
}

export function useUpdateBank(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: { bankName: string; bankAccountNo: string; bankIfscSwift?: string }) =>
      (await api.patch(`/employees/${id}/bank`, data)).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employee', id] }),
  })
}

export function useVerifyBank(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => (await api.post(`/employees/${id}/bank/verify`)).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employee', id] }),
  })
}

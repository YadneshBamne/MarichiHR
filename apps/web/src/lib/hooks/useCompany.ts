import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api'
import { useAuth } from '../../contexts/AuthContext'

export function useCompany() {
  return useQuery({ queryKey: ['company'], queryFn: async () => (await api.get('/company')).data.data })
}

// Company changes also refresh the signed-in user so the shell (name, logo, apps) updates at once
export function useCompanyWrite() {
  const qc = useQueryClient()
  const { refreshMe } = useAuth()
  const done = async (data: any) => { qc.setQueryData(['company'], data); await refreshMe() }
  return {
    update: useMutation({ mutationFn: async (body: Record<string, unknown>) => (await api.patch('/company', body)).data.data, onSuccess: done }),
    setApps: useMutation({ mutationFn: async (modules: string[]) => (await api.put('/company/modules', { modules })).data.data, onSuccess: done }),
    complete: useMutation({ mutationFn: async () => (await api.post('/company/onboarding/complete')).data.data, onSuccess: done }),
  }
}

export function useEmployeeAccess(employeeId: string, enabled = true) {
  return useQuery({ queryKey: ['employee-access', employeeId], enabled: !!employeeId && enabled, queryFn: async () => (await api.get(`/employees/${employeeId}/access`)).data.data })
}

export function useSetEmployeeAccess(employeeId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: { roles?: string[]; loginEnabled?: boolean; password?: string }) => (await api.put(`/employees/${employeeId}/access`, body)).data.data,
    onSuccess: (data) => qc.setQueryData(['employee-access', employeeId], data),
  })
}

export const ROLE_INFO: { name: string; label: string; hint: string; sysOnly?: boolean }[] = [
  { name: 'manager', label: 'Manager', hint: 'Approves leave and attendance for their direct reports' },
  { name: 'hr_admin', label: 'HR admin', hint: 'Manages people, leave policy and onboarding for the whole company' },
  { name: 'payroll_admin', label: 'Payroll / finance', hint: 'Runs payroll, finance-approves expenses and payroll' },
  { name: 'compliance_officer', label: 'Compliance', hint: 'Statutory configuration and audit access', sysOnly: true },
  { name: 'system_admin', label: 'System admin', hint: 'Company settings, apps and who can sign in', sysOnly: true },
]

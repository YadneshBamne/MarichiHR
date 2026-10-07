import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api'

const KEYS = ['payroll-cycles', 'payroll-cycle', 'payroll-payslips', 'payroll-variance', 'payroll-inputs', 'my-payslips', 'payslip']

export function useCycles(enabled = true) {
  return useQuery({ queryKey: ['payroll-cycles'], enabled, queryFn: async () => (await api.get('/payroll/cycles')).data.data })
}
export function useCycle(id: string) {
  return useQuery({ queryKey: ['payroll-cycle', id], enabled: !!id, queryFn: async () => (await api.get(`/payroll/cycles/${id}`)).data.data })
}
export function useCyclePayslips(id: string) {
  return useQuery({ queryKey: ['payroll-payslips', id], enabled: !!id, queryFn: async () => (await api.get(`/payroll/cycles/${id}/payslips`)).data.data })
}
export function useVariance(id: string, enabled = true) {
  return useQuery({ queryKey: ['payroll-variance', id], enabled: !!id && enabled, queryFn: async () => (await api.get(`/payroll/cycles/${id}/variance-report`)).data.data })
}
export function useCycleInputs(id: string) {
  return useQuery({ queryKey: ['payroll-inputs', id], enabled: !!id, queryFn: async () => (await api.get(`/payroll/cycles/${id}/inputs`)).data.data })
}
export function useInputTypes() {
  return useQuery({ queryKey: ['salary-input-types'], queryFn: async () => (await api.get('/salary/input-types')).data.data })
}
export function useMyPayslips() {
  return useQuery({ queryKey: ['my-payslips'], queryFn: async () => (await api.get('/payroll/payslips/me')).data.data })
}
export function usePayslip(id: string) {
  return useQuery({ queryKey: ['payslip', id], enabled: !!id, queryFn: async () => (await api.get(`/payroll/payslips/${id}`)).data.data })
}

export function useCreateCycle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: { payPeriodStart: string; payPeriodEnd: string }) => (await api.post('/payroll/cycles', data)).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll-cycles'] }),
  })
}

// action: lock-attendance | run | approve | finance-approve | reopen | disburse
export function useCycleAction(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (action: string) => (await api.post(`/payroll/cycles/${id}/${action}`)).data.data,
    onSuccess: () => KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  })
}

export function useAddInput(cycleId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: { employeeId: string; inputTypeId: string; amount: number; description?: string }) =>
      (await api.post(`/payroll/cycles/${cycleId}/inputs`, data)).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll-inputs', cycleId] }),
  })
}

export function useApproveInput(cycleId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (inputId: string) => (await api.post(`/payroll/inputs/${inputId}/approve`)).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll-inputs', cycleId] }),
  })
}

export async function downloadPayslipPdf(payslipId: string) {
  const res = await api.get(`/payroll/payslips/${payslipId}/pdf`, { responseType: 'blob' })
  const cd: string = res.headers['content-disposition'] || ''
  const match = /filename="?([^"]+)"?/.exec(cd)
  const filename = match?.[1] || 'payslip.pdf'
  const url = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function useBankFilePreview(cycleId: string, enabled = true) {
  return useQuery({
    queryKey: ['bank-file-preview', cycleId],
    enabled: !!cycleId && enabled,
    retry: false,
    queryFn: async () => (await api.get(`/payroll/cycles/${cycleId}/bank-file/preview`)).data.data,
  })
}

export async function downloadCsv(path: string, params?: Record<string, string | boolean>) {
  try {
    const res = await api.get(path, { params, responseType: 'blob' })
    const cd: string = res.headers['content-disposition'] || ''
    const match = /filename="?([^"]+)"?/.exec(cd)
    const filename = match?.[1] || 'export.csv'
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (err: any) {
    // With responseType 'blob' an error body arrives as a Blob — turn it back into JSON
    const data = err?.response?.data
    if (data instanceof Blob) {
      try { err.response.data = JSON.parse(await data.text()) } catch { /* keep as is */ }
    }
    throw err
  }
}

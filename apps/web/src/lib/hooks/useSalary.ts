import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api'

const get = (path: string) => async () => (await api.get(path)).data.data

export const useRuleCategories = () => useQuery({ queryKey: ['salary', 'rule-categories'], queryFn: get('/salary/rule-categories') })
export const useStructureTypes = () => useQuery({ queryKey: ['salary', 'structure-types'], queryFn: get('/salary/structure-types') })
export const useStructures = () => useQuery({ queryKey: ['salary', 'structures'], queryFn: get('/salary/structures') })
export const useGradeBands = () => useQuery({ queryKey: ['salary', 'grade-bands'], queryFn: get('/salary/grade-bands') })
export const useContracts = () => useQuery({ queryKey: ['salary', 'contracts'], queryFn: get('/salary/contracts') })

// One mutation for every salary-admin write; refreshes all salary queries afterwards
export function useSalaryWrite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ method, path, body }: { method: 'post' | 'patch' | 'delete'; path: string; body?: Record<string, unknown> }) =>
      (await api.request({ method, url: path, data: body ?? {} })).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['salary'] }),
  })
}

export async function checkRule(body: Record<string, unknown>) {
  return (await api.post('/salary/rules/check', body)).data.data
}

export const errMsg = (err: any, fallback = 'Something went wrong') => err?.response?.data?.message || fallback

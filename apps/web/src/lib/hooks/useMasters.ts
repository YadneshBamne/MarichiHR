import { useQuery } from '@tanstack/react-query'
import api from '../api'

// The company's master lists (every dropdown's options). One request, cached; admins editing Masters invalidate ['masters'].
export interface MasterValue { id: string; code: string; label: string; active: boolean; isSystem: boolean; sortOrder: number; meta: Record<string, any> | null }
export interface MasterListData { key: string; name: string; group: string; description: string; values: MasterValue[] }

export function useMasters(all = false) {
  const q = useQuery({
    queryKey: ['masters', all],
    queryFn: async () => (await api.get('/masters', { params: all ? { all: '1' } : {} })).data.data as MasterListData[],
    staleTime: 5 * 60_000,
  })
  const lists = q.data ?? []
  const values = (key: string) => lists.find((l) => l.key === key)?.values ?? []
  // Label for a stored code; codes no longer in the list (or free text from before masters) show as stored
  const label = (key: string, code?: string | null) => (code ? values(key).find((v) => v.code === code)?.label ?? code : '')
  return { ...q, lists, values, label }
}

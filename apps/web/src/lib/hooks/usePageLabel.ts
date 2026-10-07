import { useAuth } from '../../contexts/AuthContext'
import { navLabel } from '../nav'

export const usePageLabel = (path: string) => {
  const { user } = useAuth()
  return navLabel(path, user?.roles?.map((r) => r.name) ?? [])
}

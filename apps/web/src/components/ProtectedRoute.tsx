import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { Mark } from './brand/Logo'
import { ForbiddenPage } from '../pages/system/StatusPages'

interface Props {
  children: React.ReactNode
  roles?: string[] // any of these role names
}

export function SplashScreen() {
  return (
    <div className="canvas" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }} aria-busy="true" aria-label="Loading MarichiHR">
      <span style={{ animation: 'spin 2.4s linear infinite', display: 'inline-flex' }}><Mark size={44} /></span>
      <span className="muted" style={{ fontSize: 13 }}>Loading your workspace…</span>
    </div>
  )
}

export default function ProtectedRoute({ children, roles }: Props) {
  const { isAuthenticated, isLoading, user } = useAuth()
  const location = useLocation()

  if (isLoading) return <SplashScreen />
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  if (roles && !user?.roles?.some((r) => roles.includes(r.name))) return <ForbiddenPage />

  return <>{children}</>
}

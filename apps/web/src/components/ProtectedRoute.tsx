import { Link, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { Mark } from './brand/Logo'
import Icon from './ui/Icon'
import { ForbiddenPage } from '../pages/system/StatusPages'
import { appByKey } from '../lib/apps'

interface Props {
  children: React.ReactNode
  roles?: string[] // any of these role names
  app?: string // the company must have installed this app
  stage?: 'app' | 'onboarding' | 'password' // which gate the route belongs to
}

export function SplashScreen() {
  return (
    <div className="canvas" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }} aria-busy="true" aria-label="Loading">
      <span style={{ animation: 'spin 2.4s linear infinite', display: 'inline-flex' }}><Mark size={44} /></span>
      <span className="muted" style={{ fontSize: 13 }}>Loading your workspace…</span>
    </div>
  )
}

// Order of gates: signed in → temporary password replaced → company set up → role → installed app
export default function ProtectedRoute({ children, roles, app, stage = 'app' }: Props) {
  const { isAuthenticated, isLoading, user, isAdmin } = useAuth()
  const location = useLocation()

  if (isLoading) return <SplashScreen />
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />

  if (user?.mustChangePassword) return stage === 'password' ? <>{children}</> : <Navigate to="/change-password" replace />
  if (stage === 'password') return <Navigate to="/dashboard" replace />

  const onboarded = !!user?.tenant?.onboardedAt
  if (!onboarded && stage !== 'onboarding') return isAdmin ? <Navigate to="/onboarding" replace /> : <SetupPending />
  if (stage === 'onboarding' && (onboarded || !isAdmin)) return <Navigate to="/dashboard" replace />

  if (roles && !user?.roles?.some((r) => roles.includes(r.name))) return <ForbiddenPage />
  if (app && !user?.tenant?.modules?.includes(app)) return <AppNotInstalled app={app} canInstall={!!user?.roles?.some((r) => r.name === 'system_admin')} />

  return <>{children}</>
}

function SetupPending() {
  return (
    <div className="canvas" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
      <div style={{ maxWidth: 420 }}>
        <Mark size={44} />
        <h1 style={{ fontSize: 30, marginTop: 18 }}>Your workspace is being set up</h1>
        <p className="dim" style={{ marginTop: 8, lineHeight: 1.6 }}>Your administrator is still finishing the company setup. Check back shortly.</p>
      </div>
    </div>
  )
}

function AppNotInstalled({ app, canInstall }: { app: string; canInstall: boolean }) {
  const def = appByKey(app)
  return (
    <div style={{ textAlign: 'center', padding: '10vh 16px', maxWidth: 480, margin: '0 auto' }}>
      <div style={{ width: 84, height: 84, margin: '0 auto', borderRadius: '50%', background: def?.tint ?? 'var(--honey)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={def?.icon ?? 'grid'} size={34} stroke={1.4} /></div>
      <h1 style={{ fontSize: 30, marginTop: 20 }}>{def?.name ?? app} isn't installed</h1>
      <p className="dim" style={{ marginTop: 8, lineHeight: 1.6 }}>{def?.tagline} {canInstall ? 'Add it from Settings › Apps.' : 'Ask your administrator to add it.'}</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22 }}>
        {canInstall && <Link to="/settings/apps" className="btn btn-primary"><Icon name="grid" size={16} /> Manage apps</Link>}
        <Link to="/dashboard" className="btn btn-ghost">Back to dashboard</Link>
      </div>
    </div>
  )
}

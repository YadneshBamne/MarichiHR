import { useState } from 'react'
import { Link, useLocation, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'

const NAV_ITEMS = [
  { label: 'Dashboard', path: '/dashboard', icon: '⊞', roles: [] },
  { label: 'Employees', path: '/employees', icon: '👥', roles: ['hr_admin', 'system_admin'] },
  { label: 'Leave', path: '/leave', icon: '🌿', roles: [] },
  { label: 'Attendance', path: '/attendance', icon: '⏱', roles: [] },
  { label: 'Payroll', path: '/payroll', icon: '💰', roles: [] },
  { label: 'Expenses', path: '/expenses', icon: '🧾', roles: [] },
  { label: 'Approvals', path: '/approvals', icon: '✓', roles: ['manager', 'hr_admin', 'system_admin'] },
  { label: 'Activities', path: '/activities', icon: '📋', roles: [] },
]

export default function AppShell() {
  const { user, logout, isManager } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const { data: pendingLeave = [] } = useQuery({
    queryKey: ['leave-pending-count'],
    queryFn: async () => {
      const res = await api.get('/leave/requests/pending')
      return res.data.data ?? []
    },
    enabled: isManager,
    refetchInterval: 60000,
    staleTime: 30000,
  })
  const pendingCount = Array.isArray(pendingLeave) ? pendingLeave.length : 0

  const visibleNavItems = NAV_ITEMS.filter((item) => {
    if (item.roles.length === 0) return true
    return item.roles.some((role) => user?.roles?.some((r) => r.name === role))
  })

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  const getPageTitle = () => {
    const match = NAV_ITEMS.find((n) => location.pathname.startsWith(n.path))
    return match?.label || 'MarichiHR'
  }

  return (
    <div style={s.root}>
      {/* Sidebar */}
      <aside style={{ ...s.sidebar, width: sidebarOpen ? '220px' : '60px' }}>
        {/* Logo */}
        <div style={s.logoRow}>
          <div style={s.logoIcon}>MH</div>
          {sidebarOpen && <span style={s.logoText}>MarichiHR</span>}
        </div>

        {/* Nav */}
        <nav style={s.nav}>
          {visibleNavItems.map((item) => {
            const active = location.pathname.startsWith(item.path)
            return (
              <Link
                key={item.path}
                to={item.path}
                style={{
                  ...s.navItem,
                  ...(active ? s.navItemActive : {}),
                  justifyContent: sidebarOpen ? 'flex-start' : 'center',
                }}
              >
                <span style={s.navIcon}>{item.icon}</span>
                {sidebarOpen && <span style={s.navLabel}>{item.label}</span>}
                {item.path === '/approvals' && pendingCount > 0 && (
                  <span style={s.navBadge}>{pendingCount}</span>
                )}
              </Link>
            )
          })}
        </nav>

        {/* User footer */}
        <div style={s.userSection}>
          <div style={s.avatar}>{user?.fullName?.charAt(0) || 'U'}</div>
          {sidebarOpen && (
            <div style={s.userInfo}>
              <div style={s.userName}>{user?.fullName}</div>
              <div style={s.userRole}>{user?.roles?.[0]?.name?.replace(/_/g, ' ')}</div>
            </div>
          )}
        </div>
      </aside>

      {/* Main */}
      <div style={s.main}>
        {/* Top bar */}
        <header style={s.topBar}>
          <button style={s.menuBtn} onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
          <span style={s.pageTitle}>{getPageTitle()}</span>
          <div style={s.topRight}>
            <span style={s.tenantBadge}>{user?.tenant?.name}</span>
            <button style={s.logoutBtn} onClick={handleLogout}>Sign out</button>
          </div>
        </header>

        {/* Page content */}
        <main style={s.content}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { display: 'flex', height: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', backgroundColor: '#f5f4f0' },
  sidebar: { backgroundColor: '#fff', borderRight: '0.5px solid #e2e0da', display: 'flex', flexDirection: 'column', flexShrink: 0, transition: 'width 0.2s', overflow: 'hidden' },
  logoRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '16px', borderBottom: '0.5px solid #e2e0da' },
  logoIcon: { width: '30px', height: '30px', borderRadius: '7px', backgroundColor: '#534AB7', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '600', flexShrink: 0 },
  logoText: { fontSize: '15px', fontWeight: '500', color: '#1a1a18', whiteSpace: 'nowrap' },
  nav: { flex: 1, padding: '8px 0', overflow: 'hidden' },
  navItem: { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 16px', textDecoration: 'none', color: '#5c5c58', fontSize: '13px', borderLeft: '2px solid transparent', transition: 'all 0.15s', whiteSpace: 'nowrap' },
  navItemActive: { color: '#1a1a18', fontWeight: '500', borderLeftColor: '#534AB7', backgroundColor: '#f0effe' },
  navIcon: { fontSize: '15px', flexShrink: 0 },
  navLabel: { fontSize: '13px' },
  userSection: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', borderTop: '0.5px solid #e2e0da' },
  avatar: { width: '30px', height: '30px', borderRadius: '50%', backgroundColor: '#534AB7', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: '600', flexShrink: 0 },
  userInfo: { overflow: 'hidden' },
  userName: { fontSize: '12px', fontWeight: '500', color: '#1a1a18', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  userRole: { fontSize: '11px', color: '#8c8c88', textTransform: 'capitalize', whiteSpace: 'nowrap' },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  topBar: { height: '57px', backgroundColor: '#fff', borderBottom: '0.5px solid #e2e0da', display: 'flex', alignItems: 'center', gap: '12px', padding: '0 20px', flexShrink: 0 },
  menuBtn: { background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: '#5c5c58', padding: '4px', lineHeight: 1 },
  pageTitle: { fontSize: '15px', fontWeight: '500', color: '#1a1a18', flex: 1 },
  topRight: { display: 'flex', alignItems: 'center', gap: '12px' },
  tenantBadge: { fontSize: '12px', color: '#5c5c58', backgroundColor: '#f5f4f0', padding: '4px 10px', borderRadius: '12px', border: '0.5px solid #e2e0da' },
  logoutBtn: { background: 'none', border: 'none', fontSize: '13px', color: '#5c5c58', cursor: 'pointer' },
  content: { flex: 1, overflow: 'auto', padding: '24px' },
  navBadge: { marginLeft: 'auto', backgroundColor: '#993C1D', color: '#fff', fontSize: '10px', fontWeight: '600', padding: '1px 6px', borderRadius: '10px', minWidth: '16px', textAlign: 'center' as const },
}

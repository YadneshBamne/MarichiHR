import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import api from '../lib/api'
import { visibleSections, itemFor, labelFor } from '../lib/nav'
import { gsap, reduced } from '../lib/motion'
import Logo from './brand/Logo'
import { CompanyLogo } from './company/CompanyParts'
import Icon from './ui/Icon'
import Avatar from './ui/Avatar'
import Popover from './ui/Popover'
import NotificationBell from './NotificationBell'
import CommandPalette from './CommandPalette'
import ProductTour from './ProductTour'

const ROLE_LABEL: Record<string, string> = { system_admin: 'Administrator', hr_admin: 'HR administrator', payroll_admin: 'Payroll & finance', compliance_officer: 'Compliance', manager: 'Manager', employee: 'Employee' }
export const primaryRole = (roles: string[]) => ['system_admin', 'hr_admin', 'payroll_admin', 'compliance_officer', 'manager', 'employee'].find((r) => roles.includes(r)) ?? 'employee'
const COLLAPSE_KEY = 'marichihr.sidebar.collapsed'

export default function AppShell() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const roles = user?.roles?.map((r) => r.name) ?? []
  const apps = user?.tenant?.modules ?? []
  const sections = visibleSections(roles, apps)
  const companyName = user?.tenant?.name || 'MarichiHR'
  const current = itemFor(location.pathname)
  const [palette, setPalette] = useState(false)
  const [menu, setMenu] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [tour, setTour] = useState(false)
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false } })
  const toggleCollapsed = () => setCollapsed((c) => { try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1') } catch { /* ignore */ } return !c })

  // Badge counts for the sidebar (approvals waiting for me), one light request
  const { data: counts } = useQuery({ queryKey: ['nav-counts'], queryFn: async () => (await api.get('/dashboard/counts')).data.data as { approvals: number; tasks: number; announcements?: number }, refetchInterval: 60000 })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); toggleCollapsed() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // First sign-in: run the product tour once the dashboard has painted
  useEffect(() => {
    if (user && !user.tourDoneAt && location.pathname === '/dashboard') {
      const t = setTimeout(() => setTour(true), 1200)
      return () => clearTimeout(t)
    }
  }, [user?.tourDoneAt]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDrawer(false); setMenu(false) }, [location.pathname])

  const pageTitle = current ? labelFor(current, roles) : location.pathname.startsWith('/employees/') ? 'Employee profile' : ''
  useEffect(() => { document.title = `${pageTitle ? pageTitle + ' · ' : ''}${companyName}` }, [companyName, pageTitle])

  const startTour = () => { if (location.pathname !== '/dashboard') navigate('/dashboard'); setTimeout(() => setTour(true), 500) }
  const signOut = async () => { await logout(); navigate('/login') }

  // Page transition: the outlet rises in on every route change
  const main = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (main.current && !reduced()) gsap.fromTo(main.current, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.55, ease: 'power3.out', clearProps: 'transform,opacity' })
  }, [location.pathname])

  const sidebar = (mode: 'desktop' | 'drawer') => (
    <Sidebar sections={sections} counts={counts} collapsed={mode === 'desktop' && collapsed} onToggle={mode === 'desktop' ? toggleCollapsed : () => setDrawer(false)} mode={mode}
      companyName={companyName} logoUrl={user?.tenant?.logoUrl} userName={user?.fullName || ''} avatarUrl={user?.avatarUrl} role={ROLE_LABEL[primaryRole(roles)]} />
  )

  return (
    <div className="canvas shell" data-collapsed={collapsed ? '1' : '0'}>
      <a href="#main" style={s.skip} onFocus={(e) => (e.currentTarget.style.top = '8px')} onBlur={(e) => (e.currentTarget.style.top = '-60px')}>Skip to content</a>
      <div className="shell-side desktop-only-block">{sidebar('desktop')}</div>

      <div className="shell-main">
        <header style={s.bar}>
          <button className="btn btn-ghost btn-icon mobile-only" aria-label="Open navigation" onClick={() => setDrawer(true)}><Icon name="list" size={17} /></button>
          <div style={{ minWidth: 0 }}>
            {current?.section && current.section.key !== 'home' && <div className="muted" style={{ fontSize: 12 }}>{current.section.label}</div>}
            <div className="display" style={{ fontSize: 20, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pageTitle}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            <button className="btn btn-ghost desktop-only" data-tour="search" onClick={() => setPalette(true)} style={{ gap: 10, paddingRight: 10, color: 'var(--dim)', minWidth: 220, justifyContent: 'flex-start' }} aria-label="Search (Ctrl+K)">
              <Icon name="search" size={16} /> <span style={{ fontWeight: 400, flex: 1, textAlign: 'left' }}>Search…</span>
              <kbd style={s.kbd}>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd>
            </button>
            <button className="btn btn-ghost btn-icon mobile-only" aria-label="Search" onClick={() => setPalette(true)}><Icon name="search" size={17} /></button>
            <NotificationBell />
            <div style={{ position: 'relative' }} data-tour="profile">
              <button onClick={() => setMenu(!menu)} aria-label="Account menu" aria-expanded={menu} style={s.avatarBtn}>
                <Avatar name={user?.fullName || '?'} src={user?.avatarUrl} size={34} />
              </button>
              <Popover open={menu} onClose={() => setMenu(false)} label="Account" width={280}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 18, borderBottom: '1px solid var(--line)' }}>
                  <Avatar name={user?.fullName || '?'} src={user?.avatarUrl} size={42} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.fullName}</div>
                    <div className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.email}</div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>{roles.filter((r) => r !== 'employee').map((r) => <span key={r} className="pill mute" style={{ height: 20, textTransform: 'none' }}>{ROLE_LABEL[r] ?? r}</span>)}</div>
                  </div>
                </div>
                <nav style={{ padding: 8 }}>
                  {user?.employee && <MenuLink to={`/employees/${user.employee.id}`} icon="user" label="My profile" />}
                  <MenuLink to="/security" icon="lock" label="Security & two-factor" />
                  <button style={s.menuItem} onClick={() => { setMenu(false); startTour() }}><Icon name="compass" size={16} /> Product tour</button>
                  <button style={s.menuItem} onClick={() => { setMenu(false); setPalette(true) }}><Icon name="command" size={16} /> Search &amp; shortcuts</button>
                  <div style={{ height: 1, background: 'var(--line)', margin: '6px 8px' }} />
                  <button style={{ ...s.menuItem, color: 'var(--danger)' }} onClick={signOut}><Icon name="logout" size={16} /> Sign out</button>
                </nav>
                <div className="muted" style={{ fontSize: 11, padding: '10px 18px 14px', display: 'flex', alignItems: 'center', gap: 6, borderTop: '1px solid var(--line)' }}>{companyName} · powered by <Logo size={12} /></div>
              </Popover>
            </div>
          </div>
        </header>

        <main id="main" ref={main} tabIndex={-1} style={{ outline: 'none', marginTop: 20 }}>
          <Outlet />
        </main>
      </div>

      {drawer && <Drawer onClose={() => setDrawer(false)}>{sidebar('drawer')}</Drawer>}
      <CommandPalette open={palette} onClose={() => setPalette(false)} onTour={startTour} />
      {tour && <ProductTour onClose={() => setTour(false)} />}
    </div>
  )
}

function Sidebar({ sections, counts, collapsed, onToggle, mode, companyName, logoUrl, userName, avatarUrl, role }: {
  sections: ReturnType<typeof visibleSections>; counts?: { approvals: number; tasks: number; announcements?: number }; collapsed: boolean; onToggle: () => void; mode: 'desktop' | 'drawer'
  companyName: string; logoUrl?: string | null; userName: string; avatarUrl?: string; role: string
}) {
  const { pathname } = useLocation()
  const nav = useRef<HTMLElement>(null)
  const pill = useRef<HTMLSpanElement>(null)
  const first = useRef(true)
  const activePath = itemFor(pathname)?.path

  // The dark highlight glides to the active item
  useLayoutEffect(() => {
    const move = () => {
      const el = nav.current?.querySelector<HTMLElement>(`[data-path="${activePath}"]`)
      if (!pill.current) return
      if (!el) { gsap.set(pill.current, { opacity: 0 }); return }
      const to = { y: el.offsetTop, height: el.offsetHeight, opacity: 1 }
      if (first.current || reduced()) gsap.set(pill.current, to)
      else gsap.to(pill.current, { ...to, duration: 0.55, ease: 'expo.out' })
      first.current = false
    }
    move()
    const t = setTimeout(move, 360) // after the width transition when collapsing
    return () => clearTimeout(t)
  }, [activePath, collapsed, sections.length])

  const badge = (path: string) => (path === '/approvals' ? counts?.approvals : path === '/activities' ? counts?.tasks : path === '/announcements' ? counts?.announcements : 0) || 0

  return (
    <aside className="sidebar card" data-collapsed={collapsed ? '1' : '0'} aria-label="Main navigation" data-tour="sidebar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: collapsed ? '6px 0' : '6px 4px 6px 6px', justifyContent: collapsed ? 'center' : 'flex-start' }} data-tour="brand">
        <CompanyLogo name={companyName} src={logoUrl} size={36} />
        {!collapsed && <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 500, letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={companyName}>{companyName}</span>}
        {!collapsed && <button className="btn btn-ghost btn-icon" style={{ width: 30, height: 30 }} onClick={onToggle} aria-label={mode === 'drawer' ? 'Close navigation' : 'Collapse sidebar (Ctrl+\\)'}><Icon name={mode === 'drawer' ? 'x' : 'chevronLeft'} size={15} /></button>}
      </div>
      {collapsed && <button className="btn btn-ghost btn-icon" style={{ width: 34, height: 30, margin: '4px auto 0' }} onClick={onToggle} aria-label="Expand sidebar (Ctrl+\\)"><Icon name="chevronRight" size={15} /></button>}

      <nav ref={nav} className="scroll-y" style={{ position: 'relative', flex: 1, marginTop: 14, overflowX: 'hidden' }}>
        <span ref={pill} aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: 0, borderRadius: 14, background: 'var(--night)', opacity: 0, zIndex: 0 }} />
        {sections.map((sec) => (
          <div key={sec.key} style={{ marginBottom: 10 }}>
            {sec.key !== 'home' && (collapsed ? <div style={{ height: 1, background: 'var(--line)', margin: '8px 10px' }} /> : <div className="muted" style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.04em', padding: '8px 12px 4px' }}>{sec.label}</div>)}
            {sec.items.map((it) => {
              const on = it.path === activePath
              const n = badge(it.path)
              return (
                <Link key={it.path} to={it.path} data-path={it.path} data-tour={`nav-${it.path.replace(/\W+/g, '-').replace(/^-|-$/g, '')}`} aria-current={on ? 'page' : undefined} title={collapsed ? it.label : undefined}
                  className="side-link" style={{ color: on ? 'var(--night-ink)' : 'var(--dim)', justifyContent: collapsed ? 'center' : 'flex-start', padding: collapsed ? '10px 0' : '9px 12px' }}>
                  <Icon name={it.icon} size={17} />
                  {!collapsed && <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>}
                  {!collapsed && it.soon && <span className="pill honey" style={{ height: 18, fontSize: 10 }}>Soon</span>}
                  {n > 0 && (collapsed
                    ? <span style={{ position: 'absolute', top: 6, right: 14, width: 8, height: 8, borderRadius: '50%', background: 'var(--honey)' }} aria-label={`${n} pending`} />
                    : <span style={{ minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, background: on ? 'var(--honey)' : 'var(--night)', color: on ? 'var(--ink)' : 'var(--night-ink)', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>)}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      <Link to="/security" className="side-user" style={{ justifyContent: collapsed ? 'center' : 'flex-start' }} title={collapsed ? `${userName} · ${role}` : undefined}>
        <Avatar name={userName || '?'} src={avatarUrl} size={34} />
        {!collapsed && <span style={{ minWidth: 0 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{userName}</span><span className="muted" style={{ fontSize: 11 }}>{role}</span></span>}
      </Link>
    </aside>
  )
}

function Drawer({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (ref.current && !reduced()) gsap.fromTo(ref.current, { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: 'power3.out' }) }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 800, background: 'rgba(37,37,35,.3)' }}>
      <div ref={ref} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Navigation" style={{ position: 'absolute', inset: '10px auto 10px 10px', width: 'min(290px, 86vw)', display: 'flex' }}>{children}</div>
    </div>
  )
}

function MenuLink({ to, icon, label }: { to: string; icon: Parameters<typeof Icon>[0]['name']; label: string }) {
  return <Link to={to} style={s.menuItem}><Icon name={icon} size={16} /> <span style={{ flex: 1 }}>{label}</span></Link>
}

const s: Record<string, React.CSSProperties> = {
  skip: { position: 'fixed', left: 16, top: -60, zIndex: 1000, background: 'var(--night)', color: 'var(--night-ink)', padding: '8px 14px', borderRadius: 999, fontSize: 13, transition: 'top .2s' },
  bar: { display: 'flex', alignItems: 'center', gap: 12, position: 'relative', zIndex: 50, minHeight: 50 },
  kbd: { fontSize: 10.5, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--line-2)', color: 'var(--faint)', fontFamily: 'var(--font-body)' },
  avatarBtn: { border: 'none', background: 'none', padding: 0, borderRadius: '50%', display: 'inline-flex', boxShadow: '0 0 0 3px var(--card-2)' },
  menuItem: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 12, border: 'none', background: 'none', fontSize: 13, color: 'var(--ink)', textAlign: 'left' },
}

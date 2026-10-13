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
import { Sidebar, SidebarBody, SidebarLink, useSidebar } from './ui/sidebar'

const ROLE_LABEL: Record<string, string> = { system_admin: 'Administrator', hr_admin: 'HR administrator', payroll_admin: 'Payroll & finance', compliance_officer: 'Compliance', manager: 'Manager', employee: 'Employee' }
export const primaryRole = (roles: string[]) => ['system_admin', 'hr_admin', 'payroll_admin', 'compliance_officer', 'manager', 'employee'].find((r) => roles.includes(r)) ?? 'employee'

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
  const [navOpen, setNavOpen] = useState(false)
  const [tour, setTour] = useState(false)

  // Badge counts for the sidebar (approvals waiting for me), one light request
  const { data: counts } = useQuery({ queryKey: ['nav-counts'], queryFn: async () => (await api.get('/dashboard/counts')).data.data as { approvals: number; tasks: number; announcements?: number; policies?: number }, refetchInterval: 60000 })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) }
      if (e.key === 'Escape') setNavOpen(false)
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
  // Navigating closes the menus (adjusted during render, not in an effect)
  const [seenPath, setSeenPath] = useState(location.pathname)
  if (seenPath !== location.pathname) { setSeenPath(location.pathname); setNavOpen(false); setMenu(false) }

  const pageTitle = current ? labelFor(current, roles) : location.pathname.startsWith('/employees/') ? 'Employee profile' : ''
  useEffect(() => { document.title = `${pageTitle ? pageTitle + ' · ' : ''}${companyName}` }, [companyName, pageTitle])

  const startTour = () => { if (location.pathname !== '/dashboard') navigate('/dashboard'); setTimeout(() => setTour(true), 500) }
  const signOut = async () => { await logout(); navigate('/login') }

  // Page transition: the outlet rises in on every route change
  const main = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (main.current && !reduced()) gsap.fromTo(main.current, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.55, ease: 'power3.out', clearProps: 'transform,opacity' })
  }, [location.pathname])

  return (
    <div className="canvas shell">
      <a href="#main" style={s.skip} onFocus={(e) => (e.currentTarget.style.top = '8px')} onBlur={(e) => (e.currentTarget.style.top = '-60px')}>Skip to content</a>
      <div className="shell-side">
        <Sidebar open={navOpen} setOpen={setNavOpen}>
          <SidebarBody mobileStart={<CompanyLogo name={companyName} src={user?.tenant?.logoUrl} size={30} />}>
            <NavContent sections={sections} counts={counts} companyName={companyName} logoUrl={user?.tenant?.logoUrl} userName={user?.fullName || ''} avatarUrl={user?.avatarUrl} role={ROLE_LABEL[primaryRole(roles)]} />
          </SidebarBody>
        </Sidebar>
      </div>

      <div className="shell-main">
        <header style={s.bar}>
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

      <CommandPalette open={palette} onClose={() => setPalette(false)} onTour={startTour} />
      {tour && <ProductTour onClose={() => setTour(false)} />}
    </div>
  )
}

// What the sidebar shows: brand, the role-filtered sections from nav.ts with badges, and the signed-in person
function NavContent({ sections, counts, companyName, logoUrl, userName, avatarUrl, role }: {
  sections: ReturnType<typeof visibleSections>; counts?: { approvals: number; tasks: number; announcements?: number; policies?: number }
  companyName: string; logoUrl?: string | null; userName: string; avatarUrl?: string; role: string
}) {
  const { open } = useSidebar()
  const { pathname } = useLocation()
  const activePath = itemFor(pathname)?.path
  const badge = (path: string) => (path === '/approvals' ? counts?.approvals : path === '/activities' ? counts?.tasks : path === '/announcements' ? counts?.announcements : path === '/policies' ? counts?.policies : 0) || 0

  return (
    <>
      <div className="sb-top" data-tour="sidebar">
        <Link to="/dashboard" className="sb-brand" data-tour="brand" title={open ? undefined : companyName}>
          <CompanyLogo name={companyName} src={logoUrl} size={34} />
          {open && <span className="sb-brand-name">{companyName}</span>}
        </Link>
        <nav aria-label="Main navigation" className="sb-nav">
          {sections.map((sec) => (
            <div key={sec.key} className="sb-section">
              {sec.key !== 'home' && (open ? <div className="sb-section-label">{sec.label}</div> : <div className="sb-rule" />)}
              {sec.items.map((it) => {
                const on = it.path === activePath
                const n = badge(it.path)
                return (
                  <SidebarLink key={it.path} link={{ label: it.label, href: it.path, icon: <Icon name={it.icon} size={18} /> }}
                    data-tour={`nav-${it.path.replace(/\W+/g, '-').replace(/^-|-$/g, '')}`} aria-current={on ? 'page' : undefined} title={open ? undefined : it.label}>
                    {open && it.soon && <span className="pill honey" style={{ height: 18, fontSize: 10 }}>Soon</span>}
                    {n > 0 && (open ? <span className="sb-count">{n}</span> : <span className="sb-dot" aria-label={`${n} pending`} />)}
                  </SidebarLink>
                )
              })}
            </div>
          ))}
        </nav>
      </div>
      <SidebarLink className="sb-user" link={{ label: userName, href: '/security', icon: <Avatar name={userName || '?'} src={avatarUrl} size={32} /> }} title={open ? role : `${userName} · ${role}`} />
    </>
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

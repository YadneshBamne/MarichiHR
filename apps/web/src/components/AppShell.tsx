import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import api from '../lib/api'
import { visibleSections, sectionFor } from '../lib/nav'
import { gsap, reduced } from '../lib/motion'
import Logo from './brand/Logo'
import { CompanyLogo } from './company/CompanyParts'
import Icon from './ui/Icon'
import Avatar from './ui/Avatar'
import Popover from './ui/Popover'
import NotificationBell from './NotificationBell'
import CommandPalette from './CommandPalette'
import ProductTour from './ProductTour'

export default function AppShell() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const roles = user?.roles?.map((r) => r.name) ?? []
  const apps = user?.tenant?.modules ?? []
  const sections = visibleSections(roles, apps)
  const companyName = user?.tenant?.name || 'MarichiHR'
  const current = sectionFor(location.pathname)
  const active = sections.find((s) => s.key === current?.key) ?? null
  const [palette, setPalette] = useState(false)
  const [menu, setMenu] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [tour, setTour] = useState(false)
  const isManager = roles.some((r) => ['manager', 'hr_admin', 'system_admin'].includes(r))

  const { data: pending = [] } = useQuery({
    queryKey: ['leave-pending-count'],
    queryFn: async () => (await api.get('/leave/requests/pending')).data.data ?? [],
    enabled: isManager && apps.includes('leave'),
    refetchInterval: 60000,
  })
  const pendingCount = Array.isArray(pending) ? pending.length : 0

  // ⌘K / Ctrl+K anywhere opens search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) }
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
  useEffect(() => { setMobileNav(false); setMenu(false) }, [location.pathname])

  // Browser tab shows the company, not just the product
  useEffect(() => { document.title = `${companyName} · MarichiHR` }, [companyName])

  const startTour = () => { if (location.pathname !== '/dashboard') navigate('/dashboard'); setTimeout(() => setTour(true), 500) }
  const signOut = async () => { await logout(); navigate('/login') }

  // Page transition: the outlet rises in on every route change
  const main = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (main.current && !reduced()) gsap.fromTo(main.current, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.55, ease: 'power3.out', clearProps: 'transform,opacity' })
  }, [location.pathname])

  return (
    <div className="canvas" style={{ padding: '18px clamp(12px, 2.4vw, 32px) 40px' }}>
      <a href="#main" style={s.skip} onFocus={(e) => (e.currentTarget.style.top = '8px')} onBlur={(e) => (e.currentTarget.style.top = '-60px')}>Skip to content</a>
      <header style={s.bar}>
        <Link to="/dashboard" aria-label={`${companyName} home`} style={s.logoPill} data-tour="brand">
          <CompanyLogo name={companyName} src={user?.tenant?.logoUrl} size={30} />
          <span className="brand-name" style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 500, letterSpacing: '-0.02em', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{companyName}</span>
        </Link>

        <button className="btn btn-ghost btn-icon mobile-only" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Icon name="grid" size={17} /></button>
        <SectionTabs sections={sections} activeKey={active?.key ?? null} pendingCount={pendingCount} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <button className="btn btn-ghost desktop-only" data-tour="search" onClick={() => setPalette(true)} style={{ gap: 10, paddingRight: 10, color: 'var(--dim)' }} aria-label="Search (Ctrl+K)">
            <Icon name="search" size={16} /> <span style={{ fontWeight: 400 }}>Search</span>
            <kbd style={s.kbd}>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd>
          </button>
          <button className="btn btn-ghost btn-icon mobile-only" aria-label="Search" onClick={() => setPalette(true)}><Icon name="search" size={17} /></button>
          <Link to="/settings" className="btn btn-ghost desktop-only" data-tour="settings" onMouseEnter={(e) => { if (!reduced()) gsap.to(e.currentTarget.querySelector('svg'), { rotation: '+=90', duration: 0.7, ease: 'back.out(1.4)' }) }}>
            <Icon name="settings" size={16} /> Settings
          </Link>
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
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>{roles.filter((r) => r !== 'employee').map((r) => <span key={r} className="pill mute" style={{ height: 20 }}>{r.replace(/_/g, ' ')}</span>)}</div>
                </div>
              </div>
              <nav style={{ padding: 8 }}>
                {user?.employee && <MenuLink to={`/employees/${user.employee.id}`} icon="user" label="My profile" />}
                <MenuLink to="/security" icon="lock" label="Security & two-factor" />
                <MenuLink to="/settings" icon="settings" label="Settings" />
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

      {active && active.items.length > 1 && <SubNav section={active} pendingCount={pendingCount} />}

      <main id="main" ref={main} tabIndex={-1} style={{ outline: 'none', marginTop: active && active.items.length > 1 ? 18 : 26 }}>
        <Outlet />
      </main>

      {mobileNav && <MobileNav sections={sections} onClose={() => setMobileNav(false)} />}
      <CommandPalette open={palette} onClose={() => setPalette(false)} onTour={startTour} />
      {tour && <ProductTour onClose={() => setTour(false)} />}
    </div>
  )
}

function SectionTabs({ sections, activeKey, pendingCount }: { sections: ReturnType<typeof visibleSections>; activeKey: string | null; pendingCount: number }) {
  const wrap = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLSpanElement>(null)
  const first = useRef(true)
  const navigate = useNavigate()

  // The dark pill glides to the active section, stretching a little on the way
  useLayoutEffect(() => {
    const move = () => {
      const btn = wrap.current?.querySelector<HTMLElement>(`[data-key="${activeKey}"]`)
      if (!pill.current) return
      if (!btn) { gsap.to(pill.current, { opacity: 0, duration: 0.2 }); return }
      const { offsetLeft: x, offsetWidth: w } = btn
      if (first.current || reduced()) gsap.set(pill.current, { x, width: w, opacity: 1 })
      else gsap.timeline().to(pill.current, { opacity: 1, scaleY: 0.86, duration: 0.18, ease: 'power2.out' }).to(pill.current, { x, width: w, duration: 0.6, ease: 'expo.out' }, 0).to(pill.current, { scaleY: 1, duration: 0.5, ease: 'elastic.out(1, .5)' }, 0.2)
      first.current = false
    }
    move()
    window.addEventListener('resize', move)
    return () => window.removeEventListener('resize', move)
  }, [activeKey, sections.length])

  return (
    <nav aria-label="Sections" ref={wrap} data-tour="sections" className="desktop-only" style={s.tabs}>
      <span ref={pill} aria-hidden="true" style={s.pill} />
      {sections.map((sec) => {
        const on = sec.key === activeKey
        const badge = sec.key === 'work' && pendingCount > 0
        return (
          <button key={sec.key} data-key={sec.key} data-tour={`section-${sec.key}`} aria-current={on ? 'page' : undefined} onClick={() => navigate(sec.items[0].path)}
            style={{ ...s.tab, color: on ? 'var(--night-ink)' : 'var(--dim)' }}>
            {sec.label}
            {badge && <span style={{ ...s.dot, background: on ? 'var(--honey)' : 'var(--danger)' }} aria-label={`${pendingCount} pending`} />}
          </button>
        )
      })}
    </nav>
  )
}

function SubNav({ section, pendingCount }: { section: ReturnType<typeof visibleSections>[number]; pendingCount: number }) {
  const { pathname } = useLocation()
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current && !reduced()) gsap.fromTo(ref.current.children, { opacity: 0, y: -8 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power3.out', stagger: 0.035, clearProps: 'opacity,transform' })
  }, [section.key])
  return (
    <div ref={ref} className="chips" data-tour="subnav" style={{ marginTop: 18 }} role="navigation" aria-label={`${section.label} pages`}>
      {section.items.map((it) => {
        const on = pathname === it.path || pathname.startsWith(it.path + '/')
        return (
          <Link key={it.path} to={it.path} className={`chip${on ? ' is-on' : ''}`} aria-current={on ? 'page' : undefined}>
            <Icon name={it.icon} size={14} /> {it.label}
            {it.soon && <span className="pill honey" style={{ height: 18, fontSize: 10, marginLeft: 2 }}>Soon</span>}
            {it.path === '/approvals' && pendingCount > 0 && <span className="n">{pendingCount}</span>}
          </Link>
        )
      })}
    </div>
  )
}

function MobileNav({ sections, onClose }: { sections: ReturnType<typeof visibleSections>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (ref.current && !reduced()) gsap.fromTo(ref.current, { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: 'power3.out' }) }, [])
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 800, background: 'rgba(37,37,35,.3)' }}>
      <div ref={ref} onClick={(e) => e.stopPropagation()} className="card scroll-y" role="dialog" aria-label="Navigation" style={{ position: 'absolute', inset: '10px auto 10px 10px', width: 'min(320px, 86vw)', background: 'var(--solid)', padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}><Logo size={20} /><button className="btn btn-ghost btn-icon" aria-label="Close navigation" onClick={onClose}><Icon name="x" size={16} /></button></div>
        {sections.map((sec) => (
          <div key={sec.key} style={{ marginBottom: 14 }}>
            <div className="muted" style={{ fontSize: 11, fontWeight: 500, margin: '8px 6px' }}>{sec.label}</div>
            {sec.items.map((it) => <MenuLink key={it.path} to={it.path} icon={it.icon} label={it.label} soon={!!it.soon} />)}
          </div>
        ))}
      </div>
    </div>
  )
}

function MenuLink({ to, icon, label, soon }: { to: string; icon: Parameters<typeof Icon>[0]['name']; label: string; soon?: boolean }) {
  return (
    <Link to={to} style={s.menuItem}>
      <Icon name={icon} size={16} /> <span style={{ flex: 1 }}>{label}</span>
      {soon && <span className="pill honey" style={{ height: 18, fontSize: 10 }}>Soon</span>}
    </Link>
  )
}

const s: Record<string, React.CSSProperties> = {
  skip: { position: 'fixed', left: 16, top: -60, zIndex: 1000, background: 'var(--night)', color: 'var(--night-ink)', padding: '8px 14px', borderRadius: 999, fontSize: 13, transition: 'top .2s' },
  bar: { display: 'flex', alignItems: 'center', gap: 12, position: 'relative', zIndex: 50 },
  logoPill: { display: 'inline-flex', alignItems: 'center', gap: 10, height: 44, padding: '0 18px 0 7px', borderRadius: 999, background: 'var(--card-2)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)' },
  tabs: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 2, padding: 5, borderRadius: 999, background: 'var(--card-2)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)' },
  pill: { position: 'absolute', left: 0, top: 5, bottom: 5, borderRadius: 999, background: 'var(--night)', opacity: 0, zIndex: 0 },
  tab: { position: 'relative', zIndex: 1, height: 34, padding: '0 16px', border: 'none', background: 'transparent', borderRadius: 999, fontSize: 13, fontWeight: 500, transition: 'color .35s var(--ease)', display: 'inline-flex', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: '50%' },
  kbd: { fontSize: 10.5, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--line-2)', color: 'var(--faint)', fontFamily: 'var(--font-body)' },
  avatarBtn: { border: 'none', background: 'none', padding: 0, borderRadius: '50%', display: 'inline-flex', boxShadow: '0 0 0 3px var(--card-2)' },
  menuItem: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 12, border: 'none', background: 'none', fontSize: 13, color: 'var(--ink)', textAlign: 'left' },
}

import { useEffect, useLayoutEffect, useRef } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { APPS } from '../../lib/apps'
import { gsap, reduced } from '../../lib/motion'
import Logo, { Mark } from '../../components/brand/Logo'
import Icon, { type IconName } from '../../components/ui/Icon'

// Public product page: what MarichiHR does, the apps, how a company gets started
export default function LandingPage() {
  const { isAuthenticated, isLoading } = useAuth()
  const root = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!root.current || reduced()) return
    const ctx = gsap.context(() => {
      gsap.fromTo('[data-hero]', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out', stagger: 0.08, clearProps: 'opacity,transform' })
      gsap.fromTo('[data-float]', { opacity: 0, y: 50, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 1.1, ease: 'power3.out', stagger: 0.12, delay: 0.3 })
      gsap.to('[data-float]', { y: (i) => (i % 2 ? 10 : -10), duration: 3.4, ease: 'sine.inOut', repeat: -1, yoyo: true, stagger: 0.5, delay: 1.5 })
      gsap.fromTo('[data-bar]', { scaleY: 0 }, { scaleY: 1, duration: 1, ease: 'back.out(1.6)', stagger: 0.06, delay: 0.9, transformOrigin: '50% 100%' })
      gsap.fromTo('[data-ring]', { strokeDashoffset: 100 }, { strokeDashoffset: 30, duration: 1.8, ease: 'power3.inOut', delay: 0.8 })
    }, root)
    return () => ctx.revert()
  }, [isAuthenticated])

  // Sections rise in as they scroll into view
  useEffect(() => {
    if (!root.current || reduced()) return
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (!e.isIntersecting) return
      io.unobserve(e.target)
      gsap.fromTo(e.target.querySelectorAll('[data-in]'), { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out', stagger: 0.07, clearProps: 'opacity,transform' })
    }), { threshold: 0.15 })
    root.current.querySelectorAll('[data-section]').forEach((s) => { s.querySelectorAll<HTMLElement>('[data-in]').forEach((el) => (el.style.opacity = '0')); io.observe(s) })
    return () => io.disconnect()
  }, [isAuthenticated])

  if (isLoading) return null
  if (isAuthenticated) return <Navigate to="/dashboard" replace />

  return (
    <div ref={root} className="canvas" style={{ minHeight: '100vh' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 20, padding: '14px clamp(14px, 3vw, 40px)', backdropFilter: 'blur(14px)', background: 'rgba(245,243,238,.7)', borderBottom: '1px solid var(--line)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 22 }}>
          <Link to="/" aria-label="MarichiHR home"><Logo size={22} /></Link>
          <nav className="desktop-only" style={{ display: 'flex', gap: 20, fontSize: 14 }} aria-label="Page sections">
            <a href="#apps" className="dim">Apps</a><a href="#how" className="dim">How it works</a><a href="#roles" className="dim">For every role</a><a href="#security" className="dim">Security</a>
          </nav>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Link to="/login" className="btn btn-ghost">Sign in</Link>
            <Link to="/signup" className="btn btn-primary">Get started</Link>
          </div>
        </div>
      </header>

      <main>
        {/* ─── Hero ─── */}
        <section className="landing-hero" style={{ maxWidth: 1200, margin: '0 auto', padding: 'clamp(40px, 7vw, 90px) clamp(14px, 3vw, 40px) 40px' }}>
          <div>
            <span data-hero className="pill honey" style={{ textTransform: 'none' }}>HR, time, leave and payroll in one place</span>
            <h1 data-hero style={{ fontSize: 'clamp(44px, 6.4vw, 84px)', lineHeight: 1, marginTop: 18 }}>People operations that run themselves.</h1>
            <p data-hero className="dim" style={{ fontSize: 'clamp(16px, 1.5vw, 19px)', marginTop: 20, lineHeight: 1.6, maxWidth: 520 }}>Create your company, switch on the apps you need, and give every manager and employee their own portal. Approvals, attendance and payroll talk to each other.</p>
            <div data-hero style={{ display: 'flex', gap: 10, marginTop: 30, flexWrap: 'wrap' }}>
              <Link to="/signup" className="btn btn-primary" style={{ height: 50, padding: '0 26px', fontSize: 15 }}>Set up your company <Icon name="arrowRight" size={16} /></Link>
              <a href="#how" className="btn btn-ghost" style={{ height: 50, padding: '0 22px', fontSize: 15 }}>See how it works</a>
            </div>
            <div data-hero className="muted" style={{ fontSize: 13, marginTop: 18, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Icon name="check" size={14} style={{ color: 'var(--ok)' }} /> Free to start</span>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Icon name="check" size={14} style={{ color: 'var(--ok)' }} /> Set up in minutes</span>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Icon name="check" size={14} style={{ color: 'var(--ok)' }} /> Two-factor and Google sign-in</span>
            </div>
          </div>
          <HeroCollage />
        </section>

        {/* ─── Apps ─── */}
        <section id="apps" data-section style={sec}>
          <h2 data-in style={h2}>Install only what you need</h2>
          <p data-in className="dim" style={lead}>Every workspace includes people, approvals, tasks and notifications. Add apps as you grow, remove them any time.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 'var(--gap)', marginTop: 32 }}>
            {APPS.map((a) => (
              <div key={a.key} data-in className="card lift" style={{ padding: 22 }}>
                <span style={{ width: 50, height: 50, borderRadius: 16, background: a.tint, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={a.icon} size={22} /></span>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, marginTop: 16 }}>{a.name}</div>
                <p className="dim" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>{a.tagline}</p>
              </div>
            ))}
            <div data-in className="card card-night" style={{ padding: 22 }}>
              <span style={{ width: 50, height: 50, borderRadius: 16, background: 'var(--night-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--honey)' }}><Icon name="sparkle" size={22} /></span>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, marginTop: 16 }}>Coming next</div>
              <p style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5, color: 'var(--night-dim)' }}>Tax & compliance, incentives, policies, grievances, forums and reports.</p>
            </div>
          </div>
        </section>

        {/* ─── How it works ─── */}
        <section id="how" data-section style={sec}>
          <h2 data-in style={h2}>From sign-up to first payroll</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--gap)', marginTop: 32 }}>
            {([
              ['Create your workspace', 'Your company name, logo, country, currency and time zone. You become the owner.', 'briefcase'],
              ['Pick your apps', 'Attendance, leave, payroll, expenses, exits: switch on what you need today.', 'grid'],
              ['Add your team', 'Add managers and employees, set their roles and hand them a temporary password.', 'users'],
              ['Everyone has a portal', 'Employees clock in and apply for leave, managers approve, HR and finance run payroll.', 'sparkle'],
            ] as [string, string, IconName][]).map(([t, b, ic], i) => (
              <div key={t} data-in className="card" style={{ padding: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="display" style={{ fontSize: 48, lineHeight: 1, color: 'var(--honey)' }}>{i + 1}</span>
                  <Icon name={ic} size={22} className="muted" />
                </div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, marginTop: 14 }}>{t}</div>
                <p className="dim" style={{ fontSize: 13.5, marginTop: 6, lineHeight: 1.55 }}>{b}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ─── Roles ─── */}
        <section id="roles" data-section style={sec}>
          <h2 data-in style={h2}>A portal for every role</h2>
          <p data-in className="dim" style={lead}>The same workspace, shaped to what each person needs to do.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--gap)', marginTop: 32 }}>
            {([
              ['Owners & HR', 'Company settings, apps, people and their logins, leave policy, payroll sign-off.', ['Add people and set roles', 'Issue and reset logins', 'Configure leave and pay'], 'shield'],
              ['Managers', 'An approvals inbox, the team calendar and who is in today.', ['Approve leave and corrections', 'See team attendance', 'Track tasks and follow-ups'], 'users'],
              ['Employees', 'Clock in, apply for leave, claim expenses and download payslips.', ['One-tap clock in', 'Leave balances at a glance', 'Payslips and claims'], 'user'],
            ] as [string, string, string[], IconName][]).map(([t, b, pts, ic], i) => (
              <div key={t} data-in className={`card${i === 0 ? ' card-night' : ''}`} style={{ padding: 26 }}>
                <span style={{ width: 46, height: 46, borderRadius: '50%', background: i === 0 ? 'var(--honey)' : 'var(--well)', color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={ic} size={20} /></span>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, marginTop: 16 }}>{t}</div>
                <p style={{ fontSize: 13.5, marginTop: 6, lineHeight: 1.55, color: i === 0 ? 'var(--night-dim)' : 'var(--dim)' }}>{b}</p>
                <ul style={{ listStyle: 'none', marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {pts.map((p) => <li key={p} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}><Icon name="check" size={14} style={{ color: i === 0 ? 'var(--honey)' : 'var(--ok)' }} /> {p}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* ─── Security ─── */}
        <section id="security" data-section style={sec}>
          <div className="card" style={{ padding: 'clamp(24px, 4vw, 48px)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 32, alignItems: 'center' }}>
            <div data-in>
              <h2 style={h2}>Built for sensitive data</h2>
              <p className="dim" style={{ ...lead, marginTop: 12 }}>Salaries, bank details and personal records are handled with care from the first day.</p>
            </div>
            <ul data-in style={{ listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              {([['lock', 'Two-factor sign-in'], ['key', 'Encrypted bank details'], ['shield', 'Role-based access'], ['audit', 'Audit trail'], ['globe', 'Google sign-in'], ['checkCircle', 'Maker-checker payroll']] as [IconName, string][]).map(([ic, t]) => (
                <li key={t} className="well" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', fontSize: 14 }}><Icon name={ic} size={17} /> {t}</li>
              ))}
            </ul>
          </div>
        </section>

        {/* ─── CTA ─── */}
        <section data-section style={{ ...sec, paddingBottom: 70 }}>
          <div data-in className="card card-night" style={{ padding: 'clamp(30px, 5vw, 60px)', textAlign: 'center', background: 'radial-gradient(700px 400px at 50% 120%, rgba(246,195,67,.35), transparent 70%), var(--night)' }}>
            <Mark size={40} />
            <h2 style={{ ...h2, color: 'var(--night-ink)', marginTop: 18 }}>Set up your company in minutes</h2>
            <p style={{ color: 'var(--night-dim)', marginTop: 10, fontSize: 16 }}>Create the workspace, choose apps, invite your team.</p>
            <Link to="/signup" className="btn btn-honey" style={{ height: 50, padding: '0 28px', fontSize: 15, marginTop: 26 }}>Get started <Icon name="arrowRight" size={16} /></Link>
          </div>
        </section>
      </main>

      <footer style={{ borderTop: '1px solid var(--line)', padding: '26px clamp(14px, 3vw, 40px)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 13 }} className="muted">
          <Logo size={18} /><span>© {new Date().getFullYear()} Marichi Labs</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 16 }}><Link to="/login">Sign in</Link><Link to="/signup">Create a workspace</Link></span>
        </div>
      </footer>
    </div>
  )
}

// Floating product widgets beside the headline
function HeroCollage() {
  const bars = [52, 74, 66, 28, 18, 84, 70]
  return (
    <div aria-hidden="true" style={{ position: 'relative', minHeight: 460 }}>
      <div data-float className="card" style={{ ...float, left: '4%', top: 0, width: 260, padding: 20 }}>
        <div className="dim" style={{ fontSize: 12 }}>Progress</div>
        <div className="display" style={{ fontSize: 34 }}>6.6 h</div>
        <div className="muted" style={{ fontSize: 11 }}>Avg. workday, last 7 days</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 9, height: 90, marginTop: 12 }}>
          {bars.map((h, i) => <span key={i} data-bar style={{ flex: 1, height: `${h}%`, borderRadius: 8, background: i === 6 ? 'var(--honey)' : 'var(--night)' }} />)}
        </div>
      </div>
      <div data-float className="card" style={{ ...float, right: 0, top: 30, width: 220, padding: 18, textAlign: 'center' }}>
        <svg width="150" height="150" viewBox="0 0 120 120"><circle cx="60" cy="60" r="46" fill="none" stroke="var(--well)" strokeWidth="11" /><circle data-ring cx="60" cy="60" r="46" fill="none" stroke="var(--honey)" strokeWidth="11" strokeLinecap="round" pathLength={100} strokeDasharray="100" strokeDashoffset="30" transform="rotate(-90 60 60)" /><text x="60" y="67" textAnchor="middle" fontFamily="Outfit" fontSize="22" fill="var(--ink)">07:12</text></svg>
        <div className="dim" style={{ fontSize: 12 }}>Clocked in · on time</div>
      </div>
      <div data-float className="card card-night" style={{ ...float, left: 0, bottom: 10, width: 300, padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span style={{ fontWeight: 500 }}>Onboarding tasks</span><span className="display" style={{ fontSize: 26 }}>2/5</span></div>
        {[['Sign the offer', true], ['Tax & bank forms', true], ['Laptop hand-off', false], ['Meet the team', false]].map(([t, d]) => (
          <div key={String(t)} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 13, opacity: d ? 0.6 : 1 }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', background: d ? 'var(--honey)' : 'var(--night-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink)' }}>{d && <Icon name="check" size={12} stroke={2.4} />}</span>
            <span style={{ textDecoration: d ? 'line-through' : 'none' }}>{String(t)}</span>
          </div>
        ))}
      </div>
      <div data-float style={{ ...float, right: '6%', bottom: 40, width: 250, padding: 16, borderRadius: 22, background: 'var(--honey)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ fontWeight: 500 }}>Leave approved</span><span className="display" style={{ fontSize: 22 }}>3 days</span></div>
        <div style={{ fontSize: 12, color: 'var(--honey-ink)', marginTop: 4 }}>Annual leave · approved by your manager</div>
      </div>
    </div>
  )
}

const sec: React.CSSProperties = { maxWidth: 1200, margin: '0 auto', padding: 'clamp(40px, 6vw, 80px) clamp(14px, 3vw, 40px) 0' }
const h2: React.CSSProperties = { fontSize: 'clamp(32px, 4.4vw, 54px)', lineHeight: 1.05 }
const lead: React.CSSProperties = { fontSize: 17, marginTop: 10, maxWidth: 640, lineHeight: 1.6 }
const float: React.CSSProperties = { position: 'absolute', boxShadow: '0 30px 60px -30px rgba(40,32,10,.5)' }

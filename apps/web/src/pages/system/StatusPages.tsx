import { Component, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { gsap, reduced } from '../../lib/motion'
import { ALL_ITEMS } from '../../lib/nav'
import Icon, { type IconName } from '../../components/ui/Icon'
import Logo from '../../components/brand/Logo'

// Big friendly status screen used by 404, 403, errors and offline
function Status({ code, title, body, icon, actions, framed }: { code?: string; title: string; body: ReactNode; icon: IconName; actions?: ReactNode; framed?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!ref.current || reduced()) return
    const ctx = gsap.context(() => {
      gsap.fromTo('[data-rise]', { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.6, stagger: 0.07, ease: 'power3.out', clearProps: 'opacity,transform' })
      gsap.fromTo('[data-orb]', { scale: 0.6, rotation: -20 }, { scale: 1, rotation: 0, duration: 1, ease: 'elastic.out(1, .5)' })
    }, ref)
    return () => ctx.revert()
  }, [])
  const inner = (
    <div ref={ref} style={{ textAlign: 'center', maxWidth: 520, margin: '0 auto', padding: '8vh 16px' }}>
      <div data-orb style={{ width: 96, height: 96, margin: '0 auto', borderRadius: '50%', background: 'var(--honey)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 20px 50px -20px rgba(180,130,10,.6)' }}><Icon name={icon} size={38} stroke={1.4} /></div>
      {code && <div data-rise className="display" style={{ fontSize: 'clamp(64px, 12vw, 120px)', lineHeight: 1, marginTop: 24, color: 'var(--ink)' }}>{code}</div>}
      <h1 data-rise style={{ fontSize: 30, marginTop: code ? 6 : 26 }}>{title}</h1>
      <div data-rise className="dim" style={{ marginTop: 10, lineHeight: 1.6 }}>{body}</div>
      <div data-rise style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 26, flexWrap: 'wrap' }}>{actions ?? <Link to="/dashboard" className="btn btn-primary"><Icon name="home" size={16} /> Back to dashboard</Link>}</div>
    </div>
  )
  if (!framed) return inner
  return <div className="canvas" style={{ minHeight: '100vh', padding: 28 }}><Logo size={22} />{inner}</div>
}

export function NotFoundPage({ framed }: { framed?: boolean }) {
  const { pathname } = useLocation()
  return <Status framed={framed} code="404" icon="compass" title="This page wandered off" body={<>Nothing lives at <code style={{ background: 'var(--well)', padding: '2px 8px', borderRadius: 8 }}>{pathname}</code>. Check the address, or search with <strong>Ctrl K</strong>.</>} />
}

export function ForbiddenPage() {
  return <Status code="403" icon="lock" title="You don't have access here" body="This area is limited to certain roles. If you think you need it, ask your HR administrator to update your access." />
}

export function ErrorPage({ onRetry }: { onRetry?: () => void }) {
  return (
    <Status framed icon="alert" title="Something went wrong" body="An unexpected error stopped this page from loading. Your data is safe. Try again, and if it keeps happening let your administrator know."
      actions={<><button className="btn btn-primary" onClick={() => (onRetry ? onRetry() : window.location.reload())}><Icon name="refresh" size={16} /> Try again</button><a href="/dashboard" className="btn btn-ghost">Go to dashboard</a></>} />
  )
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err: unknown) { console.error('Unhandled UI error:', err) }
  render() { return this.state.failed ? <ErrorPage onRetry={() => { this.setState({ failed: false }); window.location.reload() }} /> : this.props.children }
}

// Roadmap module preview: what it will do and when
export function ComingSoonPage() {
  const { slug } = useParams()
  const item = ALL_ITEMS.find((i) => i.path === `/soon/${slug}`)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!ref.current || reduced()) return
    const ctx = gsap.context(() => {
      gsap.fromTo('[data-rise]', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.55, stagger: 0.06, ease: 'power3.out', clearProps: 'opacity,transform' })
      gsap.fromTo('[data-feature]', { opacity: 0, x: -14 }, { opacity: 1, x: 0, duration: 0.45, stagger: 0.07, delay: 0.3, ease: 'power3.out', clearProps: 'opacity,transform' })
      gsap.to('[data-stripes]', { backgroundPositionX: 22, duration: 3.2, ease: 'none', repeat: -1 })
    }, ref)
    return () => ctx.revert()
  }, [slug])
  if (!item?.soon) return <NotFoundPage />
  const live = item.section.items.find((i) => !i.soon)
  return (
    <div ref={ref} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--gap)' }}>
      <section className="card" style={{ padding: 'clamp(24px, 3vw, 40px)' }}>
        <span data-rise className="pill honey">{item.soon.phase} · In development</span>
        <h1 data-rise style={{ fontSize: 'clamp(36px, 5vw, 56px)', marginTop: 18, lineHeight: 1.05 }}>{item.label}</h1>
        <p data-rise className="dim" style={{ fontSize: 16, marginTop: 12, lineHeight: 1.6, maxWidth: 520 }}>{item.soon.blurb}</p>
        <div data-rise style={{ marginTop: 26 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }} className="dim"><span>Build progress</span><span>Planned</span></div>
          <div data-stripes className="seg stripes" style={{ height: 14, padding: 0, backgroundSize: '22px 22px' }} />
        </div>
        <div data-rise style={{ display: 'flex', gap: 10, marginTop: 30, flexWrap: 'wrap' }}>
          <Link to="/dashboard" className="btn btn-primary"><Icon name="home" size={16} /> Back to dashboard</Link>
          {live && <Link to={live.path} className="btn btn-ghost">Open {live.label}</Link>}
        </div>
      </section>
      <section className="card card-night" style={{ padding: 'clamp(24px, 3vw, 40px)' }}>
        <div data-rise style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 46, height: 46, borderRadius: '50%', background: 'var(--honey)', color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={item.icon} size={22} /></span>
          <h2 style={{ fontSize: 22 }}>What's coming</h2>
        </div>
        <ul style={{ listStyle: 'none', marginTop: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {item.soon.features.map((f) => (
            <li key={f} data-feature style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '14px 16px', borderRadius: 18, background: 'var(--night-2)' }}>
              <span style={{ width: 24, height: 24, borderRadius: '50%', border: '1.5px solid var(--night-dim)', flexShrink: 0 }} />
              <span>{f}</span>
            </li>
          ))}
        </ul>
        <p data-rise style={{ color: 'var(--night-dim)', fontSize: 13, marginTop: 22, lineHeight: 1.6 }}>This module will plug into the people, leave and payroll data you already have, with the same access controls.</p>
      </section>
    </div>
  )
}

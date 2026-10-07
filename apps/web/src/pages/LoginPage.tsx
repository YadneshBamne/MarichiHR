import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { Link, useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { CompanyLogo } from '../components/company/CompanyParts'
import api from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { gsap, reduced } from '../lib/motion'
import Logo, { Mark } from '../components/brand/Logo'
import Icon from '../components/ui/Icon'

const API_URL = import.meta.env.MARICHI_API_URL || 'http://localhost:4000/api/v1'
const SSO_ERRORS: Record<string, string> = {
  no_account: 'That Google account is not linked to an active user in this organisation.',
  email_unverified: 'Your Google email address is not verified.',
  expired: 'The Google sign-in took too long. Please try again.',
  state_mismatch: 'The Google sign-in could not be verified. Please try again.',
  cancelled: 'Google sign-in was cancelled.',
  not_configured: 'Google sign-in is not configured.',
}
const LAST_ORG = 'marichihr.org'
const readOrg = () => { try { return localStorage.getItem(LAST_ORG) || '' } catch { return '' } }

type Mode = 'signin' | 'mfa' | 'forgot'

export default function LoginPage() {
  const { login, verifyMfa } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const initialMfa = (location.state as any)?.mfaToken ?? null
  const [mode, setMode] = useState<Mode>(initialMfa ? 'mfa' : 'signin')
  const [mfaToken, setMfaToken] = useState<string | null>(initialMfa)
  const [form, setForm] = useState({ email: '', password: '', tenantSlug: readOrg() })
  const [showPw, setShowPw] = useState(false)
  const [code, setCode] = useState('')
  const [google, setGoogle] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // The organisation is only needed when an email belongs to several companies (or for Google sign-in)
  const [showOrg, setShowOrg] = useState(!!form.tenantSlug)
  const [brand, setBrand] = useState<{ name: string; logoUrl: string | null } | null>(null)
  const formRef = useRef<HTMLDivElement>(null)
  const from = (location.state as any)?.from || '/dashboard'

  useEffect(() => {
    api.get('/auth/providers').then((r) => setGoogle(!!r.data.data.google)).catch(() => {})
    const e = params.get('sso_error')
    if (e) setError(SSO_ERRORS[e] || 'Google sign-in failed. Please try again.')
  }, [params])

  // A known workspace shows its own name and logo
  useEffect(() => {
    const slug = form.tenantSlug.trim().toLowerCase()
    if (!showOrg || slug.length < 2) { setBrand(null); return }
    const t = setTimeout(() => api.get(`/auth/workspace/${encodeURIComponent(slug)}`).then((r) => setBrand(r.data.data)).catch(() => setBrand(null)), 350)
    return () => clearTimeout(t)
  }, [form.tenantSlug, showOrg])

  // Each panel change slides the form content in
  useLayoutEffect(() => {
    if (formRef.current && !reduced()) gsap.fromTo(formRef.current.querySelectorAll('[data-rise]'), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.05, ease: 'power3.out', clearProps: 'opacity,transform' })
  }, [mode])

  const shake = () => { if (formRef.current && !reduced()) gsap.fromTo(formRef.current, { x: -8 }, { x: 0, duration: 0.5, ease: 'elastic.out(1.2, .3)' }) }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const org = showOrg ? form.tenantSlug.trim().toLowerCase() : ''
      const pending = await login(form.email.trim(), form.password, org || undefined)
      try { if (org) localStorage.setItem(LAST_ORG, org) } catch { /* private mode */ }
      if (pending) { setMfaToken(pending); setCode(''); setMode('mfa') }
      else navigate(from, { replace: true })
    } catch (err: any) {
      if (err?.response?.data?.code === 'ORG_REQUIRED') setShowOrg(true)
      setError(err?.response?.data?.message || (err?.response ? 'Sign-in failed. Check your details.' : 'Cannot reach the server. Check your connection.'))
      shake()
    } finally { setLoading(false) }
  }

  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await verifyMfa(mfaToken!, code)
      navigate(from, { replace: true })
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Verification failed.'
      setError(msg)
      setCode('')
      shake()
      if (err?.response?.status === 401 && /expired/i.test(msg)) { setMfaToken(null); setMode('signin') }
    } finally { setLoading(false) }
  }

  return (
    <div className="canvas login-grid" style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.1fr)', gap: 18, padding: 18 }}>
      <section style={{ display: 'flex', flexDirection: 'column', padding: 'clamp(20px, 4vw, 48px)' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Link to="/" aria-label="MarichiHR home"><Logo size={24} /></Link>
          <span className="dim" style={{ marginLeft: 'auto', fontSize: 13 }}>New here? <Link to="/signup" className="link">Create a workspace</Link></span>
        </div>
        <div ref={formRef} style={{ margin: 'auto 0', width: '100%', maxWidth: 400, alignSelf: 'center', paddingBlock: 32 }}>
          {mode === 'signin' && (
            <form onSubmit={submit} noValidate>
              {brand && <div data-rise style={{ marginBottom: 16 }}><CompanyLogo name={brand.name} src={brand.logoUrl} size={56} /></div>}
              <h1 data-rise style={{ fontSize: 'clamp(34px, 4vw, 46px)', lineHeight: 1.05 }}>{brand ? `Sign in to ${brand.name}` : 'Welcome back'}</h1>
              <p data-rise className="dim" style={{ marginTop: 10, marginBottom: 28 }}>Use the work email your company registered for you.</p>
              {showOrg && (
                <div data-rise className="field" style={{ marginBottom: 14 }}>
                  <label htmlFor="org">Organisation</label>
                  <input id="org" className="input" value={form.tenantSlug} onChange={(e) => setForm({ ...form, tenantSlug: e.target.value })} placeholder="your-company" autoComplete="organization" />
                </div>
              )}
              <div data-rise className="field" style={{ marginBottom: 14 }}>
                <label htmlFor="email">Work email</label>
                <input id="email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@company.com" autoComplete="username" autoFocus required />
              </div>
              <div data-rise className="field" style={{ marginBottom: 8 }}>
                <label htmlFor="pw">Password</label>
                <div style={{ position: 'relative' }}>
                  <input id="pw" className="input" type={showPw ? 'text' : 'password'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="current-password" required style={{ paddingRight: 64 }} />
                  <button type="button" className="link" onClick={() => setShowPw(!showPw)} style={{ position: 'absolute', right: 8, top: 10 }} aria-pressed={showPw}>{showPw ? 'Hide' : 'Show'}</button>
                </div>
              </div>
              <div data-rise style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
                {!showOrg && <button type="button" className="link" style={{ marginRight: 'auto' }} onClick={() => setShowOrg(true)}>Sign in to a specific organisation</button>}
                <button type="button" className="link" onClick={() => { setError(''); setMode('forgot') }}>Forgot password?</button>
              </div>
              {error && <div role="alert" style={errBox}><Icon name="alert" size={16} /> {error}</div>}
              <button data-rise className="btn btn-primary" type="submit" disabled={loading || !form.email || !form.password || (showOrg && !form.tenantSlug.trim())} style={{ width: '100%', height: 46 }}>
                {loading ? <span className="spinner" style={{ borderTopColor: 'var(--night-ink)' }} /> : <>Sign in <Icon name="arrowRight" size={16} /></>}
              </button>
              {google && (
                <>
                  <div data-rise style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0', fontSize: 12 }} className="muted"><span style={rule} />or<span style={rule} /></div>
                  <button data-rise type="button" className="btn btn-ghost" style={{ width: '100%', height: 46 }} 
                    onClick={() => {
                      const org = form.tenantSlug.trim().toLowerCase()
                      if (!showOrg || !org) { setShowOrg(true); setError('Enter your organisation to continue with Google.'); return }
                      try { localStorage.setItem(LAST_ORG, org) } catch { /* ignore */ }
                      window.location.href = `${API_URL}/auth/google?tenant=${encodeURIComponent(org)}`
                    }}>
                    <GoogleG /> Continue with Google
                  </button>
                </>
              )}
            </form>
          )}

          {mode === 'mfa' && (
            <form onSubmit={submitMfa}>
              <span data-rise style={{ ...iconBubble }}><Icon name="shield" size={22} /></span>
              <h1 data-rise style={{ fontSize: 38, marginTop: 18 }}>Two-step check</h1>
              <p data-rise className="dim" style={{ marginTop: 8, marginBottom: 26 }}>Enter the 6-digit code from your authenticator app.</p>
              <div data-rise><CodeInput value={code} onChange={setCode} /></div>
              {error && <div role="alert" style={{ ...errBox, marginTop: 16 }}><Icon name="alert" size={16} /> {error}</div>}
              <button data-rise className="btn btn-primary" type="submit" disabled={loading || code.length !== 6} style={{ width: '100%', height: 46, marginTop: 20 }}>
                {loading ? <span className="spinner" style={{ borderTopColor: 'var(--night-ink)' }} /> : 'Verify and sign in'}
              </button>
              <button data-rise type="button" className="link" style={{ display: 'block', margin: '16px auto 0' }} onClick={() => { setMfaToken(null); setMode('signin'); setError('') }}>Use a different account</button>
            </form>
          )}

          {mode === 'forgot' && (
            <div>
              <span data-rise style={iconBubble}><Icon name="key" size={22} /></span>
              <h1 data-rise style={{ fontSize: 38, marginTop: 18 }}>Reset your password</h1>
              <p data-rise className="dim" style={{ marginTop: 10, lineHeight: 1.6 }}>
                Self-service password reset by email is coming soon. Until then, your HR administrator can set a new password for you, or you can sign in with Google if your organisation uses it.
              </p>
              <button data-rise className="btn btn-primary" style={{ width: '100%', height: 46, marginTop: 26 }} onClick={() => setMode('signin')}><Icon name="chevronLeft" size={16} /> Back to sign in</button>
            </div>
          )}
        </div>
        <footer className="muted" style={{ fontSize: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span>© {new Date().getFullYear()} Marichi Labs</span>
          <span>Secured with encryption in transit and at rest</span>
        </footer>
      </section>
      <BrandPanel />
    </div>
  )
}

// Six boxes that behave like one code field: paste, backspace and arrow keys all work
function CodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const set = (i: number, ch: string) => {
    const digits = ch.replace(/\D/g, '')
    if (!digits) return
    const next = (value.slice(0, i) + digits + value.slice(i + digits.length)).slice(0, 6)
    onChange(next)
    refs.current[Math.min(i + digits.length, 5)]?.focus()
  }
  return (
    <div style={{ display: 'flex', gap: 8 }} role="group" aria-label="6-digit code">
      {Array.from({ length: 6 }, (_, i) => (
        <input key={i} ref={(el) => { refs.current[i] = el }} className="input" inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'} aria-label={`Digit ${i + 1}`}
          autoFocus={i === 0} value={value[i] ?? ''} maxLength={6}
          onChange={(e) => set(i, e.target.value)}
          onPaste={(e) => { e.preventDefault(); set(0, e.clipboardData.getData('text')) }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') { e.preventDefault(); onChange(value.slice(0, i) + value.slice(i + 1)); refs.current[Math.max(i - (value[i] ? 0 : 1), 0)]?.focus() }
            if (e.key === 'ArrowLeft') refs.current[i - 1]?.focus()
            if (e.key === 'ArrowRight') refs.current[i + 1]?.focus()
          }}
          style={{ height: 56, textAlign: 'center', fontSize: 22, fontFamily: 'var(--font-display)', padding: 0 }} />
      ))}
    </div>
  )
}

// Right-hand showcase: a dark panel with live-looking product widgets that drift and animate
export function BrandPanel() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!ref.current || reduced()) return
    const ctx = gsap.context(() => {
      gsap.fromTo('[data-float]', { opacity: 0, y: 40, scale: 0.95 }, { opacity: 1, y: 0, scale: 1, duration: 1, ease: 'power3.out', stagger: 0.12, delay: 0.2 })
      gsap.to('[data-float]', { y: (i) => (i % 2 ? 8 : -8), duration: 3.2, ease: 'sine.inOut', repeat: -1, yoyo: true, stagger: 0.4, delay: 1.2 })
      gsap.fromTo('[data-bar]', { scaleY: 0 }, { scaleY: 1, duration: 0.9, ease: 'back.out(1.6)', stagger: 0.06, delay: 0.7, transformOrigin: '50% 100%' })
      gsap.fromTo('[data-ring]', { strokeDashoffset: 100 }, { strokeDashoffset: 34, duration: 1.6, ease: 'power3.inOut', delay: 0.6 })
    }, ref)
    return () => ctx.revert()
  }, [])
  const bars = [62, 80, 74, 30, 22, 88, 70]
  return (
    <aside ref={ref} className="login-brand" aria-hidden="true" style={{ position: 'relative', borderRadius: 'var(--r-app)', background: 'radial-gradient(800px 500px at 90% 110%, rgba(246,195,67,.35), transparent 60%), var(--night)', color: 'var(--night-ink)', overflow: 'hidden', padding: 'clamp(28px, 4vw, 52px)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Mark size={26} /><span className="pill" style={{ background: 'var(--night-2)', color: 'var(--night-dim)' }}>People · Time · Pay</span></div>
      <h2 style={{ fontSize: 'clamp(30px, 3.4vw, 50px)', lineHeight: 1.08, marginTop: 28, maxWidth: 520 }}>The whole employee lifecycle, in one calm place.</h2>
      <p style={{ color: 'var(--night-dim)', marginTop: 14, maxWidth: 440, lineHeight: 1.6 }}>Hiring to payslip to farewell: leave, attendance, payroll, expenses and approvals that talk to each other.</p>
      <div style={{ position: 'relative', flex: 1, minHeight: 300, marginTop: 30 }}>
        <div data-float style={{ ...widget, left: 0, top: 10, width: 230 }}>
          <div style={{ fontSize: 13, color: 'var(--dim)' }}>Hours this week</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, color: 'var(--ink)' }}>38.5 h</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 70, marginTop: 8 }}>
            {bars.map((h, i) => <span key={i} data-bar style={{ flex: 1, height: `${h}%`, borderRadius: 6, background: i === 6 ? 'var(--honey)' : 'var(--night)' }} />)}
          </div>
        </div>
        <div data-float style={{ ...widget, right: 0, top: 0, width: 200, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <svg width="120" height="120" viewBox="0 0 120 120"><circle cx="60" cy="60" r="48" fill="none" stroke="var(--well)" strokeWidth="10" /><circle data-ring cx="60" cy="60" r="48" fill="none" stroke="var(--honey)" strokeWidth="10" strokeLinecap="round" pathLength={100} strokeDasharray="100" strokeDashoffset="34" transform="rotate(-90 60 60)" /><text x="60" y="66" textAnchor="middle" fontFamily="Outfit" fontSize="22" fill="var(--ink)">06:42</text></svg>
          <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 4 }}>Clocked in · on time</div>
        </div>
        <div data-float style={{ ...widget, left: '18%', bottom: 0, width: 300, background: 'var(--honey)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--ink)' }}>
            <span style={{ fontWeight: 500 }}>Leave approved</span><span style={{ fontFamily: 'var(--font-display)', fontSize: 22 }}>3 days</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--honey-ink)', marginTop: 4 }}>Annual leave · 12 – 14 Nov</div>
        </div>
      </div>
    </aside>
  )
}

function GoogleG() {
  return <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" /><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" /></svg>
}

const errBox: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-line)', borderRadius: 14, padding: '10px 14px', fontSize: 13, marginBottom: 16 }
const rule: React.CSSProperties = { flex: 1, height: 1, background: 'var(--line-2)' }
const iconBubble: React.CSSProperties = { width: 52, height: 52, borderRadius: '50%', background: 'var(--honey)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }
const widget: React.CSSProperties = { position: 'absolute', background: 'var(--solid)', borderRadius: 24, padding: 18, boxShadow: '0 30px 60px -30px rgba(0,0,0,.6)' }

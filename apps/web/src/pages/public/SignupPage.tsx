import { useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { gsap, reduced } from '../../lib/motion'
import { BrandPanel } from '../LoginPage'
import Logo from '../../components/brand/Logo'
import Icon from '../../components/ui/Icon'

const rules = (pw: string) => [
  { ok: pw.length >= 10, text: '10+ characters' },
  { ok: /[A-Za-z]/.test(pw), text: 'a letter' },
  { ok: /\d/.test(pw), text: 'a number' },
]

// Step 1 of getting started: create the company workspace and the owner's account
export default function SignupPage() {
  const { signup } = useAuth()
  const navigate = useNavigate()
  const [f, setF] = useState({ companyName: '', fullName: '', email: '', password: '' })
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLFormElement>(null)
  const pwOk = rules(f.password).every((r) => r.ok)
  useLayoutEffect(() => {
    if (ref.current && !reduced()) gsap.fromTo(ref.current.querySelectorAll('[data-rise]'), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.05, ease: 'power3.out', clearProps: 'opacity,transform' })
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signup({ companyName: f.companyName.trim(), fullName: f.fullName.trim(), email: f.email.trim(), password: f.password })
      navigate('/onboarding', { replace: true })
    } catch (err: any) {
      setError(err?.response?.data?.message || (err?.response ? 'Could not create your workspace.' : 'Cannot reach the server. Check your connection.'))
      if (ref.current && !reduced()) gsap.fromTo(ref.current, { x: -8 }, { x: 0, duration: 0.5, ease: 'elastic.out(1.2, .3)' })
    } finally { setLoading(false) }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })

  return (
    <div className="canvas login-grid" style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.1fr)', gap: 18, padding: 18 }}>
      <section style={{ display: 'flex', flexDirection: 'column', padding: 'clamp(20px, 4vw, 48px)' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Link to="/" aria-label="MarichiHR home"><Logo size={24} /></Link>
          <span className="dim" style={{ marginLeft: 'auto', fontSize: 13 }}>Have a workspace? <Link to="/login" className="link">Sign in</Link></span>
        </div>
        <form ref={ref} onSubmit={submit} noValidate style={{ margin: 'auto 0', width: '100%', maxWidth: 420, alignSelf: 'center', paddingBlock: 32 }}>
          <span data-rise className="pill honey" style={{ textTransform: 'none' }}>Free to start · no card needed</span>
          <h1 data-rise style={{ fontSize: 'clamp(34px, 4vw, 46px)', lineHeight: 1.05, marginTop: 14 }}>Set up your company</h1>
          <p data-rise className="dim" style={{ marginTop: 10, marginBottom: 26 }}>Create your workspace in a minute. Next you'll choose your apps and add your team.</p>
          <div data-rise className="field" style={{ marginBottom: 14 }}>
            <label htmlFor="co">Company name</label>
            <input id="co" className="input" value={f.companyName} onChange={set('companyName')} autoComplete="organization" autoFocus required maxLength={80} placeholder="Acme Works" />
          </div>
          <div data-rise className="field" style={{ marginBottom: 14 }}>
            <label htmlFor="nm">Your full name</label>
            <input id="nm" className="input" value={f.fullName} onChange={set('fullName')} autoComplete="name" required maxLength={80} />
          </div>
          <div data-rise className="field" style={{ marginBottom: 14 }}>
            <label htmlFor="em">Work email</label>
            <input id="em" className="input" type="email" value={f.email} onChange={set('email')} autoComplete="email" required placeholder="you@company.com" />
          </div>
          <div data-rise className="field" style={{ marginBottom: 8 }}>
            <label htmlFor="pw">Password</label>
            <div style={{ position: 'relative' }}>
              <input id="pw" className="input" type={show ? 'text' : 'password'} value={f.password} onChange={set('password')} autoComplete="new-password" required style={{ paddingRight: 64 }} aria-describedby="pw-rules" />
              <button type="button" className="link" onClick={() => setShow(!show)} style={{ position: 'absolute', right: 8, top: 10 }} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
            </div>
          </div>
          <div data-rise id="pw-rules" style={{ display: 'flex', gap: 12, fontSize: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            {rules(f.password).map((r) => <span key={r.text} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: r.ok ? 'var(--ok)' : 'var(--faint)', transition: 'color .3s' }}><Icon name={r.ok ? 'checkCircle' : 'info'} size={13} /> {r.text}</span>)}
          </div>
          {error && <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-line)', borderRadius: 14, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}><Icon name="alert" size={16} /> {error}</div>}
          <button data-rise className="btn btn-primary" type="submit" disabled={loading || !f.companyName.trim() || !f.fullName.trim() || !f.email || !pwOk} style={{ width: '100%', height: 46 }}>
            {loading ? <><span className="spinner" style={{ borderTopColor: 'var(--night-ink)' }} /> Creating your workspace…</> : <>Create workspace <Icon name="arrowRight" size={16} /></>}
          </button>
          <p data-rise className="muted" style={{ fontSize: 12, marginTop: 14, textAlign: 'center' }}>You'll be the owner and administrator of this workspace.</p>
        </form>
        <footer className="muted" style={{ fontSize: 12 }}>© {new Date().getFullYear()} MarichiHR</footer>
      </section>
      <BrandPanel />
    </div>
  )
}

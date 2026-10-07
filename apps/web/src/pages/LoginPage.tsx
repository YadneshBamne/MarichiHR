import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import api from '../lib/api'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api/v1'
const SSO_ERRORS: Record<string, string> = {
  no_account: 'That Google account is not linked to an active user in this organisation.',
  email_unverified: 'Your Google email address is not verified.',
  expired: 'The Google sign-in took too long. Please try again.',
  state_mismatch: 'The Google sign-in could not be verified. Please try again.',
  cancelled: 'Google sign-in was cancelled.',
  not_configured: 'Google sign-in is not configured.',
}
import { useAuth } from '../contexts/AuthContext'

export default function LoginPage() {
  const { login, verifyMfa } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [mfaToken, setMfaToken] = useState<string | null>((useLocation().state as any)?.mfaToken ?? null)
  const [code, setCode] = useState('')
  const [google, setGoogle] = useState(false)

  useEffect(() => {
    api.get('/auth/providers').then((r) => setGoogle(!!r.data.data.google)).catch(() => {})
    const e = params.get('sso_error')
    if (e) setError(SSO_ERRORS[e] || 'Google sign-in failed. Please try again.')
  }, [params])
  const [form, setForm] = useState({ email: '', password: '', tenantSlug: 'marichi-labs' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleMfa = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await verifyMfa(mfaToken!, code)
      navigate('/dashboard')
    } catch (err: any) {
      const status = err?.response?.status
      setError(err?.response?.data?.message || 'Verification failed.')
      setCode('')
      if (status === 401 && /expired/i.test(err?.response?.data?.message || '')) setMfaToken(null)
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const pending = await login(form.email, form.password, form.tenantSlug)
      if (pending) {
        setMfaToken(pending)
        setCode('')
      } else navigate('/dashboard')
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Login failed. Please check your credentials.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.logo}>
          <div style={styles.logoIcon}>MH</div>
          <h1 style={styles.logoText}>MarichiHR</h1>
        </div>
        <p style={styles.subtitle}>{mfaToken ? 'Enter the 6-digit code from your authenticator app' : 'Sign in to your account'}</p>

        {mfaToken ? (
          <form onSubmit={handleMfa} style={styles.form}>
            <div style={styles.field}>
              <label style={styles.label} htmlFor="mfa-code">Authentication code</label>
              <input id="mfa-code" style={{ ...styles.input, letterSpacing: '0.4em', fontSize: '18px', textAlign: 'center' }} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/D/g, ''))} />
            </div>
            {error && <div style={styles.error}>{error}</div>}
            <button style={{ ...styles.button, opacity: loading || code.length !== 6 ? 0.7 : 1 }} type="submit" disabled={loading || code.length !== 6}>
              {loading ? 'Verifying...' : 'Verify'}
            </button>
            <button type="button" style={styles.textBtn} onClick={() => { setMfaToken(null); setError('') }}>Back to sign in</button>
          </form>
        ) : (
        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>Organisation</label>
            <input
              style={styles.input}
              value={form.tenantSlug}
              onChange={(e) => setForm({ ...form, tenantSlug: e.target.value })}
              placeholder="your-company-slug"
              required
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Email address</label>
            <input
              style={styles.input}
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="you@company.com"
              required
              autoFocus
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Password</label>
            <input
              style={styles.input}
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="••••••••"
              required
            />
          </div>

          {error && <div style={styles.error}>{error}</div>}

          <button style={{ ...styles.button, opacity: loading ? 0.7 : 1 }} type="submit" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
          {google && (
            <>
              <div style={styles.divider}><span>or</span></div>
              <button type="button" style={styles.googleBtn} disabled={!form.tenantSlug} onClick={() => { window.location.href = `${API_URL}/auth/google?tenant=${encodeURIComponent(form.tenantSlug)}` }}>
                Continue with Google
              </button>
            </>
          )}
        </form>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f4f0',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: '12px',
    border: '0.5px solid #e2e0da',
    padding: '40px',
    width: '100%',
    maxWidth: '400px',
    boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
  },
  logo: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' },
  logoIcon: {
    width: '36px', height: '36px', borderRadius: '8px',
    backgroundColor: '#534AB7', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '13px', fontWeight: '600',
  },
  logoText: { fontSize: '20px', fontWeight: '500', margin: 0, color: '#1a1a18' },
  subtitle: { color: '#5c5c58', fontSize: '14px', marginBottom: '28px', marginTop: '4px' },
  form: { display: 'flex', flexDirection: 'column', gap: '16px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: '13px', fontWeight: '500', color: '#1a1a18' },
  input: {
    padding: '10px 12px', borderRadius: '6px',
    border: '0.5px solid #ccc9c1', fontSize: '14px',
    outline: 'none', color: '#1a1a18',
    backgroundColor: '#fff',
  },
  error: {
    backgroundColor: '#faece7', color: '#993C1D',
    border: '0.5px solid #f5c6b8', borderRadius: '6px',
    padding: '10px 12px', fontSize: '13px',
  },
  textBtn: { background: 'none', border: 'none', color: '#534AB7', fontSize: '13px', cursor: 'pointer' },
  divider: { textAlign: 'center', fontSize: '12px', color: '#8c8c88' },
  googleBtn: { padding: '10px', borderRadius: '6px', backgroundColor: '#fff', color: '#1a1a18', border: '0.5px solid #ccc9c1', fontSize: '14px', cursor: 'pointer' },
  button: {
    padding: '11px', borderRadius: '6px',
    backgroundColor: '#534AB7', color: '#fff',
    border: 'none', fontSize: '14px', fontWeight: '500',
    cursor: 'pointer', marginTop: '4px',
  },
}

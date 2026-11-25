import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import api from '../../lib/api'
import { useToast } from '../../components/ui/Toast'
import Icon from '../../components/ui/Icon'

// The page a reset or welcome email opens: choose a new password with the one-time link
export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const navigate = useNavigate()
  const toast = useToast()
  const [who, setWho] = useState<{ email: string; name: string; company: string; welcome: boolean } | null>(null)
  const [bad, setBad] = useState(!token)
  const [f, setF] = useState({ next: '', confirm: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const ok = f.next.length >= 10 && /[A-Za-z]/.test(f.next) && /\d/.test(f.next)

  useEffect(() => {
    if (!token) return
    api.post('/auth/reset-password/check', { token }).then((r) => setWho(r.data.data)).catch(() => setBad(true))
  }, [token])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (f.next !== f.confirm) return setError('The two passwords do not match')
    setError(''); setLoading(true)
    try {
      await api.post('/auth/reset-password', { token, newPassword: f.next })
      toast(who?.welcome ? 'Password set. Sign in to get started.' : 'Password changed. Sign in with the new one.')
      navigate('/login', { replace: true })
    } catch (err: any) {
      if (err?.response?.data?.code === 'RESET_LINK_INVALID') setBad(true)
      else setError(err?.response?.data?.message || 'Could not set the password')
    } finally { setLoading(false) }
  }

  return (
    <div className="canvas" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}>
      <div className="card" style={{ width: 'min(440px, 100%)', padding: 30 }}>
        {bad ? (
          <>
            <h1 style={{ fontSize: 32 }}>This link no longer works</h1>
            <p className="dim" style={{ marginTop: 10, lineHeight: 1.6 }}>It has expired or was already used. Links work once. Ask for a new one from the sign-in page.</p>
            <Link to="/login" className="btn btn-primary" style={{ width: '100%', height: 46, marginTop: 24 }}>Back to sign in</Link>
          </>
        ) : !who ? <div className="skeleton" style={{ height: 220, borderRadius: 18 }} /> : (
          <form onSubmit={submit}>
            <h1 style={{ fontSize: 32 }}>{who.welcome ? 'Choose your password' : 'Choose a new password'}</h1>
            <p className="dim" style={{ marginTop: 6, marginBottom: 22, lineHeight: 1.5 }}>{who.welcome ? `Welcome to ${who.company}. ` : ''}You will sign in as <strong>{who.email}</strong>.</p>
            <div className="field" style={{ marginBottom: 12 }}><label htmlFor="rp-new">New password</label><input id="rp-new" className="input" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoFocus required /></div>
            <div className="field" style={{ marginBottom: 8 }}><label htmlFor="rp-conf">Repeat new password</label><input id="rp-conf" className="input" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required /></div>
            <p className="muted" style={{ fontSize: 12, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name={ok ? 'checkCircle' : 'info'} size={13} style={{ color: ok ? 'var(--ok)' : undefined }} /> At least 10 characters with a letter and a number</p>
            {error && <div role="alert" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 14, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}>{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={loading || !ok || !f.confirm} style={{ width: '100%', height: 46 }}>{loading ? 'Saving…' : 'Save password'}</button>
          </form>
        )}
      </div>
    </div>
  )
}

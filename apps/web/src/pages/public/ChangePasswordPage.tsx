import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useToast } from '../../components/ui/Toast'
import { CompanyLogo } from '../../components/company/CompanyParts'
import Icon from '../../components/ui/Icon'

// First sign-in with an HR-issued temporary password: choose your own before anything else
export default function ChangePasswordPage() {
  const { user, changePassword, logout } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [f, setF] = useState({ current: '', next: '', confirm: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const ok = f.next.length >= 10 && /[A-Za-z]/.test(f.next) && /\d/.test(f.next)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (f.next !== f.confirm) return setError('The two new passwords do not match')
    setError('')
    setLoading(true)
    try {
      await changePassword(f.current, f.next)
      toast('Password set. Welcome aboard!')
      navigate('/dashboard', { replace: true })
    } catch (err: any) { setError(err?.response?.data?.message || 'Could not change the password') } finally { setLoading(false) }
  }
  return (
    <div className="canvas" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}>
      <form onSubmit={submit} className="card" style={{ width: 'min(440px, 100%)', padding: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <CompanyLogo name={user?.tenant?.name || ''} src={user?.tenant?.logoUrl} size={38} />
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>{user?.tenant?.name}</span>
        </div>
        <h1 style={{ fontSize: 32, marginTop: 22 }}>Choose your password</h1>
        <p className="dim" style={{ marginTop: 6, marginBottom: 22, lineHeight: 1.5 }}>Hi {user?.fullName?.split(' ')[0]}, you signed in with a temporary password from your administrator. Set your own to continue.</p>
        <div className="field" style={{ marginBottom: 12 }}><label htmlFor="cur">Temporary password</label><input id="cur" className="input" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoFocus required /></div>
        <div className="field" style={{ marginBottom: 12 }}><label htmlFor="new">New password</label><input id="new" className="input" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required /></div>
        <div className="field" style={{ marginBottom: 8 }}><label htmlFor="conf">Repeat new password</label><input id="conf" className="input" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required /></div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name={ok ? 'checkCircle' : 'info'} size={13} style={{ color: ok ? 'var(--ok)' : undefined }} /> At least 10 characters with a letter and a number</p>
        {error && <div role="alert" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 14, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}>{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={loading || !f.current || !ok || !f.confirm} style={{ width: '100%', height: 46 }}>{loading ? 'Saving…' : 'Set password and continue'}</button>
        <button type="button" className="link" style={{ display: 'block', margin: '14px auto 0' }} onClick={() => logout().then(() => navigate('/login'))}>Sign out</button>
      </form>
    </div>
  )
}

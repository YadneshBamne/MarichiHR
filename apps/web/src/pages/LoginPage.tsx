import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({ email: '', password: '', tenantSlug: 'marichi-labs' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(form.email, form.password, form.tenantSlug)
      navigate('/dashboard')
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
        <p style={styles.subtitle}>Sign in to your account</p>

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
        </form>
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
  button: {
    padding: '11px', borderRadius: '6px',
    backgroundColor: '#534AB7', color: '#fff',
    border: 'none', fontSize: '14px', fontWeight: '500',
    cursor: 'pointer', marginTop: '4px',
  },
}

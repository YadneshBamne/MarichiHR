import { useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

// Google redirects back via the API with a one-time code; trade it for a session (or the MFA step)
export default function SsoCallbackPage() {
  const { exchangeSso } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    exchangeSso(params.get('code') || '')
      .then((mfaToken) => (mfaToken ? navigate('/login', { replace: true, state: { mfaToken } }) : navigate('/dashboard', { replace: true })))
      .catch(() => navigate('/login?sso_error=expired', { replace: true }))
  }, [exchangeSso, navigate, params])

  return <div style={{ padding: 40, textAlign: 'center', fontSize: 14, color: 'var(--dim)' }}>Signing you in...</div>
}

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import api from '../lib/api'
import { errMsg } from '../lib/hooks/useSalary'
import { inputStyle } from '../components/ui/FormField'
import { card, primaryBtn, ghostBtn, errorBox } from './salary/styles'

// Two-factor sign-in with any authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, ...)
export default function SecurityPage() {
  const qc = useQueryClient()
  const { data: me } = useQuery({ queryKey: ['auth-me'], queryFn: async () => (await api.get('/auth/me')).data.data })
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    setQr(null)
    if (setup) QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 304, color: { dark: '#252523', light: '#ffffff' } }).then(setQr).catch(() => setQr(null))
  }, [setup])
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const run = async (fn: () => Promise<void>) => {
    setError('')
    setMessage('')
    setBusy(true)
    try { await fn() } catch (err) { setError(errMsg(err)) } finally { setBusy(false) }
  }
  const start = () => run(async () => { setSetup((await api.post('/auth/mfa/setup')).data.data); setCode('') })
  const enable = () => run(async () => {
    await api.post('/auth/mfa/enable', { code })
    setSetup(null)
    setCode('')
    setMessage('Two-factor authentication is on. You will be asked for a code each time you sign in.')
    qc.invalidateQueries({ queryKey: ['auth-me'] })
  })
  const disable = () => run(async () => {
    await api.post('/auth/mfa/disable', { code })
    setCode('')
    setMessage('Two-factor authentication is off.')
    qc.invalidateQueries({ queryKey: ['auth-me'] })
  })

  const codeInput = (
    <input
      style={{ ...inputStyle, width: 140, letterSpacing: '0.3em', fontVariantNumeric: 'tabular-nums' }}
      inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" aria-label="6-digit code"
      value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
    />
  )

  return (
    <div>
      <h2 style={{ fontSize: 'clamp(32px, 4vw, 46px)', fontFamily: 'var(--font-display)', fontWeight: 400, letterSpacing: '-0.02em', margin: 0 }}>Security</h2>
      <p style={{ fontSize: 13, color: 'var(--faint)', marginTop: 2, marginBottom: 20 }}>Protect your account with a second step at sign-in.</p>
      <div style={{ ...card, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <strong style={{ fontSize: 14, fontWeight: 500 }}>Two-factor authentication</strong>
          <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 'var(--r-card)', backgroundColor: me?.mfaEnabled ? 'var(--ok-bg)' : 'var(--well)', color: me?.mfaEnabled ? 'var(--ok)' : 'var(--dim)' }}>
            {me?.mfaEnabled ? 'On' : 'Off'}
          </span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--dim)', margin: '0 0 16px' }}>Use an authenticator app to generate a 6-digit code that changes every 30 seconds.</p>

        {me?.mfaEnabled ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {codeInput}
            <button style={ghostBtn} disabled={code.length !== 6 || busy} onClick={disable}>Turn off</button>
          </div>
        ) : !setup ? (
          <button style={primaryBtn} disabled={busy} onClick={start}>Set up two-factor authentication</button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              {/* QR of the otpauth:// link, drawn in the browser (the secret never leaves this page) */}
              {qr && <img src={qr} alt="QR code to add MarichiHR to your authenticator app" width={168} height={168} style={{ borderRadius: 14, background: '#fff', padding: 8, border: '1px solid var(--line)', flexShrink: 0 }} />}
              <ol style={{ fontSize: 13, color: 'var(--ink)', margin: 0, paddingLeft: 18, lineHeight: 1.7, flex: '1 1 220px', minWidth: 0 }}>
                <li>Open your authenticator app (Google Authenticator, Microsoft Authenticator…) and scan this QR code.</li>
                <li>Can't scan? Choose "Enter a setup key" and type: <code style={{ fontSize: 13, backgroundColor: 'var(--well)', padding: '2px 6px', borderRadius: 4, wordBreak: 'break-all' }}>{setup.secret.match(/.{1,4}/g)!.join(' ')}</code> (time-based)</li>
                <li>Type the 6-digit code the app shows.</li>
              </ol>
            </div>
            <a href={setup.otpauthUrl} style={{ fontSize: 12, color: 'var(--brand)' }}>On this phone? Open in authenticator app</a>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {codeInput}
              <button style={primaryBtn} disabled={code.length !== 6 || busy} onClick={enable}>Verify and turn on</button>
              <button style={ghostBtn} onClick={() => setSetup(null)}>Cancel</button>
            </div>
          </div>
        )}
        {message && <div style={{ marginTop: 12, fontSize: 13, color: 'var(--ok)' }}>{message}</div>}
        {error && <div style={errorBox}>{error}</div>}
      </div>
    </div>
  )
}

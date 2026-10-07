import { useEffect, useRef, useState } from 'react'

// Google's own "Sign in with Google" button (Google Identity Services). For someone already signed in to Google it
// shows their account ("Continue as Mahi") so it's one click; the signed ID token goes to onCredential and the API
// verifies it. If Google's script can't load (blocked, offline, origin not allowed yet) the fallback is shown instead.
const GIS_SRC = 'https://accounts.google.com/gsi/client'
let gisLoad: Promise<any> | null = null
function loadGis(): Promise<any> {
  gisLoad ??= new Promise((resolve, reject) => {
    const w = window as any
    if (w.google?.accounts?.id) return resolve(w.google)
    const s = document.createElement('script')
    s.src = GIS_SRC
    s.async = true
    s.onload = () => (w.google?.accounts?.id ? resolve(w.google) : reject(new Error('gis')))
    s.onerror = () => { gisLoad = null; reject(new Error('gis')) }
    document.head.appendChild(s)
  })
  return gisLoad
}

export default function GoogleButton({ clientId, text = 'continue_with', onCredential, fallback }: {
  clientId: string
  text?: 'continue_with' | 'signup_with' | 'signin_with'
  onCredential: (credential: string) => void
  fallback: React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const cb = useRef(onCredential)
  cb.current = onCredential
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => live && setFailed(true), 6000)
    loadGis()
      .then((google) => {
        if (!live || !box.current) return
        google.accounts.id.initialize({ client_id: clientId, callback: (r: { credential: string }) => cb.current(r.credential), ux_mode: 'popup', itp_support: true })
        google.accounts.id.renderButton(box.current, {
          type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text, logo_alignment: 'center',
          width: Math.min(400, Math.max(220, box.current.offsetWidth)),
        })
        clearTimeout(timer)
      })
      .catch(() => live && setFailed(true))
    return () => { live = false; clearTimeout(timer) }
  }, [clientId, text])

  if (failed) return <>{fallback}</>
  return <div ref={box} style={{ width: '100%', minHeight: 44, display: 'flex', justifyContent: 'center' }} />
}

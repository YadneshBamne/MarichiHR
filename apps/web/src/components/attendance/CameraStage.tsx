import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { loadFace } from '../../lib/face'

// The camera, started once and stopped when the screen goes away. 'blocked' = the person (or the browser) said no, 'none' = no camera at all.
export function useCamera() {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const alive = useRef(true)
  const [state, setState] = useState<'starting' | 'on' | 'blocked' | 'none'>('starting')
  const start = useCallback(() => {
    setState('starting')
    if (!navigator.mediaDevices?.getUserMedia) return setState('none')
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640 }, audio: false })
      .then((s) => {
        if (!alive.current) { s.getTracks().forEach((t) => t.stop()); return }
        stream.current?.getTracks().forEach((t) => t.stop())
        stream.current = s
        if (video.current) video.current.srcObject = s
        setState('on')
      })
      .catch((e) => alive.current && setState(e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'none' : 'blocked'))
  }, [])
  useEffect(() => { alive.current = true; start(); return () => { alive.current = false; stream.current?.getTracks().forEach((t) => t.stop()) } }, [start])
  useEffect(() => { if (state === 'on' && video.current && stream.current) video.current.srcObject = stream.current }, [state])
  return { video, stream, state, retry: start }
}

// Loads the face models while the screen is open ('failed' = this browser could not run them)
export function useFaceModels(on: boolean) {
  const [st, setSt] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  useEffect(() => {
    if (!on) return
    let live = true
    setSt('loading')
    loadFace().then(() => live && setSt('ready')).catch(() => live && setSt('failed'))
    return () => { live = false }
  }, [on])
  return st
}

const RING = { idle: '#ffffff', ok: '#4ade80', warn: '#f6c343' }
// The picture area: live camera (mirrored) or a still, with an oval to line the face up in and one line of instructions underneath
export function CameraStage({ video, still, tone = 'idle', caption, children }: { video: React.RefObject<HTMLVideoElement | null>; still?: string | null; tone?: 'idle' | 'ok' | 'warn'; caption?: string; children?: ReactNode }) {
  return (
    <div style={{ position: 'relative', borderRadius: 18, overflow: 'hidden', background: '#1b1b1a', aspectRatio: '4 / 3', width: '100%' }}>
      {still && <img src={still} alt="Your photo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
      {/* kept mounted behind a still so Retake does not have to restart the camera */}
      <video ref={video} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', display: still ? 'none' : 'block' }} />
      <svg viewBox="0 0 100 75" preserveAspectRatio="none" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <path d="M0 0h100v75H0z M23 37.5a27 30 0 1 0 54 0a27 30 0 1 0 -54 0z" fill="rgba(20,20,19,0.5)" fillRule="evenodd" />
        <ellipse cx="50" cy="37.5" rx="27" ry="30" fill="none" stroke={RING[tone]} strokeWidth="0.9" />
      </svg>
      {caption && <div role="status" style={{ position: 'absolute', left: 10, right: 10, bottom: 10, padding: '8px 12px', borderRadius: 12, background: 'rgba(20,20,19,0.72)', color: '#fff', fontSize: 15, fontWeight: 500, textAlign: 'center' }}>{caption}</div>}
      {children}
    </div>
  )
}

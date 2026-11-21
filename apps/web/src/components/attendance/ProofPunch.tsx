import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Icon from '../ui/Icon'
import { CameraStage, useCamera, useFaceModels } from './CameraStage'
import { deviceKind, grab, isVirtualCamera, readFace, readable, toBlob, turnChallenge, waitForFace } from '../../lib/face'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
type Liveness = 'passed' | 'failed' | 'skipped'
export type ProofSettings = { enabled: boolean; requireProof: boolean; requireSelfie: boolean; requireLocation: boolean; maxAccuracyMeters: number; faceMatching: boolean; livenessChallenge: boolean; locationRule: 'all' | 'mobile_only'; enrolment: { status: string; note: string | null; samples: number } | null; storageReady: boolean }
const WHY: Record<string, string> = {
  outside_fence: 'You were outside the office area.', low_accuracy: 'Your location was not precise.', face_mismatch: 'Your face did not match your registered face.',
  face_not_checked: 'Your face could not be checked.', liveness_failed: 'The head turn was not detected.', virtual_camera: 'A virtual camera was used.',
}
const useNarrow = () => {
  const [n, setN] = useState(() => window.matchMedia('(max-width: 600px)').matches)
  useEffect(() => { const m = window.matchMedia('(max-width: 600px)'); const f = () => setN(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])
  return n
}

// Clock in or out with proof from any device with a camera, one clear step at a time: the camera opens with an oval to line your face up in;
// if your face is registered it waits until it sees you (and asks you to turn your head if HR wants that), takes the picture by itself, you
// look at it and press Clock in, and the last screen says plainly what happened. Face matching only ever flags a punch; it never stops one.
export default function ProofPunch({ type, settings, onClose }: { type: 'in' | 'out'; settings: ProofSettings; onClose: () => void }) {
  const qc = useQueryClient()
  const cam = useCamera()
  const narrow = useNarrow()
  const [device] = useState(deviceKind)
  const approved = settings.enrolment?.status === 'approved'
  const faceFlow = settings.faceMatching && approved
  const models = useFaceModels(faceFlow)
  const skipLoc = device === 'desktop' && settings.locationRule === 'mobile_only'
  const [step, setStep] = useState<'capture' | 'review' | 'sending' | 'done'>('capture')
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [face, setFace] = useState<number[] | null>(null)
  const [liveness, setLiveness] = useState<Liveness>('skipped')
  const [caption, setCaption] = useState('')
  const [tone, setTone] = useState<'idle' | 'ok' | 'warn'>('idle')
  const [turns, setTurns] = useState({ a: false, b: false })
  const [turning, setTurning] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [pos, setPos] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null)
  const [loc, setLoc] = useState<'finding' | 'ok' | 'error'>('finding')
  const [error, setError] = useState('')
  const [result, setResult] = useState<any>(null)

  const askLocation = useCallback(() => {
    if (skipLoc) return
    if (!navigator.geolocation) return setLoc('error')
    setLoc('finding')
    navigator.geolocation.getCurrentPosition((p) => { setPos({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }); setLoc('ok') }, () => setLoc('error'), { enableHighAccuracy: true, timeout: 12000 })
  }, [skipLoc])
  useEffect(() => { askLocation() }, [askLocation])
  // The settings are cached for a couple of minutes; HR may have approved this person's face since, so look again every time the screen opens
  useEffect(() => { qc.invalidateQueries({ queryKey: ['geomark-settings'] }) }, [qc])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && step !== 'sending') onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [step, onClose])

  const show = (b: Blob, emb: number[] | null, lv: Liveness) => {
    setPhoto(b); setPreview(URL.createObjectURL(b)); setFace(emb); setLiveness(lv); setTurning(false)
    setTone(faceFlow && (!emb || lv === 'failed') ? 'warn' : 'ok')
    setCaption(!faceFlow ? 'Happy with this photo?' : !emb ? 'We could not read your face in this photo. A manager may take a look.' : lv === 'failed' ? 'The head turn was not detected. Retake it, or clock in and a manager will take a look.' : 'Looks good. Press Clock in.')
    setStep('review')
  }
  // Registered face: wait until the face is seen, ask for the head turn if HR wants it, then take the picture and read the face
  useEffect(() => {
    if (step !== 'capture' || !faceFlow || cam.state !== 'on' || models !== 'ready' || !cam.video.current) return
    const stop = { stop: false }
    const v = cam.video.current
    ;(async () => {
      setTrouble(null); setTone('idle'); setTurning(false); setCaption('Look at the camera')
      if (!(await waitForFace(v, 15000, 4, undefined, stop))) { if (!stop.stop) { setTone('warn'); setCaption(''); setTrouble('We cannot see your face. Face the camera in good light and make sure nothing covers it.') } return }
      let lv: Liveness = 'skipped'
      if (settings.livenessChallenge) {
        setTone('ok'); setTurns({ a: false, b: false }); setTurning(true); setCaption('Slowly turn your head to one side, then the other')
        lv = (await turnChallenge(v, (a, b) => setTurns({ a, b }), stop)) ? 'passed' : 'failed'
        if (stop.stop) return
        setTurning(false); setCaption('Now look straight at the camera')
        await waitForFace(v, 6000, 3, (yaw) => Math.abs(yaw) < 0.2, stop)
        if (stop.stop) return
      }
      setCaption('Hold still…')
      const c = grab(v)
      if (!c) return
      const r = await readFace(c).catch(() => null)
      const b = await toBlob(c)
      if (!stop.stop && b) show(b, r?.embedding ?? null, lv)
    })()
    return () => { stop.stop = true }
  }, [step, faceFlow, cam.state, models, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  const snap = async () => { const c = cam.video.current && grab(cam.video.current); const b = c && (await toBlob(c)); if (b) show(b, null, 'skipped') }
  // A photo chosen from the device is not read for a face (it could be an old picture), so it is flagged for a person to look at.
  const pick = (f?: File | null) => { if (f) show(f, null, 'skipped') }
  const retake = () => { setPhoto(null); setPreview(null); setFace(null); setLiveness('skipped'); setError(''); setStep('capture'); setAttempt((n) => n + 1) }
  const ready = (!settings.requireSelfie || !!photo) && (!settings.requireLocation || skipLoc || !!pos)
  const send = async () => {
    setStep('sending'); setError('')
    try {
      const fd = new FormData()
      fd.append('type', type); fd.append('device', device); fd.append('liveness', liveness)
      if (face) fd.append('embedding', JSON.stringify(readable(face)))
      if (isVirtualCamera(cam.stream.current)) fd.append('virtualCamera', 'true')
      if (pos) { fd.append('latitude', String(pos.latitude)); fd.append('longitude', String(pos.longitude)); fd.append('accuracy', String(Math.round(pos.accuracy))) }
      if (photo) fd.append('selfie', photo, 'selfie.jpg')
      const r = (await api.post('/geomark/punch', fd, { headers: { 'Content-Type': 'multipart/form-data' } })).data.data
      setResult({ ...r, at: new Date() })
      qc.invalidateQueries({ queryKey: ['attendance-today'] }); qc.invalidateQueries({ queryKey: ['dashboard'] })
      setStep('done')
    } catch (e) { setError(errMsg(e)); setStep(photo ? 'review' : 'capture') }
  }

  const camProblem = cam.state === 'blocked' ? 'The camera is blocked. Allow camera access for this site in your browser (look for the camera icon in the address bar), then press Try again.'
    : cam.state === 'none' ? 'No camera was found on this device. You can choose a photo instead.' : null
  const faceTrouble = faceFlow && models === 'failed' ? 'Face checking does not work in this browser, so you can take a plain photo instead.' : trouble
  const manual = cam.state === 'on' && (!faceFlow || models === 'failed' || !!trouble)
  const title = type === 'in' ? 'Clock in' : 'Clock out'
  const time = result?.at?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const flagged = !!result?.flags?.length

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 950, background: 'rgba(37,37,35,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: narrow ? 0 : 16 }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="card" style={{ background: 'var(--solid)', width: narrow ? '100%' : 520, height: narrow ? '100%' : undefined, maxHeight: narrow ? undefined : '94vh', borderRadius: narrow ? 0 : undefined, overflowY: 'auto', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-pop)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 16px 6px 22px' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 22, letterSpacing: '-0.02em' }}>{step === 'done' ? (flagged ? 'Done, with a note' : 'Done') : title}</span>
          <button className="btn btn-ghost btn-icon" style={{ width: 34, height: 34 }} onClick={onClose} disabled={step === 'sending'} aria-label="Close"><Icon name="x" size={15} /></button>
        </div>

        {step === 'done' ? (
          <div style={{ padding: '10px 22px 24px', display: 'grid', gap: 12, textAlign: 'center', justifyItems: 'center' }}>
            <span style={{ width: 64, height: 64, borderRadius: 32, display: 'grid', placeItems: 'center', background: flagged ? 'var(--honey)' : 'var(--well)' }}><Icon name={flagged ? 'alert' : 'check'} size={30} /></span>
            <h2 style={{ fontSize: 20, margin: 0 }}>{`Clocked ${type} at ${time}`}</h2>
            {result.faceStatus === 'matched' && <span className="pill ok">Your face matched</span>}
            <p className="dim" style={{ margin: 0 }}>{flagged ? 'Your manager will take a quick look. Nothing else is needed from you.' : type === 'in' ? 'Have a good day!' : 'Your hours are saved to attendance.'}</p>
            {flagged && <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>{result.flags.map((f: string) => <li key={f} className="dim">{WHY[f] ?? f}</li>)}</ul>}
            <button className="btn btn-primary" style={{ minWidth: 160 }} onClick={onClose} autoFocus>Done</button>
          </div>
        ) : (
          <div style={{ padding: '6px 22px 22px', display: 'grid', gap: 12 }}>
            {settings.faceMatching && step !== 'sending' && (!settings.enrolment || settings.enrolment.status === 'rejected') && <p className="dim" style={{ margin: 0, fontSize: 13 }}>Your face is not registered, so this clock-in will not be checked. <Link to="/my-face" onClick={onClose}>Register it now</Link> (about 10 seconds).</p>}
            {settings.faceMatching && settings.enrolment?.status === 'pending' && <p className="dim" style={{ margin: 0, fontSize: 13 }}>Your face is waiting for HR to approve it. Until then clock-ins are not matched.</p>}
            <CameraStage video={cam.video} still={preview} tone={tone} caption={camProblem ? undefined : cam.state === 'starting' ? 'Starting the camera…' : faceFlow && models === 'loading' && step === 'capture' ? 'Getting ready…' : caption}>
              {turning && <div aria-hidden="true" style={{ position: 'absolute', top: 10, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 8 }}>{[turns.a, turns.b].map((on, i) => <span key={i} style={{ padding: '3px 10px', borderRadius: 12, background: on ? '#4ade80' : 'rgba(20,20,19,0.72)', color: on ? '#143d24' : '#fff', fontSize: 13, fontWeight: 500 }}>{on ? '✓' : '○'} {i ? 'Other side' : 'One side'}</span>)}</div>}
            </CameraStage>
            {camProblem && <div role="alert" style={{ color: 'var(--danger)' }}>{camProblem}</div>}
            {faceTrouble && !camProblem && <div role="alert" style={{ color: 'var(--danger)' }}>{faceTrouble}</div>}
            {error && <div role="alert" style={{ color: 'var(--danger)' }}>{error}</div>}
            {!settings.storageReady && <div className="dim">Photo storage is not set up yet. Ask your administrator.</div>}

            <div style={{ display: 'grid', gap: 6, fontSize: 14 }} aria-label="What is ready">
              <Row label="Camera" pill={cam.state === 'on' ? ['ok', 'Ready'] : cam.state === 'starting' ? ['mute', 'Starting…'] : ['warn', cam.state === 'none' ? 'Not found' : 'Blocked']} />
              {settings.faceMatching && <Row label="Face check" pill={faceFlow ? (models === 'ready' ? ['ok', 'Ready'] : models === 'failed' ? ['warn', 'Unavailable'] : ['mute', 'Loading…']) : settings.enrolment?.status === 'pending' ? ['mute', 'Waiting for HR'] : ['mute', 'Not set up']} note={faceFlow ? undefined : 'You can still clock in.'} />}
              <Row label="Location" pill={skipLoc ? ['mute', 'Not needed'] : loc === 'ok' ? ['ok', 'Found'] : loc === 'error' ? ['warn', 'Not available'] : ['mute', 'Finding…']}
                note={skipLoc ? 'Your office area is not checked from a computer.' : loc === 'ok' && pos ? `Accurate to about ${Math.round(pos.accuracy)} m${pos.accuracy > settings.maxAccuracyMeters ? '. That is vague, so a manager may check it.' : '.'}` : loc === 'error' ? 'Allow location access for this site in your browser.' : undefined}
                action={loc === 'error' ? <button className="link" onClick={askLocation}>Try again</button> : undefined} />
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
              {camProblem && cam.state === 'blocked' && <button className="btn btn-ghost" onClick={cam.retry}>Try again</button>}
              {step === 'capture' && cam.state !== 'on' && cam.state !== 'starting' && <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>Choose a photo<input type="file" accept="image/*" capture="user" hidden onChange={(e) => pick(e.target.files?.[0])} /></label>}
              {step === 'capture' && trouble && cam.state === 'on' && <button className="btn btn-ghost" onClick={() => setAttempt((n) => n + 1)}>Try again</button>}
              {step === 'capture' && manual && <button className="btn btn-primary" onClick={snap}>Take photo</button>}
              {step === 'capture' && !settings.requireSelfie && <button className="btn btn-ghost" disabled={!ready} onClick={send}>{title} without a photo</button>}
              {(step === 'review' || step === 'sending') && <button className="btn btn-ghost" disabled={step === 'sending'} onClick={retake}>Retake</button>}
              {(step === 'review' || step === 'sending') && <button className="btn btn-primary" style={{ minWidth: 150 }} disabled={!ready || step === 'sending'} onClick={send}>{step === 'sending' ? 'Working…' : title}</button>}
              {step === 'review' && !ready && <span className="dim" style={{ fontSize: 13 }}>Waiting for your location…</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ label, pill, note, action }: { label: string; pill: [string, string]; note?: string; action?: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: '2px 8px', alignItems: 'center' }}>
      <span style={{ fontWeight: 500 }}>{label}</span>
      <span><span className={`pill ${pill[0]}`}>{pill[1]}</span></span>
      {(note || action) && <span className="dim" style={{ fontSize: 13, gridColumn: '1 / -1' }}>{note} {action}</span>}
    </div>
  )
}

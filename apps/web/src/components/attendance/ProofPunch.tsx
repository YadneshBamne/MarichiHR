import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../ui/Modal'
import { useToast } from '../ui/Toast'
import { deviceKind, isVirtualCamera, readFace, readable, turnChallenge } from '../../lib/face'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type Liveness = 'passed' | 'failed' | 'skipped'
export type ProofSettings = { enabled: boolean; requireProof: boolean; requireSelfie: boolean; requireLocation: boolean; maxAccuracyMeters: number; faceMatching: boolean; livenessChallenge: boolean; locationRule: 'all' | 'mobile_only'; enrolment: { status: string; note: string | null; samples: number } | null; storageReady: boolean }

// Clock in or out with proof from any device with a camera: a selfie, the location (phones; computers only if HR asks) and, when face
// matching is on, a reading of the face that the server compares with the person's approved readings. The photo is kept privately and
// only shown to managers and HR when something looks odd. Face matching only ever flags a punch; it never stops one.
export default function ProofPunch({ type, settings, onClose }: { type: 'in' | 'out'; settings: ProofSettings; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [device] = useState(deviceKind)
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [face, setFace] = useState<number[] | null>(null)
  const [liveness, setLiveness] = useState<Liveness>('skipped')
  const [note, setNote] = useState('')
  const [camera, setCamera] = useState<'starting' | 'on' | 'off'>('starting')
  const [pos, setPos] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null)
  const [locError, setLocError] = useState('')
  const [busy, setBusy] = useState(false)
  const [consent, setConsent] = useState(false)
  const skipLoc = device === 'desktop' && settings.locationRule === 'mobile_only'
  const approved = settings.enrolment?.status === 'approved'
  const canEnrol = !settings.enrolment || settings.enrolment.status === 'rejected'

  useEffect(() => {
    let live = true
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user', width: 640 }, audio: false })
      .then((s) => { if (!live) { s.getTracks().forEach((t) => t.stop()); return } stream.current = s; if (video.current) video.current.srcObject = s; setCamera('on') })
      .catch(() => setCamera('off'))
    if (!skipLoc) {
      navigator.geolocation?.getCurrentPosition((p) => live && setPos({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }), () => live && setLocError('We could not read your location. Allow location access for this site and try again.'), { enableHighAccuracy: true, timeout: 12000 })
      if (!navigator.geolocation) setLocError('This device cannot share its location.')
    }
    return () => { live = false; stream.current?.getTracks().forEach((t) => t.stop()) }
  }, [skipLoc])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const frame = () => {
    const v = video.current
    if (!v?.videoWidth) return null
    const c = document.createElement('canvas'); const w = 480
    c.width = w; c.height = Math.round((v.videoHeight / v.videoWidth) * w)
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
    return c
  }
  const blobOf = (c: HTMLCanvasElement) => new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.8))

  // Take the selfie. With face matching on, the person first turns their head (if they have an approved face) and the face is read from the final picture.
  const takeSelfie = async () => {
    setBusy(true)
    try {
      let lv: Liveness = 'skipped'
      if (settings.faceMatching && settings.livenessChallenge && approved && video.current) {
        setNote('Slowly turn your head to one side, then the other.')
        try { lv = (await turnChallenge(video.current)) ? 'passed' : 'failed' } catch { lv = 'skipped' }
        setNote('Now look straight at the camera.')
        await sleep(1200)
      }
      const c = frame()
      if (!c) return
      let emb: number[] | null = null
      if (settings.faceMatching) { try { emb = (await readFace(c))?.embedding ?? null } catch { emb = null } }
      const b = await blobOf(c)
      if (b) { setPhoto(b); setPreview(URL.createObjectURL(b)); setFace(emb); setLiveness(lv) }
    } finally { setNote(''); setBusy(false) }
  }
  // A photo chosen from the device is not read for a face (it could be an old picture), so it is flagged for a person to look at.
  const pick = (f?: File | null) => { if (f) { setPhoto(f); setPreview(URL.createObjectURL(f)); setFace(null); setLiveness('skipped') } }
  const retake = () => { setPhoto(null); setPreview(null); setFace(null); setLiveness('skipped') }

  const send = async () => {
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('type', type); fd.append('device', device); fd.append('liveness', liveness)
      if (face) fd.append('embedding', JSON.stringify(readable(face)))
      if (isVirtualCamera(stream.current)) fd.append('virtualCamera', 'true')
      if (pos) { fd.append('latitude', String(pos.latitude)); fd.append('longitude', String(pos.longitude)); fd.append('accuracy', String(Math.round(pos.accuracy))) }
      if (photo) fd.append('selfie', photo, 'selfie.jpg')
      const r = (await api.post('/geomark/punch', fd, { headers: { 'Content-Type': 'multipart/form-data' } })).data.data
      toast(r.flags?.length ? `Clocked ${type}. A manager will look at it: ${r.flags.join(', ').replace(/_/g, ' ')}.` : type === 'in' ? 'Clocked in. Have a good day!' : 'Clocked out. Hours saved to attendance.')
      qc.invalidateQueries({ queryKey: ['attendance-today'] }); qc.invalidateQueries({ queryKey: ['dashboard'] })
      onClose()
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  // Older flow: save the photo on screen as the reference (used when face matching is off or no face could be read)
  const enrolPhoto = async () => {
    if (!photo) return
    setBusy(true)
    try {
      const fd = new FormData(); fd.append('consent', 'true'); fd.append('selfie', photo, 'reference.jpg')
      await api.post('/geomark/enrol', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      toast('Saved as your reference photo. HR will approve it.'); qc.invalidateQueries({ queryKey: ['geomark-settings'] })
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  // Take a few readings, a moment apart, so small changes in pose and light are covered
  const shoot = async (n: number) => {
    const shots: { blob: Blob; emb: number[] }[] = []
    for (let i = 0; i < n; i++) {
      setNote(i === 0 ? 'Look at the camera' : 'Move your head a little')
      await sleep(i === 0 ? 700 : 900)
      const c = frame(); if (!c) continue
      let r: Awaited<ReturnType<typeof readFace>> = null
      try { r = await readFace(c) } catch { r = null }
      const blob = await blobOf(c)
      if (blob && r) shots.push({ blob, emb: r.embedding })
    }
    return shots
  }
  const register = async () => {
    setBusy(true)
    try {
      const shots = await shoot(3)
      if (shots.length < 2) { toast('We could not see your face clearly. Face the camera in good light and try again.', 'error'); return }
      const fd = new FormData(); fd.append('consent', 'true'); fd.append('selfie', shots[0].blob, 'reference.jpg'); fd.append('embeddings', JSON.stringify(shots.map((s) => readable(s.emb))))
      await api.post('/geomark/enrol', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      toast('Your face is registered. HR will approve it, then your clock-ins can be checked.'); qc.invalidateQueries({ queryKey: ['geomark-settings'] })
    } catch (e) { toast(errMsg(e), 'error') } finally { setNote(''); setBusy(false) }
  }
  const addDevice = async () => {
    setBusy(true)
    try {
      const shots = await shoot(2)
      if (!shots.length) { toast('We could not see your face clearly. Face the camera in good light and try again.', 'error'); return }
      await api.post('/geomark/enrol/sample', { embeddings: shots.map((s) => readable(s.emb)) })
      toast('This device is added to your face profile.'); qc.invalidateQueries({ queryKey: ['geomark-settings'] })
    } catch (e) { toast(errMsg(e), 'error') } finally { setNote(''); setBusy(false) }
  }
  const ready = (!settings.requireSelfie || !!photo) && (!settings.requireLocation || skipLoc || !!pos)
  return (
    <Modal open onClose={onClose} title={type === 'in' ? 'Clock in with proof' : 'Clock out with proof'} width={460}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ borderRadius: 18, overflow: 'hidden', background: 'var(--well)', aspectRatio: '4 / 3', display: 'grid', placeItems: 'center' }}>
          {preview ? <img src={preview} alt="Your selfie" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : camera === 'off' ? <span className="dim" style={{ padding: 16, textAlign: 'center' }}>The camera is not available. Choose a photo instead.</span>
            : <video ref={video} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />}
        </div>
        <div role="status" style={{ minHeight: 20, fontWeight: 500 }}>{note}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!preview && camera === 'on' && <button className="btn btn-primary btn-sm" disabled={busy} onClick={takeSelfie}>{busy ? 'Checking…' : 'Take selfie'}</button>}
          {!preview && <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>Choose a photo<input type="file" accept="image/*" capture="user" hidden onChange={(e) => pick(e.target.files?.[0])} /></label>}
          {preview && <button className="btn btn-ghost btn-sm" onClick={retake}>Retake</button>}
        </div>
        <div className="dim" style={{ fontSize: 13 }}>
          {skipLoc ? 'Your office area is not checked from a computer.' : pos ? `Location found (accurate to about ${Math.round(pos.accuracy)} m).` : locError || 'Finding your location…'}
          {!skipLoc && pos && pos.accuracy > settings.maxAccuracyMeters ? ' This is vague: a manager may check it.' : ''}
        </div>
        {!settings.storageReady && <div className="dim">Photo storage is not set up yet. Ask your administrator.</div>}
        {settings.faceMatching && camera === 'on' && canEnrol && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
            <span>Register my face so my clock-ins can be checked, from any device. It is biometric data: it is stored encrypted, only HR and managers can see the photo, and I can erase it at any time.
              <button type="button" className="link" style={{ marginLeft: 6 }} disabled={!consent || busy} onClick={register}>Register my face</button></span>
          </label>
        )}
        {(!settings.faceMatching || camera !== 'on') && canEnrol && preview && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
            <span>Use this photo as my reference. It is biometric data: only HR and managers can see it, and I can erase it at any time.
              <button type="button" className="link" style={{ marginLeft: 6 }} disabled={!consent || busy} onClick={enrolPhoto}>Save as reference</button></span>
          </label>
        )}
        {settings.enrolment?.status === 'pending' && <span className="dim" style={{ fontSize: 13 }}>Your face is waiting for HR to approve it. Until then clock-ins are not matched.</span>}
        {settings.enrolment?.status === 'rejected' && <span className="dim" style={{ fontSize: 13 }}>HR did not accept your face photo{settings.enrolment.note ? `: ${settings.enrolment.note}` : ''}. Register again.</span>}
        {settings.faceMatching && approved && settings.enrolment!.samples > 0 && camera === 'on' && !preview && (
          <button type="button" className="link" style={{ justifySelf: 'start', fontSize: 13 }} disabled={busy} onClick={addDevice}>Add this device to my face profile</button>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={send}>{busy ? 'Working…' : type === 'in' ? 'Clock in' : 'Clock out'}</button>
        </div>
      </div>
    </Modal>
  )
}

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../ui/Modal'
import { useToast } from '../ui/Toast'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
export type ProofSettings = { enabled: boolean; requireProof: boolean; requireSelfie: boolean; requireLocation: boolean; maxAccuracyMeters: number; enrolment: { status: string; note: string | null } | null; storageReady: boolean }

// Clock in or out with proof: a selfie from the camera and the phone's location, sent together. The photo is kept privately and
// only shown to managers and HR when something looks odd.
export default function ProofPunch({ type, settings, onClose }: { type: 'in' | 'out'; settings: ProofSettings; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [camera, setCamera] = useState<'starting' | 'on' | 'off'>('starting')
  const [pos, setPos] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null)
  const [locError, setLocError] = useState('')
  const [busy, setBusy] = useState(false)
  const [consent, setConsent] = useState(false)

  useEffect(() => {
    let live = true
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user', width: 640 }, audio: false })
      .then((s) => { if (!live) { s.getTracks().forEach((t) => t.stop()); return } stream.current = s; if (video.current) video.current.srcObject = s; setCamera('on') })
      .catch(() => setCamera('off'))
    navigator.geolocation?.getCurrentPosition((p) => live && setPos({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }), () => live && setLocError('We could not read your location. Allow location access for this site and try again.'), { enableHighAccuracy: true, timeout: 12000 })
    if (!navigator.geolocation) setLocError('This device cannot share its location.')
    return () => { live = false; stream.current?.getTracks().forEach((t) => t.stop()) }
  }, [])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const snap = () => {
    const v = video.current
    if (!v?.videoWidth) return
    const c = document.createElement('canvas'); const w = 480
    c.width = w; c.height = Math.round((v.videoHeight / v.videoWidth) * w)
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
    c.toBlob((b) => { if (b) { setPhoto(b); setPreview(URL.createObjectURL(b)) } }, 'image/jpeg', 0.8)
  }
  const pick = (f?: File | null) => { if (f) { setPhoto(f); setPreview(URL.createObjectURL(f)) } }
  const retake = () => { setPhoto(null); setPreview(null) }

  const send = async () => {
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('type', type)
      if (pos) { fd.append('latitude', String(pos.latitude)); fd.append('longitude', String(pos.longitude)); fd.append('accuracy', String(Math.round(pos.accuracy))) }
      if (photo) fd.append('selfie', photo, 'selfie.jpg')
      const r = (await api.post('/geomark/punch', fd, { headers: { 'Content-Type': 'multipart/form-data' } })).data.data
      toast(r.flags?.length ? `Clocked ${type}. A manager will look at it: ${r.flags.join(', ').replace(/_/g, ' ')}.` : type === 'in' ? 'Clocked in. Have a good day!' : 'Clocked out. Hours saved to attendance.')
      qc.invalidateQueries({ queryKey: ['attendance-today'] }); qc.invalidateQueries({ queryKey: ['dashboard'] })
      onClose()
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const enrol = async () => {
    if (!photo) return
    setBusy(true)
    try {
      const fd = new FormData(); fd.append('consent', 'true'); fd.append('selfie', photo, 'reference.jpg')
      await api.post('/geomark/enrol', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      toast('Saved as your reference photo. HR will approve it.'); qc.invalidateQueries({ queryKey: ['geomark-settings'] })
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const ready = (!settings.requireSelfie || !!photo) && (!settings.requireLocation || !!pos)
  return (
    <Modal open onClose={onClose} title={type === 'in' ? 'Clock in with proof' : 'Clock out with proof'} width={460}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ borderRadius: 18, overflow: 'hidden', background: 'var(--well)', aspectRatio: '4 / 3', display: 'grid', placeItems: 'center' }}>
          {preview ? <img src={preview} alt="Your selfie" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : camera === 'off' ? <span className="dim" style={{ padding: 16, textAlign: 'center' }}>The camera is not available. Choose a photo instead.</span>
            : <video ref={video} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!preview && camera === 'on' && <button className="btn btn-primary btn-sm" onClick={snap}>Take selfie</button>}
          {!preview && <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>Choose a photo<input type="file" accept="image/*" capture="user" hidden onChange={(e) => pick(e.target.files?.[0])} /></label>}
          {preview && <button className="btn btn-ghost btn-sm" onClick={retake}>Retake</button>}
        </div>
        <div className="dim" style={{ fontSize: 13 }} role="status">
          {pos ? `Location found (accurate to about ${Math.round(pos.accuracy)} m).` : locError || 'Finding your location…'}
          {pos && pos.accuracy > settings.maxAccuracyMeters ? ' This is vague: a manager may check it.' : ''}
        </div>
        {!settings.storageReady && <div className="dim">Photo storage is not set up yet. Ask your administrator.</div>}
        {settings.enrolment === null && preview && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
            <span>Use this photo as my reference. It is biometric data: only HR and managers can see it, and I can erase it at any time.
              <button type="button" className="link" style={{ marginLeft: 6 }} disabled={!consent || busy} onClick={enrol}>Save as reference</button></span>
          </label>
        )}
        {settings.enrolment?.status === 'pending' && <span className="dim" style={{ fontSize: 13 }}>Your reference photo is waiting for HR to approve it.</span>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={send}>{busy ? 'Sending…' : type === 'in' ? 'Clock in' : 'Clock out'}</button>
        </div>
      </div>
    </Modal>
  )
}

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import PageHeader from '../../components/ui/PageHeader'
import { useToast } from '../../components/ui/Toast'
import { CameraStage, useCamera, useFaceModels } from '../../components/attendance/CameraStage'
import { readable, takeReadings, waitForFace } from '../../lib/face'
import type { ProofSettings } from '../../components/attendance/ProofPunch'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

// "My face": the one place an employee registers (or removes) the face used to check their clock-ins. One step at a time:
// read what it means, agree, look at the camera while it takes a few pictures by itself, then HR approves it.
export default function MyFacePage() {
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['geomark-settings'], retry: false, queryFn: async () => (await api.get('/geomark/settings')).data.data as ProofSettings })
  const [step, setStep] = useState<'home' | 'consent' | 'capture'>('home')
  const [mode, setMode] = useState<'register' | 'device'>('register')
  const [agree, setAgree] = useState(false)
  const s = q.data
  const e = s?.enrolment ?? null
  const refresh = () => qc.invalidateQueries({ queryKey: ['geomark-settings'] })
  const erase = async () => {
    if (!window.confirm('Erase your registered face? Your clock-ins will no longer be checked against it.')) return
    try { await api.delete('/geomark/enrol'); toast('Your face has been erased'); refresh() } catch (x) { toast(errMsg(x), 'error') }
  }
  const begin = (m: 'register' | 'device') => { setMode(m); setAgree(false); setStep(m === 'register' ? 'consent' : 'capture') }

  return (
    <div>
      <PageHeader title="My face" sub="Register your face once so your clock-ins can be checked. Works on any device with a camera." />
      {q.isError && <div className="card" style={{ padding: 20 }}>Face checks are not part of your company's plan.</div>}
      {s && !s.enabled && <div className="card" style={{ padding: 20 }}>Your company has not switched on clock-in checks yet.</div>}
      {s && s.enabled && !s.faceMatching && <div className="card" style={{ padding: 20 }}>Your company does not use face checks. You do not need to do anything.</div>}
      {s && s.enabled && s.faceMatching && step === 'home' && (
        <div className="card" style={{ padding: 22, display: 'grid', gap: 14, maxWidth: 560 }}>
          {!e && <><h2 style={{ fontSize: 18 }}>Not registered yet <span className="pill mute">Optional</span></h2>
            <p className="dim" style={{ margin: 0 }}>Registering takes about 10 seconds. After HR approves it, each time you clock in the app checks it is really you. If something looks off, your manager takes a quick look. You are never blocked from clocking in.</p></>}
          {e?.status === 'pending' && <><h2 style={{ fontSize: 18 }}>Waiting for HR <span className="pill warn">Pending</span></h2>
            <p className="dim" style={{ margin: 0 }}>HR needs to approve your photo. Until then your clock-ins work as normal and are not matched.</p></>}
          {e?.status === 'approved' && <><h2 style={{ fontSize: 18 }}>You are registered <span className="pill ok">Approved</span></h2>
            <p className="dim" style={{ margin: 0 }}>Your clock-ins are checked against your face. If you also clock in from a laptop, add it below so that camera is recognised too.</p></>}
          {e?.status === 'rejected' && <><h2 style={{ fontSize: 18 }}>HR did not accept your photo <span className="pill danger">Not accepted</span></h2>
            <p className="dim" style={{ margin: 0 }}>{e.note ? `Reason: ${e.note}. ` : ''}Please register again in good light, facing the camera.</p></>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(!e || e.status === 'rejected') && <button className="btn btn-primary" onClick={() => begin('register')}>Register my face</button>}
            {e?.status === 'pending' && <button className="btn btn-ghost" onClick={() => begin('register')}>Register again</button>}
            {e?.status === 'approved' && <><button className="btn btn-primary" onClick={() => begin('device')}>Add this device</button>
              <button className="btn btn-ghost" onClick={() => begin('register')}>Register again</button></>}
            {e && <button className="btn btn-ghost" onClick={erase}>Erase my face</button>}
          </div>
        </div>
      )}
      {s && step === 'consent' && (
        <div className="card" style={{ padding: 22, display: 'grid', gap: 14, maxWidth: 560 }}>
          <h2 style={{ fontSize: 18 }}>Before we start</h2>
          <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
            <li>Your face is biometric data. We keep a photo and a set of numbers made from it.</li>
            <li>The numbers are stored encrypted. Only HR and your managers can see the photo.</li>
            <li>It is used only to check your clock-ins. It is deleted if you erase it here or leave the company.</li>
            <li>You can stop at any time.</li>
          </ul>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}><input type="checkbox" checked={agree} onChange={(x) => setAgree(x.target.checked)} style={{ marginTop: 4 }} /> I understand and agree</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={!agree} onClick={() => setStep('capture')}>Continue</button>
            <button className="btn btn-ghost" onClick={() => setStep('home')}>Back</button>
          </div>
        </div>
      )}
      {s && step === 'capture' && <FaceCapture mode={mode} onClose={() => { setStep('home'); refresh() }} />}
    </div>
  )
}

// Opens the camera and does everything by itself: waits until it can see the face, takes the readings, saves them.
function FaceCapture({ mode, onClose }: { mode: 'register' | 'device'; onClose: () => void }) {
  const toast = useToast()
  const cam = useCamera()
  const models = useFaceModels(true)
  const total = mode === 'register' ? 3 : 2
  const [caption, setCaption] = useState('Getting ready…')
  const [trouble, setTrouble] = useState<string | null>(null)
  const [done, setDone] = useState(0)
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (cam.state !== 'on' || models !== 'ready' || !cam.video.current) return
    const stop = { stop: false }
    const v = cam.video.current
    ;(async () => {
      setTrouble(null); setDone(0); setCaption('Look at the camera')
      if (!(await waitForFace(v, 15000, 4, undefined, stop))) { if (!stop.stop) setTrouble('We cannot see your face. Face the camera in good light and make sure nothing covers your face.'); return }
      const shots = await takeReadings(v, total, (i) => { setDone(i); setCaption(i === 0 ? 'Hold still' : 'Turn your head a tiny bit') }, stop)
      if (stop.stop) return
      if (shots.length < (mode === 'register' ? 2 : 1)) { setTrouble('We could not get a clear picture of your face. Try again in better light.'); return }
      setDone(total); setCaption('Saving…'); setSaving(true)
      try {
        if (mode === 'register') {
          const fd = new FormData(); fd.append('consent', 'true'); fd.append('selfie', shots[0].blob, 'reference.jpg'); fd.append('embeddings', JSON.stringify(shots.map((x) => readable(x.emb))))
          await api.post('/geomark/enrol', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
          toast('Your face is registered. HR will approve it next.')
        } else {
          await api.post('/geomark/enrol/sample', { embeddings: shots.map((x) => readable(x.emb)) })
          toast('This device is added to your face profile.')
        }
        if (!stop.stop) onClose()
      } catch (x) { setTrouble(errMsg(x)) } finally { setSaving(false) }
    })()
    return () => { stop.stop = true }
  }, [cam.state, models, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  const problem = cam.state === 'blocked' ? 'The camera is blocked. Allow camera access for this site in your browser (look for the camera icon in the address bar), then try again.'
    : cam.state === 'none' ? 'No camera was found on this device.'
    : models === 'failed' ? 'Face reading does not work in this browser. Try another browser, or ask HR.'
    : trouble
  const again = () => { if (cam.state === 'blocked') cam.retry(); else setAttempt((n) => n + 1) }
  return (
    <div className="card" style={{ padding: 18, display: 'grid', gap: 12, maxWidth: 560 }}>
      <CameraStage video={cam.video} tone={problem ? 'warn' : saving || done >= total ? 'ok' : 'idle'} caption={problem ? undefined : cam.state === 'starting' ? 'Starting the camera…' : models === 'loading' ? 'Getting ready…' : caption} />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }} aria-label={`${done} of ${total} pictures taken`}>
        {Array.from({ length: total }, (_, i) => <span key={i} style={{ width: 10, height: 10, borderRadius: 5, background: i < done ? 'var(--honey)' : 'var(--well)' }} />)}
      </div>
      {problem && <div role="alert" style={{ color: 'var(--danger)' }}>{problem}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        {problem && cam.state !== 'none' && models !== 'failed' && <button className="btn btn-primary" onClick={again}>Try again</button>}
        <button className="btn btn-ghost" disabled={saving} onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

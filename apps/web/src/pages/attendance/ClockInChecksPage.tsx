import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const FLAG: Record<string, string> = { outside_fence: 'Outside the office area', low_accuracy: 'Location not precise', face_mismatch: 'Face did not match', face_not_checked: 'Face could not be checked', liveness_failed: 'Head-turn check failed', virtual_camera: 'Virtual camera used' }
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

// Clock-in with proof: managers and HR look at flagged selfies and locations; HR sets the rules and approves reference photos.
export default function ClockInChecksPage() {
  const { hasRole } = useAuth()
  const hr = hasRole('hr_admin') || hasRole('system_admin')
  const [tab, setTab] = useState<'review' | 'photos' | 'rules'>('review')
  const root = useReveal<HTMLDivElement>(tab)
  const tabs: [typeof tab, string][] = [['review', 'Review'], ...(hr ? [['photos', 'Face photos'] as [typeof tab, string], ['rules', 'Rules'] as [typeof tab, string]] : [])]
  return (
    <div ref={root}>
      <PageHeader title="Clock-in checks" sub="Selfie and location proof from clock-ins. Anything odd is flagged for a look.">
        <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14 }}>{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      </PageHeader>
      {tab === 'review' ? <Review /> : tab === 'photos' ? <Photos /> : <Rules />}
    </div>
  )
}

function Review() {
  const toast = useToast()
  const qc = useQueryClient()
  const [status, setStatus] = useState<'flagged' | 'all'>('flagged')
  const [note, setNote] = useState<Record<string, string>>({})
  const q = useQuery({ queryKey: ['geomark-checks', status], queryFn: async () => (await api.get('/geomark/checks', { params: { status } })).data.data as any[] })
  const decide = useMutation({ mutationFn: async (v: { id: string; approve: boolean }) => (await api.post(`/geomark/checks/${v.id}/decision`, { approve: v.approve, note: note[v.id]?.trim() || undefined })).data.data, onSuccess: () => { toast('Saved'); qc.invalidateQueries({ queryKey: ['geomark-checks'] }) }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 6 }}>{(['flagged', 'all'] as const).map((k) => <button key={k} className={`btn btn-sm ${status === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setStatus(k)}>{k === 'flagged' ? 'Needs a look' : 'Recent (spot check)'}</button>)}</div>
      {q.data?.length === 0 && <div className="card" style={{ padding: 20 }}>Nothing to review.</div>}
      {q.data?.map((c) => (
        <div key={c.id} className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span><strong>{c.employee}</strong> <span className="dim">clocked {c.kind} · {when(c.at)}</span></span>
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{c.flags.map((f: string) => <span key={f} className="pill warn">{FLAG[f] ?? f}</span>)}<span className={`pill ${c.status === 'verified' || c.status === 'approved' ? 'ok' : c.status === 'rejected' ? 'danger' : 'warn'}`}>{c.status}</span></span>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {c.photoUrl ? <figure style={{ margin: 0 }}><img src={c.photoUrl} alt="Selfie at clock-in" width={140} style={{ borderRadius: 14, display: 'block' }} /><figcaption className="dim" style={{ fontSize: 12 }}>At clock-in</figcaption></figure> : <span className="dim">Photo deleted after the retention period.</span>}
            {c.referenceUrl && <figure style={{ margin: 0 }}><img src={c.referenceUrl} alt="Approved reference photo" width={140} style={{ borderRadius: 14, display: 'block' }} /><figcaption className="dim" style={{ fontSize: 12 }}>Reference</figcaption></figure>}
            <div className="dim" style={{ fontSize: 13 }}>
              {c.faceMatch != null && <div>Face similarity {Math.round(c.faceMatch * 100)}%{c.faceStatus === 'matched' ? ' (matched)' : ' (below the bar)'}</div>}
              {c.faceStatus === 'no_reference' && <div>No approved face to compare with</div>}
              {c.device && <div>{c.device === 'desktop' ? 'From a computer' : 'From a phone or tablet'}</div>}
              {c.distance != null && <div>{c.distance} m from the office{c.withinFence ? '' : ' (outside)'}</div>}
              {c.accuracy != null && <div>Location accurate to about {Math.round(c.accuracy)} m</div>}
              {c.latitude != null && <a href={`https://www.openstreetmap.org/?mlat=${c.latitude}&mlon=${c.longitude}#map=17/${c.latitude}/${c.longitude}`} target="_blank" rel="noopener noreferrer">Open on a map</a>}
              {c.note && <div>Note: {c.note}</div>}
            </div>
          </div>
          {['flagged', 'verified'].includes(c.status) && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input className="input" style={{ flex: '1 1 220px' }} placeholder="Note (needed to reject)" aria-label="Note" value={note[c.id] ?? ''} onChange={(e) => setNote({ ...note, [c.id]: e.target.value })} />
              <button className="btn btn-primary btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: c.id, approve: true })}>Accept</button>
              <button className="btn btn-ghost btn-sm" disabled={decide.isPending || (note[c.id] ?? '').trim().length < 3} onClick={() => decide.mutate({ id: c.id, approve: false })}>Reject</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function Photos() {
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['geomark-enrolments'], queryFn: async () => (await api.get('/geomark/enrolments')).data.data as any[] })
  const [note, setNote] = useState<Record<string, string>>({})
  const decide = useMutation({ mutationFn: async (v: { id: string; approve: boolean }) => (await api.post(`/geomark/enrolments/${v.id}/decision`, { approve: v.approve, note: note[v.id]?.trim() || undefined })).data.data, onSuccess: () => { toast('Saved'); qc.invalidateQueries({ queryKey: ['geomark-enrolments'] }) }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="dim" style={{ margin: 0 }}>Check that each photo shows the right person before approving it. These are reference photos for comparing clock-in selfies.</p>
      {q.data?.length === 0 && <div className="card" style={{ padding: 20 }}>No photos are waiting.</div>}
      {q.data?.map((e) => (
        <div key={e.id} className="card" style={{ padding: 16, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          {e.photoUrl && <img src={e.photoUrl} alt={`Reference photo of ${e.employee}`} width={120} style={{ borderRadius: 14 }} />}
          <span style={{ flex: '1 1 200px' }}><strong>{e.employee}</strong><span className="dim" style={{ display: 'block', fontSize: 13 }}>Sent {when(e.at)}</span></span>
          <input className="input" style={{ flex: '1 1 200px' }} placeholder="Reason (needed to refuse)" aria-label="Reason" value={note[e.id] ?? ''} onChange={(ev) => setNote({ ...note, [e.id]: ev.target.value })} />
          <button className="btn btn-primary btn-sm" onClick={() => decide.mutate({ id: e.id, approve: true })}>Approve</button>
          <button className="btn btn-ghost btn-sm" disabled={(note[e.id] ?? '').trim().length < 3} onClick={() => decide.mutate({ id: e.id, approve: false })}>Refuse</button>
        </div>
      ))}
    </div>
  )
}

function Rules() {
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['geomark-settings'], queryFn: async () => (await api.get('/geomark/settings')).data.data as any })
  const [f, setF] = useState({ enabled: false, requireProof: false, requireSelfie: true, requireLocation: true, maxAccuracyMeters: 100, retentionDays: 90, faceMatching: true, faceStrictness: 'normal', livenessChallenge: true, locationRule: 'mobile_only' })
  useEffect(() => { if (q.data) setF({ enabled: q.data.enabled, requireProof: q.data.requireProof, requireSelfie: q.data.requireSelfie, requireLocation: q.data.requireLocation, maxAccuracyMeters: q.data.maxAccuracyMeters, retentionDays: q.data.retentionDays, faceMatching: q.data.faceMatching, faceStrictness: q.data.faceStrictness, livenessChallenge: q.data.livenessChallenge, locationRule: q.data.locationRule }) }, [q.data])
  const save = useMutation({ mutationFn: async () => (await api.put('/geomark/settings', f)).data.data, onSuccess: () => { toast('Saved'); qc.invalidateQueries({ queryKey: ['geomark-settings'] }) }, onError: (e) => toast(errMsg(e), 'error') })
  const box = (k: 'enabled' | 'requireProof' | 'requireSelfie' | 'requireLocation' | 'faceMatching' | 'livenessChallenge', label: string, hint?: string) => (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}><input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} style={{ marginTop: 4 }} /><span>{label}{hint && <span className="dim" style={{ display: 'block', fontSize: 13 }}>{hint}</span>}</span></label>)
  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 14 }}>
      {box('enabled', 'Offer clock-in with a selfie and location', 'People see “clock in with proof” on their time tracker.')}
      {box('requireProof', 'Require it for everyone', 'The plain clock-in button stops working, so nobody can skip the proof.')}
      {box('requireSelfie', 'A selfie is required')}
      {box('requireLocation', 'A location is required', 'It is compared with your office geo-fences (set on Work locations).')}
      <div className="field"><label htmlFor="gm-loc">Office-area check on computers</label>
        <select id="gm-loc" className="input" value={f.locationRule} onChange={(e) => setF({ ...f, locationRule: e.target.value })}>
          <option value="mobile_only">Phones and tablets only (computers are checked by face)</option>
          <option value="all">Every device (computers have no GPS, so this flags many)</option>
        </select></div>
      {box('faceMatching', 'Match faces automatically', 'People register their face once, from any device with a camera. Each clock-in is compared with it. A mismatch only flags the punch for review; it never blocks it.')}
      {f.faceMatching && (<>
        <div className="field"><label htmlFor="gm-str">How strict the match is</label>
          <select id="gm-str" className="input" value={f.faceStrictness} onChange={(e) => setF({ ...f, faceStrictness: e.target.value })}>
            <option value="relaxed">Relaxed (fewer flags, easier to fool)</option>
            <option value="normal">Normal</option>
            <option value="strict">Strict (more flags in poor light)</option>
          </select></div>
        {box('livenessChallenge', 'Ask people to turn their head first', 'Stops a flat photo held up to the camera. Only asked of people whose face is approved.')}
      </>)}
      <div className="field"><label htmlFor="gm-acc">Flag locations vaguer than (metres)</label><input id="gm-acc" className="input" inputMode="numeric" value={f.maxAccuracyMeters} onChange={(e) => setF({ ...f, maxAccuracyMeters: Number(e.target.value) || 100 })} /></div>
      <div className="field"><label htmlFor="gm-ret">Delete selfies after (days)</label><input id="gm-ret" className="input" inputMode="numeric" value={f.retentionDays} onChange={(e) => setF({ ...f, retentionDays: Number(e.target.value) || 90 })} /></div>
      <p className="dim" style={{ margin: 0, fontSize: 13 }}>Selfies and face photos are biometric data. They are kept privately, shown only to managers and HR, and deleted after the period above. The face readings used for matching are stored encrypted and are deleted when a person erases their face, or leaves the company. Matching runs on free open-source software inside our own app and is a first check, not proof: it works best in good light, and the people reviewing flags make the final call. Offer people another way to clock in if they do not agree to a face reading.</p>
      <div><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button></div>
    </div>
  )
}

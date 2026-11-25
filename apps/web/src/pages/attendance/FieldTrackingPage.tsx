import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const ago = (iso: string) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago` }
// The person's own calendar day (not the UTC day, which is the wrong day for some hours in Zambia and India)
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const hoursText = (s: { startTime: string; endTime: string }) => (s.endTime < s.startTime ? `${s.startTime} and ${s.endTime} the next morning (night shift)` : `${s.startTime} and ${s.endTime}`)
// The map (Mapbox, 3D buildings) is its own chunk: loaded only when someone opens this page and a route is shown
const TrackMap = lazy(() => import('../../components/tracking/TrackMap'))
const mapFallback = <div className="skeleton" style={{ height: 380, borderRadius: 18 }} />

// GPS live tracking for field staff: the person starts and stops it, managers and HR see where the team is, HR sets who is tracked and when.
export default function FieldTrackingPage() {
  const { hasRole } = useAuth()
  const hr = hasRole('hr_admin') || hasRole('system_admin')
  const manager = hasRole('manager') || hr
  const root = useReveal<HTMLDivElement>('tracking')
  const s = useQuery({ queryKey: ['tracking-settings'], queryFn: async () => (await api.get('/tracking/settings')).data.data as any, refetchInterval: 60_000 })
  return (
    <div ref={root}>
      <PageHeader title="Field tracking" sub="Location sharing for field staff during working hours. Started by the person, visible only to their managers and HR." />
      {s.data && (
        <div style={{ display: 'grid', gap: 14 }}>
          {s.data.tracked && <Mine s={s.data} />}
          {manager && s.data.enabled && <Live />}
          {hr && <Rules s={s.data} />}
          {!s.data.tracked && !manager && <div className="card" style={{ padding: 20 }}>Location tracking is not set up for you.</div>}
        </div>
      )}
    </div>
  )
}

function Mine({ s }: { s: any }) {
  const toast = useToast()
  const qc = useQueryClient()
  const watch = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const last = useRef<{ latitude: number; longitude: number; accuracy: number; speed: number | null } | null>(null)
  const [consent, setConsent] = useState(false)
  const [msg, setMsg] = useState('')
  const on = !!s.session
  const refresh = () => qc.invalidateQueries({ queryKey: ['tracking-settings'] })
  const ping = async () => {
    const p = last.current
    if (!p) return
    try { await api.post('/tracking/ping', { latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy, speed: p.speed }) } catch (e: any) { if (e?.response?.status === 409) { halt(); refresh(); toast(errMsg(e)) } }
  }
  const halt = () => { if (watch.current != null) navigator.geolocation.clearWatch(watch.current); if (timer.current) clearInterval(timer.current); watch.current = null; timer.current = null; last.current = null }
  const begin = () => {
    if (!navigator.geolocation) return setMsg('This device cannot share its location.')
    halt()
    watch.current = navigator.geolocation.watchPosition((p) => { last.current = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, speed: p.coords.speed }; setMsg('') }, () => setMsg('Allow location access for this site so your location can be shared.'), { enableHighAccuracy: true, maximumAge: 15000 })
    timer.current = setInterval(ping, Math.max(30, s.intervalSeconds) * 1000)
    setTimeout(ping, 4000)
  }
  // Keep reporting while this page is open and a session is running (a reload resumes it)
  useEffect(() => { if (on) begin(); else halt(); return halt }, [on]) // eslint-disable-line react-hooks/exhaustive-deps
  const start = useMutation({ mutationFn: async () => (await api.post('/tracking/start', { consent: true })).data.data, onSuccess: () => { toast('Tracking started'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const stop = useMutation({ mutationFn: async () => (await api.post('/tracking/stop')).data.data, onSuccess: () => { toast('Tracking stopped'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const [day, setDay] = useState(localDay())
  const trail = useQuery({ queryKey: ['my-trail', day, on], refetchInterval: on && day === localDay() ? 30_000 : false, queryFn: async () => (await api.get('/tracking/trail', { params: { date: day } })).data.data as any })
  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
      <h2 style={{ fontSize: 17 }}>My tracking {on && <span className="pill ok">On</span>}</h2>
      {on ? (
        <>
          <span className="dim">Your location is shared every {s.intervalSeconds} seconds while this page stays open, until {s.endTime}{s.endTime < s.startTime ? ' (the end of your night shift)' : ''}. Your managers and HR can see it.</span>
          {msg && <span role="alert" style={{ color: 'var(--danger)' }}>{msg}</span>}
          <div><button className="btn btn-ghost" disabled={stop.isPending} onClick={() => stop.mutate()}>Stop tracking</button></div>
        </>
      ) : (
        <>
          <span className="dim">Tracking runs only between {hoursText(s)}{s.hoursOpenNow ? '' : ' (closed right now)'}. You start it, and you can stop it at any time. Your managers and HR can see where you are while it is on, and your own trail is always visible to you.</span>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I understand what is shared and with whom</label>
          <div><button className="btn btn-primary" disabled={!consent || !s.hoursOpenNow || start.isPending} onClick={() => start.mutate()}>Start tracking</button></div>
        </>
      )}
      <label className="field" style={{ maxWidth: 200 }}><span>My trail for</span><input className="input" type="date" value={day} max={localDay()} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
      {trail.data && (trail.data.points.length > 0 ? <span className="dim" style={{ fontSize: 13 }}>{day === localDay() ? 'Today' : day}: {trail.data.points.length} points · about {trail.data.distanceKm} km</span> : <span className="dim" style={{ fontSize: 13 }}>No points on {day === localDay() ? 'today' : day}.</span>)}
      {trail.data?.points.length > 0 && <Suspense fallback={mapFallback}><TrackMap points={trail.data.points} viewKey={`me-${day}`} name="Your" height={320} /></Suspense>}
    </div>
  )
}

function Live() {
  const live = useQuery({ queryKey: ['tracking-live'], queryFn: async () => (await api.get('/tracking/live')).data.data as any[], refetchInterval: 30_000 })
  const [sel, setSel] = useState<any | null>(null)
  const [day, setDay] = useState(localDay())
  // today's route grows while the person is out, so it is refreshed with the list
  const trail = useQuery({ queryKey: ['trail', sel?.employeeId, day], enabled: !!sel, refetchInterval: day === localDay() ? 30_000 : false, queryFn: async () => (await api.get('/tracking/trail', { params: { employeeId: sel.employeeId, date: day } })).data.data as any })
  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
      <h2 style={{ fontSize: 17 }}>Where the team is</h2>
      {live.data?.length === 0 && <span className="dim">Nobody is sharing their location right now.</span>}
      {live.data?.map((p) => (
        <button key={p.employeeId} type="button" className="btn btn-ghost" style={{ display: 'flex', justifyContent: 'space-between', textAlign: 'left', height: 'auto', minHeight: 46 }} onClick={() => setSel(p)}>
          <span><strong>{p.name}</strong><span className="dim" style={{ display: 'block', fontSize: 13 }}>{p.last ? `Seen ${ago(p.last.at)}` : 'No location yet'}</span></span>
          <span className={`pill ${p.stale ? 'warn' : 'ok'}`}>{p.stale ? 'Not reporting' : 'Live'}</span>
        </button>
      ))}
      {sel && (
        <div style={{ display: 'grid', gap: 8 }}>
          <label className="field" style={{ maxWidth: 200 }}><span>Route for</span><input className="input" type="date" value={day} max={localDay()} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
          <Suspense fallback={mapFallback}><TrackMap points={trail.data?.points ?? []} current={day === localDay() ? sel.last : null} viewKey={`${sel.employeeId}-${day}`} name={sel.name} /></Suspense>
          <span className="dim" style={{ fontSize: 13 }}>{sel.name}: {trail.data ? `${trail.data.points.length} points ${day === localDay() ? 'today' : `on ${day}`}, about ${trail.data.distanceKm} km. ` : ''}Looking at someone's location is logged.</span>
        </div>
      )}
    </div>
  )
}

function Rules({ s }: { s: any }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState({ enabled: false, startTime: '08:00', endTime: '18:00', intervalSeconds: 60, retentionDays: 30 })
  const [ids, setIds] = useState<{ id: string; name: string }[]>([])
  const [term, setTerm] = useState('')
  useEffect(() => { setF({ enabled: s.enabled, startTime: s.startTime, endTime: s.endTime, intervalSeconds: s.intervalSeconds, retentionDays: s.retentionDays }); setIds((s.people ?? []).map((p: any) => ({ id: p.id, name: p.name }))) }, [s])
  const people = useQuery({ queryKey: ['track-people', term], enabled: term.trim().length >= 2, queryFn: async () => (await api.get('/tracking/people', { params: { q: term.trim() } })).data.data as any[], retry: false })
  const save = useMutation({ mutationFn: async () => (await api.put('/tracking/settings', { ...f, employeeIds: ids.map((p) => p.id) })).data.data, onSuccess: () => { toast('Saved'); qc.invalidateQueries({ queryKey: ['tracking-settings'] }) }, onError: (e) => toast(errMsg(e), 'error') })
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' || e.target.inputMode === 'numeric' ? Number(e.target.value) || 0 : e.target.value })
  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 12 }}>
      <h2 style={{ fontSize: 17 }}>Rules</h2>
      <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}><input type="checkbox" checked={f.enabled} onChange={set('enabled')} /> Switch field tracking on</label>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div className="field"><label htmlFor="gp-s">Working hours start</label><input id="gp-s" type="time" className="input" value={f.startTime} onChange={set('startTime')} /></div>
        <div className="field"><label htmlFor="gp-e">End (earlier than the start = night shift)</label><input id="gp-e" type="time" className="input" value={f.endTime} onChange={set('endTime')} /></div>
        <div className="field"><label htmlFor="gp-i">Report every (seconds)</label><input id="gp-i" className="input" inputMode="numeric" value={f.intervalSeconds} onChange={set('intervalSeconds')} /></div>
        <div className="field"><label htmlFor="gp-r">Keep points (days)</label><input id="gp-r" className="input" inputMode="numeric" value={f.retentionDays} onChange={set('retentionDays')} /></div>
      </div>
      <div>
        <span className="dim" style={{ fontSize: 13 }}>Who is tracked (field staff only)</span>
        <div className="chips" style={{ marginTop: 6 }}>{ids.map((p) => <span key={p.id} className="chip is-on">{p.name} <button type="button" className="link" aria-label={`Remove ${p.name}`} onClick={() => setIds(ids.filter((x) => x.id !== p.id))}>×</button></span>)}</div>
        <input className="input" style={{ marginTop: 8 }} placeholder="Add a person: start typing a name" aria-label="Add a person" value={term} onChange={(e) => setTerm(e.target.value)} />
        {people.data?.filter((x) => !ids.some((i) => i.id === x.id)).map((x) => <button key={x.id} type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} onClick={() => { setIds([...ids, { id: x.id, name: x.name }]); setTerm('') }}>{x.name} <span className="dim">{x.code}</span></button>)}
      </div>
      <p className="dim" style={{ margin: 0, fontSize: 13 }}>Reporting happens only inside the working hours and only for the people listed. The web app reports while it is open and awake; background tracking would need a mobile app, which is not built yet.</p>
      <div><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button></div>
    </div>
  )
}

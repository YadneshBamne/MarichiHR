import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import PageHeader from '../../components/ui/PageHeader'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { useWorkLocations } from '../../lib/hooks/useEmployees'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const ago = (iso: string) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago` }
const apiHost = () => { try { return new URL(String(api.defaults.baseURL), window.location.href).host } catch { return window.location.host } }
const STATUS: Record<string, [string, string]> = { applied: ['ok', 'Recorded'], unknown_user: ['warn', 'No one has this ID'], rejected: ['danger', 'Not recorded'], duplicate_tap: ['mute', 'Double tap'], ignored_old: ['mute', 'Too old'], dismissed: ['mute', 'Dismissed'], received: ['mute', 'Received'] }

// Biometric terminals (fingerprint, face or card machines): register them, give each person the ID they use on the machine, and see
// punches that could not be recorded. The fingerprints and faces themselves stay on the machine; only who punched and when comes here.
export default function DevicesPage() {
  const [tab, setTab] = useState<'terminals' | 'people' | 'punches'>('terminals')
  const root = useReveal<HTMLDivElement>(tab)
  const attention = useQuery({ queryKey: ['device-punches', 'attention'], queryFn: async () => (await api.get('/devices/punches', { params: { status: 'attention' } })).data.data as any[], refetchInterval: 60_000 })
  const tabs: [typeof tab, string][] = [['terminals', 'Terminals'], ['people', 'People'], ['punches', attention.data?.length ? `Needs attention (${attention.data.length})` : 'Punches']]
  return (
    <div ref={root}>
      <PageHeader title="Biometric terminals" sub="Fingerprint, face and card machines send punches straight into attendance. The fingerprints and faces stay on the machine.">
        <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14 }}>{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      </PageHeader>
      {tab === 'terminals' ? <Terminals /> : tab === 'people' ? <People /> : <Punches />}
    </div>
  )
}

function Terminals() {
  const toast = useToast()
  const qc = useQueryClient()
  const loc = useWorkLocations()
  const list = useQuery({ queryKey: ['devices'], queryFn: async () => (await api.get('/devices')).data.data as any[], refetchInterval: 30_000 })
  const setup = useQuery({ queryKey: ['devices-setup'], queryFn: async () => (await api.get('/devices/setup')).data.data as any })
  const [f, setF] = useState({ name: '', serial: '', workLocationId: '' })
  const refresh = () => qc.invalidateQueries({ queryKey: ['devices'] })
  const add = useMutation({ mutationFn: async () => (await api.post('/devices', { name: f.name, serial: f.serial, workLocationId: f.workLocationId || null })).data.data, onSuccess: () => { toast('Terminal added. It shows as online once it connects.'); setF({ name: '', serial: '', workLocationId: '' }); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const save = useMutation({ mutationFn: async (d: any) => (await api.put(`/devices/${d.id}`, { name: d.name, workLocationId: d.workLocationId, timezone: d.timezone, active: d.active })).data.data, onSuccess: () => { toast('Saved'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const remove = useMutation({ mutationFn: async (id: string) => (await api.delete(`/devices/${id}`)).data.data, onSuccess: () => { toast('Terminal removed'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const s = setup.data
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="card" style={{ padding: 20, display: 'grid', gap: 8 }}>
        <h2 style={{ fontSize: 17 }}>Connect a terminal</h2>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
          <li>Add the terminal below with the serial number from the label on its back.</li>
          <li>On the terminal open <strong>Menu › Comm. › Cloud Server Setting</strong> (also called ADMS or Push).</li>
          <li>Set the server address to <code>{apiHost()}</code> and the port to <code>443</code>, and switch on HTTPS (and "domain name") if it has those options.</li>
          <li>Give each person the ID they use on the terminal in the People tab.</li>
        </ol>
        {s?.plainHttpReady
          ? <p className="dim" style={{ margin: 0, fontSize: 13 }}>If the terminal has no HTTPS option, use the plain address instead: <code>{s.host}</code>, port <code>{s.port}</code>.</p>
          : <p className="dim" style={{ margin: 0, fontSize: 13 }}>Many terminals can only speak plain http and cannot use the address above. If yours has no HTTPS option, ask your administrator for the plain-http address (it needs to be switched on for the server).</p>}
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>Makes that work this way include ZKTeco, eSSL, Realtime and Matrix. Check the first terminal punches arrive before you buy more.</p>
      </div>
      {list.data?.map((d) => <Row key={d.id} d={d} locations={loc.data ?? []} busy={save.isPending} onSave={(v) => save.mutate({ ...d, ...v })} onRemove={() => { if (window.confirm(`Remove ${d.name}? Punches already recorded stay in attendance.`)) remove.mutate(d.id) }} />)}
      <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
        <h2 style={{ fontSize: 17 }}>Add a terminal</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div className="field"><label htmlFor="dv-n">Name</label><input id="dv-n" className="input" placeholder="Front door" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="dv-s">Serial number</label><input id="dv-s" className="input" placeholder="From the label" value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} /></div>
          <div className="field"><label htmlFor="dv-l">Work location</label>
            <select id="dv-l" className="input" value={f.workLocationId} onChange={(e) => setF({ ...f, workLocationId: e.target.value })}><option value="">Not set</option>{(loc.data ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        </div>
        <div><button className="btn btn-primary" disabled={add.isPending || f.name.trim().length < 2 || f.serial.trim().length < 4} onClick={() => add.mutate()}>{add.isPending ? 'Adding…' : 'Add terminal'}</button></div>
      </div>
    </div>
  )
}

function Row({ d, locations, busy, onSave, onRemove }: { d: any; locations: any[]; busy: boolean; onSave: (v: any) => void; onRemove: () => void }) {
  const [name, setName] = useState(d.name)
  const [loc, setLoc] = useState<string>(d.workLocationId ?? '')
  const state: [string, string] = !d.active ? ['mute', 'Switched off'] : d.online ? ['ok', 'Online'] : d.lastSeenAt ? ['warn', 'Offline'] : ['mute', 'Never connected']
  return (
    <div className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span><strong>{d.name}</strong> <span className="dim">· {d.serial}</span></span>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><span className={`pill ${state[0]}`}>{state[1]}</span><span className="pill mute">{d.punchesToday} punches in 24 h</span></span>
      </div>
      <span className="dim" style={{ fontSize: 13 }}>{d.lastSeenAt ? `Last heard from ${ago(d.lastSeenAt)}` : 'It has not connected yet. Check the terminal settings above.'}{d.lastPunchAt ? ` · last punch ${when(d.lastPunchAt)}` : ''}{d.firmware ? ` · software ${d.firmware}` : ''}</span>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
        <div className="field"><label htmlFor={`n-${d.id}`}>Name</label><input id={`n-${d.id}`} className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor={`l-${d.id}`}>Work location</label><select id={`l-${d.id}`} className="input" value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">Not set</option>{locations.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        <button className="btn btn-primary btn-sm" disabled={busy || name.trim().length < 2} onClick={() => onSave({ name: name.trim(), workLocationId: loc || null })}>Save</button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onSave({ active: !d.active })}>{d.active ? 'Switch off' : 'Switch on'}</button>
        <button className="btn btn-ghost btn-sm" onClick={onRemove}>Remove</button>
      </div>
    </div>
  )
}

function People() {
  const toast = useToast()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Record<string, string>>({})
  const people = useQuery({ queryKey: ['device-people', q], queryFn: async () => (await api.get('/devices/people', { params: { q } })).data.data as any[] })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['device-people'] }); qc.invalidateQueries({ queryKey: ['device-punches'] }) }
  const set = useMutation({ mutationFn: async (v: { id: string; pin: string | null }) => (await api.put(`/devices/people/${v.id}`, { pin: v.pin })).data.data, onSuccess: (r) => { toast(r.applied ? `Saved. ${r.applied} waiting punch${r.applied > 1 ? 'es were' : ' was'} recorded.` : 'Saved'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const codes = useMutation({ mutationFn: async () => (await api.post('/devices/people/use-codes')).data.data, onSuccess: (r) => { toast(`${r.set} IDs set${r.skipped ? `, ${r.skipped} skipped (no number in the code, or already taken)` : ''}`); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="dim" style={{ margin: 0 }}>The ID is the number or code the person enters or is enrolled under on the terminal. A punch from an ID nobody has is kept and recorded once you give that ID to someone.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 240px' }} placeholder="Search by name or code" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-ghost" disabled={codes.isPending} onClick={() => codes.mutate()}>Use employee codes as IDs</button>
      </div>
      {people.data?.length === 0 && <div className="card" style={{ padding: 20 }}>No one found.</div>}
      {people.data?.map((p) => {
        const v = edit[p.id] ?? p.pin ?? ''
        return (
          <div key={p.id} className="card" style={{ padding: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ flex: '1 1 200px' }}><strong>{p.name}</strong><span className="dim" style={{ display: 'block', fontSize: 13 }}>{p.code}</span></span>
            <input className="input" style={{ width: 130 }} aria-label={`Terminal ID for ${p.name}`} placeholder="Terminal ID" value={v} onChange={(e) => setEdit({ ...edit, [p.id]: e.target.value })} />
            <button className="btn btn-primary btn-sm" disabled={set.isPending || !v.trim() || v.trim() === p.pin} onClick={() => set.mutate({ id: p.id, pin: v.trim() })}>Save</button>
            {p.pin && <button className="btn btn-ghost btn-sm" disabled={set.isPending} onClick={() => { setEdit({ ...edit, [p.id]: '' }); set.mutate({ id: p.id, pin: null }) }}>Clear</button>}
          </div>
        )
      })}
    </div>
  )
}

function Punches() {
  const toast = useToast()
  const qc = useQueryClient()
  const [status, setStatus] = useState<'attention' | 'all'>('attention')
  const q = useQuery({ queryKey: ['device-punches', status], queryFn: async () => (await api.get('/devices/punches', { params: { status } })).data.data as any[] })
  const dismiss = useMutation({ mutationFn: async (id: string) => (await api.post(`/devices/punches/${id}/dismiss`)).data.data, onSuccess: () => { toast('Dismissed'); qc.invalidateQueries({ queryKey: ['device-punches'] }) }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 6 }}>{(['attention', 'all'] as const).map((k) => <button key={k} className={`btn btn-sm ${status === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setStatus(k)}>{k === 'attention' ? 'Needs attention' : 'Recent punches'}</button>)}</div>
      {q.data?.length === 0 && <div className="card" style={{ padding: 20 }}>{status === 'attention' ? 'Every punch has been recorded.' : 'No punches yet.'}</div>}
      {q.data?.map((p) => {
        const st = STATUS[p.status] ?? ['mute', p.status]
        return (
          <div key={p.id} className="card" style={{ padding: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ flex: '1 1 240px' }}>
              <strong>{p.employee ?? `ID ${p.pin}`}</strong> <span className="dim">{p.direction ? `clocked ${p.direction} · ` : ''}{when(p.at)} · {p.device}</span>
              {p.reason && <span className="dim" style={{ display: 'block', fontSize: 13 }}>{p.reason}{p.status === 'unknown_user' ? ` Give ID ${p.pin} to someone in the People tab.` : ''}</span>}
            </span>
            <span className={`pill ${st[0]}`}>{st[1]}</span>
            {['unknown_user', 'rejected'].includes(p.status) && <button className="btn btn-ghost btn-sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate(p.id)}>Dismiss</button>}
          </div>
        )
      })}
      <p className="dim" style={{ margin: 0, fontSize: 13 }}>A punch that attendance refused (for example on a locked day) is not recorded. Fix the day with a regularisation or an HR override.</p>
    </div>
  )
}

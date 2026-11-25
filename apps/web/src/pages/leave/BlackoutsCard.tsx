import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useToast } from '../../components/ui/Toast'

// Blackout periods: dates when leave cannot be taken (every type or chosen ones). HR adds, edits and removes them.
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
type Blackout = { id: string; name: string; startDate: string; endDate: string; leaveTypeIds: string[] }
const BLANK = { name: '', startDate: '', endDate: '', leaveTypeIds: [] as string[] }

export default function BlackoutsCard({ types }: { types: { id: string; name: string; active: boolean }[] }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data = [] } = useQuery({ queryKey: ['leave-blackouts'], queryFn: async () => (await api.get('/leave/blackouts')).data.data as Blackout[] })
  const [f, setF] = useState(BLANK)
  const [editing, setEditing] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['leave-blackouts'] })
  const reset = () => { setF(BLANK); setEditing(null) }
  const body = () => ({ name: f.name.trim(), startDate: f.startDate, endDate: f.endDate, leaveTypeIds: f.leaveTypeIds })
  const save = useMutation({
    mutationFn: () => (editing ? api.patch(`/leave/blackouts/${editing}`, body()) : api.post('/leave/blackouts', body())),
    onSuccess: () => { toast(editing ? 'Blackout updated' : 'Blackout added'); reset(); refresh() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const remove = useMutation({ mutationFn: (id: string) => api.post(`/leave/blackouts/${id}/remove`), onSuccess: () => { if (editing) reset(); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const typeName = (id: string) => types.find((t) => t.id === id)?.name ?? 'a leave type'
  const toggle = (id: string) => setF((p) => ({ ...p, leaveTypeIds: p.leaveTypeIds.includes(id) ? p.leaveTypeIds.filter((x) => x !== id) : [...p.leaveTypeIds, id] }))
  const ok = f.name.trim().length >= 2 && !!f.startDate && !!f.endDate && f.endDate >= f.startDate
  return (
    <section data-card className="card" style={{ padding: 18, marginTop: 20, display: 'grid', gap: 12 }}>
      <div><h3 style={{ fontSize: 16 }}>Blackout periods</h3><p className="dim" style={{ fontSize: 13 }}>Dates when leave can't be taken, such as year-end close or a product launch. People see them when applying.</p></div>
      {data.length === 0 && <p className="dim" style={{ fontSize: 13 }}>None set.</p>}
      {data.map((b) => (
        <div key={b.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 8, ...(editing === b.id ? { background: 'var(--well)', borderRadius: 12, padding: 8 } : {}) }}>
          <strong style={{ fontWeight: 500 }}>{b.name}</strong><span className="dim num">{b.startDate} – {b.endDate}</span>
          <span className="pill mute" style={{ textTransform: 'none' }}>{b.leaveTypeIds.length ? b.leaveTypeIds.map(typeName).join(', ') : 'All leave types'}</span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(b.id); setF({ name: b.name, startDate: b.startDate, endDate: b.endDate, leaveTypeIds: b.leaveTypeIds }) }}>Edit</button>
          <button className="btn btn-ghost btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(b.id)}>Remove</button>
        </div>
      ))}
      <div style={{ display: 'grid', gap: 10, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        <strong style={{ fontSize: 13, fontWeight: 600 }}>{editing ? 'Edit this blackout' : 'Add a blackout'}</strong>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label className="field" style={{ flex: '1 1 180px' }}><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} placeholder="Year-end close" /></label>
          <label className="field"><span>From</span><input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
          <label className="field"><span>To</span><input className="input" type="date" min={f.startDate || undefined} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 6 }}>
          <legend className="dim" style={{ fontSize: 12, fontWeight: 500, padding: 0, marginBottom: 6 }}>Leave types it covers (none ticked = every type)</legend>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
            {types.filter((t) => t.active).map((t) => (
              <label key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.leaveTypeIds.includes(t.id)} onChange={() => toggle(t.id)} /> {t.name}</label>
            ))}
          </div>
        </fieldset>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary btn-sm" disabled={save.isPending || !ok} onClick={() => save.mutate()}>{editing ? 'Save changes' : 'Add'}</button>
          {editing && <button className="btn btn-ghost btn-sm" onClick={reset}>Cancel</button>}
        </div>
      </div>
    </section>
  )
}

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useToast } from '../../components/ui/Toast'

// Blackout periods: dates when leave cannot be taken (every type or chosen ones)
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export default function BlackoutsCard({ types }: { types: { id: string; name: string; active: boolean }[] }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data = [] } = useQuery({ queryKey: ['leave-blackouts'], queryFn: async () => (await api.get('/leave/blackouts')).data.data as { id: string; name: string; startDate: string; endDate: string; leaveTypeIds: string[] }[] })
  const [f, setF] = useState({ name: '', startDate: '', endDate: '', leaveTypeIds: [] as string[] })
  const refresh = () => qc.invalidateQueries({ queryKey: ['leave-blackouts'] })
  const add = useMutation({ mutationFn: () => api.post('/leave/blackouts', { ...f, name: f.name.trim() }), onSuccess: () => { toast('Blackout added'); setF({ name: '', startDate: '', endDate: '', leaveTypeIds: [] }); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const remove = useMutation({ mutationFn: (id: string) => api.post(`/leave/blackouts/${id}/remove`), onSuccess: refresh, onError: (e) => toast(errMsg(e), 'error') })
  const typeName = (id: string) => types.find((t) => t.id === id)?.name ?? 'a leave type'
  return (
    <section className="card" style={{ padding: 18, marginTop: 20, display: 'grid', gap: 12 }}>
      <div><h3 style={{ fontSize: 16 }}>Blackout periods</h3><p className="dim" style={{ fontSize: 13 }}>Dates when leave can't be taken, such as year-end close or a product launch. People see them when applying.</p></div>
      {data.map((b) => (
        <div key={b.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <strong style={{ fontWeight: 500 }}>{b.name}</strong><span className="dim num">{b.startDate} – {b.endDate}</span>
          <span className="pill mute">{b.leaveTypeIds.length ? b.leaveTypeIds.map(typeName).join(', ') : 'All leave types'}</span>
          <span style={{ flex: 1 }} /><button className="btn btn-ghost btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(b.id)}>Remove</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '1 1 180px' }}><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} placeholder="Year-end close" /></label>
        <label className="field"><span>From</span><input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
        <label className="field"><span>To</span><input className="input" type="date" min={f.startDate || undefined} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
        <label className="field" style={{ minWidth: 180 }}><span>Leave types</span>
          <select className="input" multiple value={f.leaveTypeIds} onChange={(e) => setF({ ...f, leaveTypeIds: [...e.target.selectedOptions].map((o) => o.value) })} style={{ height: 72 }} aria-label="Leave types (none chosen = all)">
            {types.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <button className="btn btn-primary btn-sm" disabled={add.isPending || f.name.trim().length < 2 || !f.startDate || !f.endDate} onClick={() => add.mutate()}>Add</button>
      </div>
      <p className="dim" style={{ fontSize: 12 }}>No leave type chosen means every type.</p>
    </section>
  )
}

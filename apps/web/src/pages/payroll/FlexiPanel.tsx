import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useToast } from '../../components/ui/Toast'

// Flexi-basket: the person splits their structure's flexi pot across allowed components (Payroll approves); Payroll
// sets which rule is the pot and what it may be split into, and approves choices.
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const ST: Record<string, string> = { submitted: 'warn', approved: 'ok', returned: 'danger' }

export function MyFlexi() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['flexi-mine'], queryFn: async () => (await api.get('/salary/flexi/mine')).data.data })
  const [choices, setChoices] = useState<Record<string, string>>({})
  useEffect(() => { if (data?.choice) setChoices(Object.fromEntries(Object.entries(data.choice.choices as Record<string, number>).map(([k, v]) => [k, String(v)]))) }, [data?.choice])
  const save = useMutation({
    mutationFn: () => api.put('/salary/flexi/mine', { choices: Object.fromEntries(Object.entries(choices).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])) }),
    onSuccess: () => { toast('Sent to Payroll'); qc.invalidateQueries({ queryKey: ['flexi-mine'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  if (!data?.enabled) return null
  const comps = (data.components ?? []) as { code: string; name: string; max: number }[]
  const total = Object.values(choices).reduce((a, v) => a + (Number(v) || 0), 0)
  return (
    <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 10, marginBottom: 'var(--gap)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><h3 style={{ fontSize: 16, flex: 1 }}>My flexi-basket</h3>{data.choice && <span className={`pill ${ST[data.choice.status]}`}>{data.choice.status}</span>}</div>
      <p className="dim" style={{ fontSize: 13 }}>Split your {data.potCode} {data.pot != null ? `(about ${data.pot.toLocaleString()} a month)` : ''} across these components. Anything you don't allocate stays as {data.potCode}. Payroll approves the split; it applies from the next payroll.</p>
      {data.choice?.note && <div className="well" style={{ padding: 10, fontSize: 13 }}><strong>Payroll:</strong> {data.choice.note}</div>}
      {comps.map((c) => <label key={c.code} className="field"><span>{c.name} (up to {c.max.toLocaleString()} a month)</span><input className="input" type="number" min={0} max={c.max} value={choices[c.code] ?? ''} onChange={(e) => setChoices({ ...choices, [c.code]: e.target.value })} /></label>)}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span className="dim" style={{ fontSize: 13, flex: 1 }}>Allocated {total.toLocaleString()}{data.pot != null ? ` of ${data.pot.toLocaleString()}` : ''}</span><button className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>Send to Payroll</button></div>
    </section>
  )
}

export function FlexiAdmin() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: structures = [] } = useQuery({ queryKey: ['salary', 'structures-flexi'], queryFn: async () => (await api.get('/salary/structures')).data.data as any[] })
  const { data: pending = [] } = useQuery({ queryKey: ['flexi-pending'], queryFn: async () => (await api.get('/salary/flexi')).data.data as any[] })
  const [sid, setSid] = useState('')
  const s = structures.find((x) => x.id === sid)
  const [pot, setPot] = useState('')
  const [comps, setComps] = useState<{ code: string; name: string; max: string }[]>([])
  useEffect(() => { if (s) { setPot(s.flexiPotCode ?? ''); setComps(((s.flexiComponents ?? []) as any[]).map((c) => ({ ...c, max: String(c.max) }))) } }, [s])
  const save = useMutation({
    mutationFn: () => api.put(`/salary/structures/${sid}/flexi`, { potCode: pot || null, components: comps.filter((c) => c.code && c.name && Number(c.max) > 0).map((c) => ({ code: c.code.toUpperCase(), name: c.name, max: Number(c.max) })) }),
    onSuccess: () => { toast('Flexi-basket saved'); qc.invalidateQueries({ queryKey: ['salary'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean; note?: string }) => api.post(`/salary/flexi/${v.id}/decide`, { approve: v.approve, ...(v.note && { note: v.note }) }),
    onSuccess: () => { toast('Done'); qc.invalidateQueries({ queryKey: ['flexi-pending'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 16 }}>Set up a flexi-basket</h3>
        <p className="dim" style={{ fontSize: 13 }}>Pick a structure and the rule whose amount people may split (for example a transport or special allowance), then the components they can split it into, each with a monthly limit.</p>
        <select className="input" value={sid} onChange={(e) => setSid(e.target.value)} aria-label="Structure"><option value="">Choose a structure…</option>{structures.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        {s && <>
          <label className="field"><span>Flexi pot (a rule of this structure)</span><select className="input" value={pot} onChange={(e) => setPot(e.target.value)}><option value="">No flexi-basket</option>{(s.rules ?? []).map((r: any) => <option key={r.code} value={r.code}>{r.name} ({r.code})</option>)}</select></label>
          {pot && comps.map((c, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 120px auto', gap: 6 }}>
              <input className="input" placeholder="CODE" value={c.code} onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, code: e.target.value.toUpperCase() } : x)))} />
              <input className="input" placeholder="Name" value={c.name} onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input className="input" type="number" placeholder="Monthly limit" value={c.max} onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, max: e.target.value } : x)))} />
              <button className="btn btn-ghost btn-sm" onClick={() => setComps(comps.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          {pot && comps.length < 10 && <div><button className="btn btn-ghost btn-sm" onClick={() => setComps([...comps, { code: '', name: '', max: '' }])}>+ Component</button></div>}
          <div><button className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>Save</button></div>
        </>}
      </section>
      <section className="card" style={{ padding: 18, display: 'grid', gap: 8 }}>
        <h3 style={{ fontSize: 16 }}>Choices to approve</h3>
        {!pending.length ? <p className="dim" style={{ fontSize: 13 }}>None waiting.</p> : pending.map((p) => (
          <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <span style={{ flex: 1 }}><strong style={{ fontWeight: 500 }}>{p.employee}</strong> · {Object.entries(p.choices as Record<string, number>).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(', ')}</span>
            <button className="btn btn-primary btn-sm" onClick={() => decide.mutate({ id: p.id, approve: true })}>Approve</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { const note = window.prompt('What should change?'); if (note) decide.mutate({ id: p.id, approve: false, note }) }}>Return</button>
          </div>
        ))}
      </section>
    </div>
  )
}

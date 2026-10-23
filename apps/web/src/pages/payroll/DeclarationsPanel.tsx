import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'

// Tax declarations: the person lists what they will invest or claim this year (with proofs); Payroll verifies
interface Section { key: string; label: string; cap: number | null; newRegime: boolean }
interface Item { id?: string; section: string; description: string; amount: number; documentId?: string | null; verifiedAmount?: number | null; status?: string; sectionLabel?: string; appliesToTax?: boolean }
interface Decl { id: string; status: string; items: Item[]; declared: number; verified: number; applied: number; note: string | null; employee?: string; year: number }
const STATUS: Record<string, [string, string]> = { draft: ['mute', 'Draft'], submitted: ['warn', 'Waiting for Payroll'], verified: ['ok', 'Verified'], returned: ['danger', 'Needs changes'] }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
const fyNow = () => { const d = new Date(); return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1 }
const useSections = () => useQuery({ queryKey: ['tax-sections'], queryFn: async () => (await api.get('/tax/declarations/sections')).data.data as Section[] })

export function MyDeclaration() {
  const toast = useToast()
  const qc = useQueryClient()
  const { user } = useAuth()
  const [year, setYear] = useState(fyNow())
  const { data: sections = [] } = useSections()
  const { data: d, isLoading } = useQuery({ queryKey: ['tax-decl', year], queryFn: async () => (await api.get('/tax/declarations/mine', { params: { year } })).data.data as Decl | null })
  const { data: win } = useQuery({ queryKey: ['decl-window', year], queryFn: async () => (await api.get('/tax/declarations/window', { params: { year } })).data.data as { opensOn: string; closesOn: string; open: boolean } | null })
  const [items, setItems] = useState<Item[]>([])
  useEffect(() => { setItems(d?.items ?? []) }, [d])
  const editable = !d || ['draft', 'returned'].includes(d.status)
  const refresh = () => qc.invalidateQueries({ queryKey: ['tax-decl', year] })
  const save = useMutation({
    mutationFn: async () => (await api.put('/tax/declarations/mine', { items: items.map((i) => ({ ...(i.id && { id: i.id }), section: i.section, description: i.description, amount: Number(i.amount), documentId: i.documentId ?? null })) }, { params: { year } })).data.data,
    onSuccess: () => { toast('Saved'); refresh() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const submit = useMutation({
    mutationFn: async () => { await save.mutateAsync(); await api.post('/tax/declarations/mine/submit', null, { params: { year } }) },
    onSuccess: () => { toast('Sent to Payroll'); refresh() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const upload = async (i: number, file: File) => {
    if (!user?.employee?.id) return
    const fd = new FormData()
    fd.append('file', file); fd.append('category', 'other'); fd.append('title', `Tax proof ${year}: ${sections.find((s) => s.key === items[i].section)?.label ?? items[i].section}`)
    try {
      const doc = (await api.post(`/employees/${user.employee.id}/documents`, fd)).data.data
      setItems(items.map((x, j) => (j === i ? { ...x, documentId: doc.id } : x)))
      toast('Proof attached')
    } catch (e) { toast(errMsg(e), 'error') }
  }
  const set = (i: number, patch: Partial<Item>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  return (
    <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field"><span>Financial year starting</span><input className="input" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value) || year)} style={{ width: 120 }} /></label>
        {d && <span className={`pill ${STATUS[d.status][0]}`}>{STATUS[d.status][1]}</span>}
        <span style={{ flex: 1 }} />
        {d && <span className="dim" style={{ fontSize: 13 }}>Declared {n(d.declared)} · verified {n(d.verified)} · used in tax {n(d.applied)}</span>}
      </div>
      {win && <div className={`pill ${win.open ? 'ok' : 'warn'}`} style={{ textTransform: 'none', width: 'fit-content' }}>{win.open ? `Open: submit by ${win.closesOn}` : win.opensOn > new Date().toISOString().slice(0, 10) ? `Opens on ${win.opensOn}` : `Closed on ${win.closesOn}`}</div>}
      {d?.note && <div className="well" style={{ padding: 12, fontSize: 14 }}><strong>Payroll:</strong> {d.note}</div>}
      <p className="dim" style={{ fontSize: 13 }}>Tax is worked out under India's new regime, where only the employer's NPS contribution lowers it. Other sections are recorded and verified for your records.</p>
      {isLoading ? <div className="skeleton" style={{ height: 120, borderRadius: 14 }} /> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {items.map((it, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 2fr) minmax(140px, 1.5fr) 120px auto auto', gap: 6, alignItems: 'center' }}>
              <select className="input" disabled={!editable} value={it.section} onChange={(e) => set(i, { section: e.target.value })} aria-label="Section">{sections.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
              <input className="input" disabled={!editable} value={it.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Details" maxLength={200} aria-label="Details" />
              <input className="input" disabled={!editable} type="number" min={0} value={it.amount || ''} onChange={(e) => set(i, { amount: Number(e.target.value) })} placeholder="Amount" aria-label="Amount" />
              {editable ? <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>{it.documentId ? 'Proof ✓' : 'Attach proof'}<input type="file" hidden accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(i, f); e.target.value = '' }} /></label>
                : <span className={`pill ${it.status === 'accepted' ? 'ok' : it.status === 'rejected' ? 'danger' : 'mute'}`}>{it.status === 'accepted' ? `Verified ${n(it.verifiedAmount)}` : it.status}</span>}
              {editable ? <button className="btn btn-ghost btn-sm" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Remove line">✕</button> : <span />}
            </div>
          ))}
          {editable && <div><button className="btn btn-ghost btn-sm" onClick={() => setItems([...items, { section: sections[0]?.key ?? '80C', description: '', amount: 0 }])}>+ Add a line</button></div>}
        </div>
      )}
      {editable && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" disabled={save.isPending || items.some((i) => !(i.amount > 0))} onClick={() => save.mutate()}>Save draft</button>
          <button className="btn btn-primary" disabled={submit.isPending || !items.length || items.some((i) => !(i.amount > 0))} onClick={() => submit.mutate()}>Send to Payroll</button>
        </div>
      )}
    </section>
  )
}

export function DeclarationReview() {
  const [year, setYear] = useState(fyNow())
  const [open, setOpen] = useState<Decl | null>(null)
  const { data = [], isLoading } = useQuery({ queryKey: ['tax-decls', year], queryFn: async () => (await api.get('/tax/declarations', { params: { year } })).data.data as Decl[] })
  return (
    <section data-card className="card" style={{ padding: 8 }}>
      <div style={{ padding: 10 }}><label className="field"><span>Financial year starting</span><input className="input" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value) || year)} style={{ width: 120 }} /></label></div>
      {isLoading ? <div className="skeleton" style={{ height: 100, borderRadius: 14 }} /> : !data.length ? <p className="dim" style={{ padding: 14 }}>No declarations sent for this year.</p> : (
        <table className="tbl" style={{ width: '100%' }}>
          <thead><tr><th>Employee</th><th className="num">Declared</th><th className="num">Verified</th><th>Status</th><th /></tr></thead>
          <tbody>{data.map((d) => (
            <tr key={d.id}><td>{d.employee}</td><td className="num">{n(d.declared)}</td><td className="num">{n(d.verified)}</td><td><span className={`pill ${STATUS[d.status][0]}`}>{STATUS[d.status][1]}</span></td>
              <td>{d.status === 'submitted' && <button className="btn btn-primary btn-sm" onClick={() => setOpen(d)}>Verify</button>}</td></tr>
          ))}</tbody>
        </table>
      )}
      {open && <Verify d={open} onClose={() => setOpen(null)} />}
    </section>
  )
}

function Verify({ d, onClose }: { d: Decl; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [lines, setLines] = useState(d.items.map((i) => ({ id: i.id!, verifiedAmount: i.amount, status: 'accepted' as 'accepted' | 'rejected' })))
  const [note, setNote] = useState('')
  const act = useMutation({
    mutationFn: (approve: boolean) => api.post(`/tax/declarations/${d.id}/verify`, { approve, ...(note.trim() && { note: note.trim() }), items: approve ? lines : [] }),
    onSuccess: (_r, approve) => { toast(approve ? 'Verified' : 'Returned'); qc.invalidateQueries({ queryKey: ['tax-decls'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const proof = async (documentId: string) => {
    try { window.open((await api.get(`/tax/declarations/${d.id}/proof/${documentId}`)).data.data.url, '_blank', 'noopener') } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <Modal open onClose={onClose} title={`Verify: ${d.employee}`} width={680}>
      <div style={{ display: 'grid', gap: 10 }}>
        {d.items.map((i, k) => (
          <div key={i.id} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 130px', gap: 8, alignItems: 'center' }}>
            <div><div style={{ fontWeight: 500 }}>{i.sectionLabel}</div><div className="dim" style={{ fontSize: 12 }}>{i.description} · declared {n(i.amount)}{i.documentId && <> · <button className="link" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }} onClick={() => proof(i.documentId!)}>view proof</button></>}{!i.appliesToTax && ' · not used in tax'}</div></div>
            <input className="input" type="number" min={0} max={i.amount} value={lines[k].verifiedAmount} onChange={(e) => setLines(lines.map((l, j) => (j === k ? { ...l, verifiedAmount: Number(e.target.value) } : l)))} aria-label="Verified amount" disabled={lines[k].status === 'rejected'} />
            <select className="input" value={lines[k].status} onChange={(e) => setLines(lines.map((l, j) => (j === k ? { ...l, status: e.target.value as any } : l)))} aria-label="Decision"><option value="accepted">Accept</option><option value="rejected">Reject</option></select>
          </div>
        ))}
        <label className="field"><span>Note to the employee</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Needed when returning it" /></label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" disabled={act.isPending || !note.trim()} onClick={() => act.mutate(false)}>Return for changes</button>
          <button className="btn btn-primary" disabled={act.isPending} onClick={() => act.mutate(true)}>Verify</button>
        </div>
      </div>
    </Modal>
  )
}

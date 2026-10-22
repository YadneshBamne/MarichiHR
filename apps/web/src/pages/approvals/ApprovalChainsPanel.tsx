import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useEmployees } from '../../lib/hooks/useEmployees'
import { fmtDate } from '../../lib/format'

// Approval chains on the Approvals page: what is waiting for me at any level (as approver or stand-in), handing my
// approvals to someone while away, HR's monitor of everything pending (with override), and the chains themselves.
interface Pending { requestType: string; requestId: string; employeeId: string; employee: string; summary: string; level: number; of: number; waitingFor: string; approvers: string[]; pendingSince: string; canAct: boolean }
interface Chain { id: string; requestType: string; name: string; priority: number; leaveTypeIds: string[]; minDays: number | null; levels: { kind: string; userId?: string }[]; active: boolean }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const TYPE: Record<string, string> = { leave: 'Leave', regularisation: 'Attendance', overtime: 'Overtime', pre_approval: 'Pre-approval (spend)' }
const KIND: Record<string, string> = { manager: 'Their manager', skip_manager: "Their manager's manager", hr: 'HR', user: 'A named person' }
const since = (iso: string) => { const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000); return h < 24 ? `${h} h` : `${Math.round(h / 24)} d` }
export const usePendingChain = (enabled = true) => useQuery({ queryKey: ['approvals-pending'], enabled, queryFn: async () => (await api.get('/approvals/pending')).data.data as Pending[] })

function useDecide() {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: ({ p, approve, comments, override }: { p: Pending; approve: boolean; comments?: string; override?: boolean }) =>
      api.post(`/approvals/${p.requestType}/${p.requestId}/${override ? 'override' : approve ? 'approve' : 'reject'}`, override ? { approve, comments } : comments ? { comments } : {}),
    onSuccess: (_r, v) => { toast(v.override ? 'Decided' : v.approve ? 'Approved' : 'Rejected'); ['approvals-pending', 'approvals-monitor', 'leave', 'attendance', 'nav-counts'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
}

function Row({ p, mode }: { p: Pending; mode: 'mine' | 'monitor' }) {
  const decide = useDecide()
  const [ask, setAsk] = useState<null | 'reject' | 'approve-override' | 'reject-override'>(null)
  const [note, setNote] = useState('')
  return (
    <div className="well" style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ display: 'grid', gap: 2, fontSize: 13, minWidth: 0 }}>
        <strong style={{ fontWeight: 600 }}><Link className="link" to={`/employees/${p.employeeId}`}>{p.employee}</Link> · {TYPE[p.requestType]}</strong>
        <span>{p.summary}</span>
        <span className="dim">Level {p.level} of {p.of} · waiting for {p.waitingFor}{mode === 'monitor' && p.approvers.length ? ` (${p.approvers.join(', ')})` : ''} · {since(p.pendingSince)}</span>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {p.canAct && <><button className="btn btn-primary btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ p, approve: true })}>Approve</button><button className="btn btn-ghost btn-sm" onClick={() => setAsk('reject')}>Reject</button></>}
        {mode === 'monitor' && <><button className="btn btn-ghost btn-sm" onClick={() => setAsk('approve-override')}>Override: approve</button><button className="btn btn-ghost btn-sm" onClick={() => setAsk('reject-override')}>Override: reject</button></>}
      </div>
      {ask && (
        <Modal open onClose={() => setAsk(null)} title={ask === 'reject' ? 'Reject request' : `Override the chain and ${ask === 'approve-override' ? 'approve' : 'reject'}`}>
          <form onSubmit={(e) => { e.preventDefault(); decide.mutate({ p, approve: ask === 'approve-override', comments: note, override: ask !== 'reject' }); setAsk(null) }} style={{ display: 'grid', gap: 12 }}>
            <label className="field"><span>{ask === 'reject' ? 'Reason' : 'Why are you overriding?'}</span><textarea className="input" rows={3} required minLength={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            {ask !== 'reject' && <span className="dim" style={{ fontSize: 12 }}>The remaining levels are skipped. This is recorded in the audit log.</span>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => setAsk(null)}>Cancel</button><button className="btn btn-primary">Confirm</button></div>
          </form>
        </Modal>
      )}
    </div>
  )
}

export function WaitingForMe() {
  const { data = [], isLoading } = usePendingChain()
  if (isLoading) return <div className="skeleton" style={{ height: 120, borderRadius: 14 }} />
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {!data.length ? <p className="dim" style={{ fontSize: 13 }}>Nothing waiting for you in an approval chain. Requests from your direct reports also appear in the Leave and Attendance tabs.</p> : data.map((p) => <Row key={`${p.requestType}:${p.requestId}`} p={p} mode="mine" />)}
      <Delegations />
    </div>
  )
}

export function Monitor() {
  const { data = [], isLoading } = useQuery({ queryKey: ['approvals-monitor'], queryFn: async () => (await api.get('/approvals/monitor')).data.data as Pending[] })
  if (isLoading) return <div className="skeleton" style={{ height: 120, borderRadius: 14 }} />
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <p className="dim" style={{ fontSize: 13 }}>Every request waiting in an approval chain, oldest first.</p>
      {!data.length ? <p className="dim" style={{ fontSize: 13 }}>Nothing pending.</p> : data.map((p) => <Row key={`${p.requestType}:${p.requestId}`} p={p} mode="monitor" />)}
    </div>
  )
}

function Delegations() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data = [] } = useQuery({ queryKey: ['delegations'], queryFn: async () => (await api.get('/approvals/delegations')).data.data as { id: string; from: string; to: string; startDate: string; endDate: string; reason: string | null; active: boolean }[] })
  const [open, setOpen] = useState(false)
  const end = useMutation({ mutationFn: (id: string) => api.post(`/approvals/delegations/${id}/end`), onSuccess: () => qc.invalidateQueries({ queryKey: ['delegations'] }), onError: (e) => toast(errMsg(e), 'error') })
  const live = data.filter((d) => d.active && d.endDate >= new Date().toISOString().slice(0, 10))
  return (
    <section style={{ marginTop: 14, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><h3 style={{ fontSize: 14 }}>Away? Hand over your approvals</h3><button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}><Icon name="user" size={13} /> Delegate</button></div>
      {live.map((d) => <div key={d.id} className="well" style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', fontSize: 13, gap: 8, flexWrap: 'wrap' }}><span><b>{d.to}</b> approves for <b>{d.from}</b> · {fmtDate(d.startDate)} – {fmtDate(d.endDate)}{d.reason ? ` · ${d.reason}` : ''}</span><button className="btn btn-ghost btn-sm" onClick={() => end.mutate(d.id)}>End</button></div>)}
      {open && <DelegateModal onClose={(ok) => { setOpen(false); if (ok) qc.invalidateQueries({ queryKey: ['delegations'] }) }} />}
    </section>
  )
}

function DelegateModal({ onClose }: { onClose: (ok?: boolean) => void }) {
  const toast = useToast()
  const { data: people } = useEmployees({ limit: 500 })
  const today = new Date().toISOString().slice(0, 10)
  const [f, setF] = useState({ toUserId: '', startDate: today, endDate: today, reason: '' })
  const save = useMutation({ mutationFn: () => api.post('/approvals/delegations', { ...f, reason: f.reason || undefined }), onSuccess: () => { toast('Delegated'); onClose(true) }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <Modal open onClose={() => onClose()} title="Delegate your approvals">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Who approves for you</span><select className="input select" required value={f.toUserId} onChange={(e) => setF({ ...f, toUserId: e.target.value })}><option value="">Choose…</option>{((people?.data ?? []) as any[]).filter((p) => p.userId).map((p) => <option key={p.id} value={p.userId}>{p.firstName} {p.lastName}</option>)}</select></label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label className="field"><span>From</span><input className="input" type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
          <label className="field"><span>Until</span><input className="input" type="date" required min={f.startDate} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
        </div>
        <label className="field"><span>Reason (optional)</span><input className="input" maxLength={200} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Delegate</button></div>
      </form>
    </Modal>
  )
}

export function ChainsSetup() {
  const qc = useQueryClient()
  const { data = [] } = useQuery({ queryKey: ['approval-chains'], queryFn: async () => (await api.get('/approvals/chains')).data.data as Chain[] })
  const { data: types = [] } = useQuery({ queryKey: ['leave-types-all'], queryFn: async () => (await api.get('/leave/types')).data.data as any[] })
  const [edit, setEdit] = useState<Partial<Chain> | null>(null)
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <p className="dim" style={{ fontSize: 13, maxWidth: 640 }}>Without a chain, the direct manager (or HR) approves in one step. A chain sets up to five levels for leave, attendance corrections or overtime; leave chains can apply to chosen leave types or from a number of days.</p>
        <button className="btn btn-primary btn-sm" onClick={() => setEdit({ requestType: 'leave', name: '', priority: 100, leaveTypeIds: [], minDays: null, levels: [{ kind: 'manager' }], active: true })}><Icon name="plus" size={14} /> New chain</button>
      </div>
      {data.map((c) => (
        <div key={c.id} className="well" style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap', opacity: c.active ? 1 : 0.55 }}>
          <div style={{ fontSize: 13, display: 'grid', gap: 2 }}>
            <strong style={{ fontWeight: 600 }}>{c.name} <span className="pill mute">{TYPE[c.requestType]}</span></strong>
            <span>{c.levels.map((l, i) => `${i + 1}. ${KIND[l.kind]}`).join(' → ')}</span>
            {c.requestType === 'leave' && <span className="dim">{c.leaveTypeIds.length ? types.filter((t) => c.leaveTypeIds.includes(t.id)).map((t) => t.name).join(', ') : 'All leave types'}{c.minDays != null ? ` · from ${c.minDays} days` : ''}</span>}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setEdit(c)}>Edit</button>
        </div>
      ))}
      {edit && <ChainModal c={edit} types={types} onClose={(ok) => { setEdit(null); if (ok) qc.invalidateQueries({ queryKey: ['approval-chains'] }) }} />}
    </div>
  )
}

function ChainModal({ c, types, onClose }: { c: Partial<Chain>; types: any[]; onClose: (ok?: boolean) => void }) {
  const toast = useToast()
  const { data: people } = useEmployees({ limit: 500 })
  const [f, setF] = useState<Partial<Chain>>(c)
  const levels = f.levels ?? []
  const setLevel = (i: number, patch: Partial<{ kind: string; userId?: string }>) => setF({ ...f, levels: levels.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
  const save = useMutation({
    mutationFn: () => {
      const body: any = { name: f.name, priority: f.priority, levels: levels.map((l) => (l.kind === 'user' ? { kind: 'user', userId: l.userId } : { kind: l.kind })), active: f.active }
      if (f.requestType === 'leave') { body.leaveTypeIds = f.leaveTypeIds; body.minDays = f.minDays }
      return f.id ? api.patch(`/approvals/chains/${f.id}`, body) : api.post('/approvals/chains', { ...body, requestType: f.requestType })
    },
    onSuccess: () => { toast('Chain saved'); onClose(true) }, onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={() => onClose()} title={f.id ? `Edit ${f.name}` : 'New approval chain'} width={620}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
          <label className="field"><span>For</span><select className="input select" disabled={!!f.id} value={f.requestType} onChange={(e) => setF({ ...f, requestType: e.target.value })}>{Object.entries(TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field"><span>Name</span><input className="input" required minLength={2} value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field"><span>Priority (lower wins)</span><input className="input" type="number" min={0} value={f.priority ?? 100} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })} /></label>
        </div>
        {f.requestType === 'leave' && <>
          <div className="field"><span style={{ fontSize: 12, fontWeight: 500, color: 'var(--dim)' }}>Leave types (none chosen = all)</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{types.map((t) => { const on = f.leaveTypeIds?.includes(t.id); return <button key={t.id} type="button" className="chip" aria-pressed={on} onClick={() => setF({ ...f, leaveTypeIds: on ? f.leaveTypeIds!.filter((x) => x !== t.id) : [...(f.leaveTypeIds ?? []), t.id] })} style={on ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{t.name}</button> })}</div>
          </div>
          <label className="field" style={{ maxWidth: 220 }}><span>Only from (days, optional)</span><input className="input" type="number" min={0} step={0.5} value={f.minDays ?? ''} onChange={(e) => setF({ ...f, minDays: e.target.value === '' ? null : Number(e.target.value) })} /></label>
        </>}
        <div style={{ display: 'grid', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--dim)' }}>Levels, in order</span>
          {levels.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="dim" style={{ width: 20 }}>{i + 1}.</span>
              <select className="input select" style={{ maxWidth: 240 }} value={l.kind} onChange={(e) => setLevel(i, { kind: e.target.value })}>{Object.entries(KIND).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
              {l.kind === 'user' && <select className="input select" style={{ maxWidth: 240 }} required value={l.userId ?? ''} onChange={(e) => setLevel(i, { userId: e.target.value })}><option value="">Choose…</option>{((people?.data ?? []) as any[]).filter((p) => p.userId).map((p) => <option key={p.id} value={p.userId}>{p.firstName} {p.lastName}</option>)}</select>}
              {levels.length > 1 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setF({ ...f, levels: levels.filter((_, j) => j !== i) })}>Remove</button>}
            </div>
          ))}
          {levels.length < 5 && <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setF({ ...f, levels: [...levels, { kind: 'hr' }] })}><Icon name="plus" size={13} /> Add level</button></div>}
        </div>
        {f.id && <label style={{ display: 'flex', gap: 8, fontSize: 14 }}><input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Save chain</button></div>
      </form>
    </Modal>
  )
}

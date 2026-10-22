import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'
import { money, fmtDate } from '../../lib/format'

// Pre-approval: ask before spending (money, travel, accommodation). It goes up the reporting line; once approved,
// Finance sees it and the bills are submitted against it as ordinary claims.
export interface PreRequest { id: string; employee: string; kind: string; purpose: string; justification: string; amount: number; currency: string; destination: string | null; startDate: string | null; endDate: string | null; status: string; decisionNote: string | null; claimed: number; createdAt: string }
const KIND: Record<string, string> = { money: 'Money', travel: 'Travel', accommodation: 'Accommodation' }
const STATUS: Record<string, string> = { pending: 'warn', approved: 'ok', rejected: 'danger', withdrawn: 'mute', closed: 'info' }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export const useMyRequests = () => useQuery({ queryKey: ['pre-requests', 'mine'], queryFn: async () => (await api.get('/expenses/requests')).data.data as PreRequest[] })

export default function RequestsPanel() {
  const { hasRole } = useAuth()
  const finance = hasRole('payroll_admin') || hasRole('hr_admin')
  const [open, setOpen] = useState(false)
  const mine = useMyRequests()
  const waiting = useQuery({ queryKey: ['approvals-pending'], queryFn: async () => ((await api.get('/approvals/pending')).data.data as any[]).filter((p) => p.requestType === 'pre_approval') })
  const fin = useQuery({ queryKey: ['pre-requests', 'finance'], enabled: finance, queryFn: async () => (await api.get('/expenses/requests', { params: { scope: 'finance' } })).data.data as PreRequest[] })
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      <section className="card" style={{ padding: 18, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <p style={{ flex: '1 1 300px', fontSize: 14 }}>Need money, travel or a hotel for work? Ask first: say how much, what for and why. Your manager (and their manager) approve it, then Finance can see it. Afterwards submit the bills against it with “+ New claim”.</p>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Ask for approval</button>
      </section>
      {!!waiting.data?.length && <Section title="Waiting for your approval">{waiting.data.map((p) => <Decide key={p.requestId} p={p} />)}</Section>}
      <Section title="My requests">
        {mine.isLoading ? <div className="skeleton" style={{ height: 80, borderRadius: 14 }} /> : !mine.data?.length ? <p className="dim" style={{ fontSize: 13 }}>No requests yet.</p> : mine.data.map((r) => <Row key={r.id} r={r} mine />)}
      </Section>
      {finance && <Section title="Approved spend (Finance)">{!fin.data?.length ? <p className="dim" style={{ fontSize: 13 }}>Nothing approved yet.</p> : fin.data.map((r) => <Row key={r.id} r={r} finance />)}</Section>}
      {open && <RequestForm onClose={() => setOpen(false)} />}
    </div>
  )
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="card" style={{ padding: 18, display: 'grid', gap: 10 }}><h3 style={{ fontSize: 16 }}>{title}</h3>{children}</section>
)

function Row({ r, mine, finance }: { r: PreRequest; mine?: boolean; finance?: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  const act = useMutation({
    mutationFn: (path: string) => api.post(`/expenses/requests/${r.id}/${path}`, {}),
    onSuccess: (_d, path) => { toast(path === 'close' ? 'Marked as settled' : 'Request withdrawn'); qc.invalidateQueries({ queryKey: ['pre-requests'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: '10px 0', borderTop: '1px solid var(--line)' }}>
      <div style={{ flex: '1 1 280px', minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{KIND[r.kind]}: {r.purpose}{!mine && <span className="dim"> · {r.employee}</span>}</div>
        <div className="dim" style={{ fontSize: 12 }}>
          {r.destination && `${r.destination} · `}{r.startDate && `${fmtDate(r.startDate)} – ${fmtDate(r.endDate)} · `}asked {fmtDate(r.createdAt.slice(0, 10))}
          {r.decisionNote && ` · “${r.decisionNote}”`}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="num" style={{ fontWeight: 600 }}>{money(r.amount, r.currency)}</div>
        {['approved', 'closed'].includes(r.status) && <div className="dim num" style={{ fontSize: 12 }}>bills {money(r.claimed, r.currency)}</div>}
      </div>
      <span className={`pill ${STATUS[r.status] ?? 'mute'}`}>{r.status}</span>
      {mine && r.status === 'pending' && <button className="btn btn-ghost btn-sm" disabled={act.isPending} onClick={() => act.mutate('withdraw')}>Withdraw</button>}
      {finance && r.status === 'approved' && <button className="btn btn-ghost btn-sm" disabled={act.isPending} onClick={() => act.mutate('close')}>Mark settled</button>}
    </div>
  )
}

function Decide({ p }: { p: any }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const act = useMutation({
    mutationFn: (approve: boolean) => api.post(`/approvals/pre_approval/${p.requestId}/${approve ? 'approve' : 'reject'}`, note.trim() ? { comments: note.trim() } : {}),
    onSuccess: (_d, approve) => { toast(approve ? 'Approved' : 'Rejected'); qc.invalidateQueries({ queryKey: ['approvals-pending'] }); qc.invalidateQueries({ queryKey: ['pre-requests'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <div style={{ display: 'grid', gap: 8, padding: '10px 0', borderTop: '1px solid var(--line)' }}>
      <div><strong style={{ fontWeight: 500 }}>{p.employee}</strong> · {p.summary} <span className="dim" style={{ fontSize: 12 }}>(level {p.level} of {p.of})</span></div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 220px' }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Comment (needed to reject)" maxLength={500} />
        <button className="btn btn-primary btn-sm" disabled={act.isPending} onClick={() => act.mutate(true)}>Approve</button>
        <button className="btn btn-ghost btn-sm" disabled={act.isPending || !note.trim()} onClick={() => act.mutate(false)}>Reject</button>
      </div>
    </div>
  )
}

function RequestForm({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { user } = useAuth()
  const [f, setF] = useState({ kind: 'money', purpose: '', justification: '', amount: '', currency: user?.tenant?.baseCurrency || 'ZMW', destination: '', startDate: '', endDate: '' })
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v })
  const trip = f.kind !== 'money'
  const valid = f.purpose.trim().length >= 3 && f.justification.trim().length >= 10 && Number(f.amount) > 0 && /^[A-Z]{3}$/.test(f.currency) && (!trip || (f.destination.trim().length >= 2 && f.startDate && f.endDate && f.endDate >= f.startDate))
  const save = useMutation({
    mutationFn: () => api.post('/expenses/requests', { kind: f.kind, purpose: f.purpose.trim(), justification: f.justification.trim(), amount: Number(f.amount), currency: f.currency, ...(trip && { destination: f.destination.trim(), startDate: f.startDate, endDate: f.endDate }) }),
    onSuccess: () => { toast('Sent for approval'); qc.invalidateQueries({ queryKey: ['pre-requests'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={onClose} title="Ask for approval" width={560}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div className="seg" role="tablist" style={{ display: 'flex', gap: 6 }}>
          {Object.entries(KIND).map(([k, l]) => <button key={k} type="button" className={`btn btn-sm ${f.kind === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => set('kind', k)}>{l}</button>)}
        </div>
        <label className="field"><span>What is it for?</span><input className="input" value={f.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder={trip ? 'e.g. Client visit in Lusaka' : 'e.g. Laptop for the new designer'} maxLength={200} /></label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 10 }}>
          <label className="field"><span>Amount needed</span><input className="input" type="number" min={0} value={f.amount} onChange={(e) => set('amount', e.target.value)} /></label>
          <label className="field"><span>Currency</span><input className="input" maxLength={3} value={f.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} /></label>
        </div>
        {trip && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <label className="field"><span>{f.kind === 'travel' ? 'Destination' : 'City / hotel'}</span><input className="input" value={f.destination} onChange={(e) => set('destination', e.target.value)} maxLength={120} /></label>
            <label className="field"><span>From</span><input className="input" type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></label>
            <label className="field"><span>To</span><input className="input" type="date" min={f.startDate || undefined} value={f.endDate} onChange={(e) => set('endDate', e.target.value)} /></label>
          </div>
        )}
        <label className="field"><span>Why is it needed?</span><textarea className="input" rows={3} value={f.justification} onChange={(e) => set('justification', e.target.value)} style={{ height: 'auto', padding: 10 }} maxLength={2000} placeholder="What happens if it isn't approved, and why this amount" /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>Send for approval</button></div>
      </div>
    </Modal>
  )
}

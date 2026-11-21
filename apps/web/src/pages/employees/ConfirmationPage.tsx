import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

const STATUS: Record<string, [string, string]> = { manager_review: ['warn', 'Waiting for the manager'], hr_decision: ['info', 'Waiting for HR'], in_review: ['info', 'In review'], closed: ['ok', 'Decided'] }
const OUTCOME: Record<string, string> = { confirmed: 'Confirmed', extended: 'Probation extended', not_confirmed: 'Not confirmed' }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const today = () => new Date().toISOString().slice(0, 10)

// Probation confirmation: HR opens a review, the manager rates and recommends, HR decides.
export default function ConfirmationPage() {
  const { hasRole } = useAuth()
  const hr = hasRole('hr_admin') || hasRole('system_admin')
  const [tab, setTab] = useState<'cases' | 'due'>('cases')
  const [open, setOpen] = useState<string | null>(null)
  const root = useReveal<HTMLDivElement>(tab + (open ?? ''))
  const cases = useQuery({ queryKey: ['conf-cases'], retry: false, queryFn: async () => (await api.get('/confirmation/cases')).data.data as any[] })
  const blocked = (cases.error as any)?.response?.data?.code === 'NOT_IN_PLAN'
  if (blocked) return (
    <div ref={root}><PageHeader title="Confirmations" sub="Probation reviews and confirmation." />
      <div className="card" style={{ padding: 24 }}><p style={{ marginTop: 0 }}>The confirmation workflow is not part of your company's plan.</p>{hasRole('system_admin') ? <Link className="btn btn-primary" to="/settings/plan">Change the plan</Link> : <p>Ask a system admin to add it.</p>}</div></div>
  )
  return (
    <div ref={root}>
      <PageHeader title="Confirmations" sub="Probation reviews: the manager rates and recommends, HR makes the final call.">
        {hr && (
          <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14 }}>
            {([['cases', 'Reviews'], ['due', 'Due soon']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab(k); setOpen(null) }}>{l}</button>)}
          </div>
        )}
      </PageHeader>
      {tab === 'due' && hr ? <Due onStarted={(id) => { setTab('cases'); setOpen(id) }} /> : open ? <Case id={open} hr={hr} onBack={() => setOpen(null)} /> : (
        <div className="card" style={{ padding: 8 }}>
          {cases.data?.length === 0 && <p style={{ padding: 16, margin: 0 }}>No reviews yet.</p>}
          {cases.data?.map((c) => (
            <button key={c.id} type="button" className="btn btn-ghost" onClick={() => setOpen(c.id)} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 12, textAlign: 'left', height: 'auto', minHeight: 56, padding: '10px 14px', borderRadius: 16, border: 0 }}>
              <span><strong>{c.employeeName}</strong> <span style={{ opacity: 0.7 }}>{c.employeeCode}</span></span>
              <span className={`pill ${c.decision ? 'ok' : STATUS[c.status]?.[0] ?? 'mute'}`}>{c.decision ? OUTCOME[c.decision.outcome] : STATUS[c.status]?.[1] ?? c.status}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Due({ onStarted }: { onStarted: (id: string) => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const due = useQuery({ queryKey: ['conf-due'], queryFn: async () => (await api.get('/confirmation/due')).data.data as any[] })
  const start = useMutation({ mutationFn: async (employeeId: string) => (await api.post('/confirmation/cases', { employeeId })).data.data, onSuccess: (c) => { qc.invalidateQueries({ queryKey: ['conf-cases'] }); qc.invalidateQueries({ queryKey: ['conf-due'] }); onStarted(c.id) }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div className="card" style={{ padding: 8 }}>
      {due.data?.length === 0 && <p style={{ padding: 16, margin: 0 }}>Nobody's probation ends in the next 90 days.</p>}
      {due.data?.map((d) => (
        <div key={d.employeeId} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 14px', minHeight: 56 }}>
          <div style={{ flex: 1 }}><strong>{d.name}</strong> <span style={{ opacity: 0.7 }}>{d.code}</span><div style={{ fontSize: 13, opacity: 0.7 }}>Probation ends {d.probationEndDate} · {d.daysLeft < 0 ? `${-d.daysLeft} days ago` : `in ${d.daysLeft} days`}{d.hasManager ? '' : ' · no manager, goes straight to HR'}</div></div>
          <button className="btn btn-primary btn-sm" disabled={start.isPending} onClick={() => start.mutate(d.employeeId)}>Start review</button>
        </div>
      ))}
    </div>
  )
}

function Case({ id, hr, onBack }: { id: string; hr: boolean; onBack: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: c } = useQuery({ queryKey: ['conf-case', id], queryFn: async () => (await api.get(`/confirmation/cases/${id}`)).data.data })
  const done = () => { qc.invalidateQueries({ queryKey: ['conf-case', id] }); qc.invalidateQueries({ queryKey: ['conf-cases'] }); qc.invalidateQueries({ queryKey: ['conf-due'] }) }
  const [rv, setRv] = useState({ rating: 3, strengths: '', concerns: '', recommendation: 'confirm', extensionMonths: 3 })
  const [dc, setDc] = useState({ outcome: 'confirmed', note: '', newEndDate: '' })
  const review = useMutation({ mutationFn: async () => api.post(`/confirmation/cases/${id}/review`, { ...rv, extensionMonths: rv.recommendation === 'extend' ? rv.extensionMonths : undefined }), onSuccess: () => { toast('Review sent to HR'); done() }, onError: (e) => toast(errMsg(e), 'error') })
  const decide = useMutation({ mutationFn: async () => (await api.post(`/confirmation/cases/${id}/decide`, { outcome: dc.outcome, note: dc.note, newEndDate: dc.outcome === 'extended' ? dc.newEndDate : undefined })).data.data, onSuccess: (r) => { toast(r.nextStep ?? 'Decision recorded'); done() }, onError: (e) => toast(errMsg(e), 'error') })
  if (!c) return <p>Loading…</p>
  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 16 }}>
      <div><button className="btn btn-ghost btn-sm" onClick={onBack}>Back</button></div>
      <h2 style={{ margin: 0 }}>{c.employeeName} <span style={{ fontSize: 15, opacity: 0.7 }}>{c.employeeCode}</span></h2>
      <p style={{ margin: 0 }}>Probation ends {String(c.probationEndDate).slice(0, 10)} · <span className={`pill ${STATUS[c.status]?.[0] ?? 'mute'}`}>{STATUS[c.status]?.[1] ?? c.status}</span></p>
      {c.review && (
        <div style={{ padding: 16, borderRadius: 20, border: '1.5px solid var(--line-2)' }}>
          <strong>Manager's review: {c.review.rating}/5, recommends {String(c.review.recommendation).replace('_', ' ')}{c.review.extensionMonths ? ` for ${c.review.extensionMonths} months` : ''}</strong>
          <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>Strengths: {c.review.strengths}</p>
          {c.review.concerns && <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>Concerns: {c.review.concerns}</p>}
        </div>
      )}
      {c.decision && <p style={{ margin: 0 }}><strong>{OUTCOME[c.decision.outcome]}</strong>{c.decision.newEndDate ? ` until ${c.decision.newEndDate}` : ''}{c.decision.note ? `: ${c.decision.note}` : ''}</p>}
      {c.canReview && (
        <div style={{ display: 'grid', gap: 12 }}>
          <strong>Manager's review</strong>
          <div className="field"><label htmlFor="cf-rate">Overall rating (1 to 5)</label><input id="cf-rate" className="input" type="number" min={1} max={5} value={rv.rating} onChange={(e) => setRv({ ...rv, rating: Number(e.target.value) })} /></div>
          <div className="field"><label htmlFor="cf-str">Strengths</label><textarea id="cf-str" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={rv.strengths} onChange={(e) => setRv({ ...rv, strengths: e.target.value })} /></div>
          <div className="field"><label htmlFor="cf-con">Concerns</label><textarea id="cf-con" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={rv.concerns} onChange={(e) => setRv({ ...rv, concerns: e.target.value })} /></div>
          <div className="field"><label htmlFor="cf-rec">Recommendation</label>
            <select id="cf-rec" className="input" value={rv.recommendation} onChange={(e) => setRv({ ...rv, recommendation: e.target.value })}><option value="confirm">Confirm</option><option value="extend">Extend probation</option><option value="not_confirm">Do not confirm</option></select></div>
          {rv.recommendation === 'extend' && <div className="field"><label htmlFor="cf-ext">Extend by (months)</label><input id="cf-ext" className="input" type="number" min={1} max={12} value={rv.extensionMonths} onChange={(e) => setRv({ ...rv, extensionMonths: Number(e.target.value) })} /></div>}
          <div><button className="btn btn-primary" disabled={review.isPending || rv.strengths.trim().length < 3} onClick={() => review.mutate()}>Send to HR</button></div>
        </div>
      )}
      {hr && c.status === 'hr_decision' && (
        <div style={{ display: 'grid', gap: 12 }}>
          <strong>HR decision</strong>
          <div className="field"><label htmlFor="cf-out">Outcome</label>
            <select id="cf-out" className="input" value={dc.outcome} onChange={(e) => setDc({ ...dc, outcome: e.target.value })}><option value="confirmed">Confirm</option><option value="extended">Extend probation</option><option value="not_confirmed">Do not confirm</option></select></div>
          {dc.outcome === 'extended' && <div className="field"><label htmlFor="cf-end">New probation end date</label><input id="cf-end" className="input" type="date" min={today()} value={dc.newEndDate} onChange={(e) => setDc({ ...dc, newEndDate: e.target.value })} /></div>}
          <div className="field"><label htmlFor="cf-note">Note{dc.outcome === 'confirmed' ? ' (optional)' : ''}</label><textarea id="cf-note" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={dc.note} onChange={(e) => setDc({ ...dc, note: e.target.value })} /></div>
          <div><button className="btn btn-primary" disabled={decide.isPending || (dc.outcome !== 'confirmed' && !dc.note.trim()) || (dc.outcome === 'extended' && !dc.newEndDate)} onClick={() => decide.mutate()}>Record decision</button></div>
        </div>
      )}
    </div>
  )
}

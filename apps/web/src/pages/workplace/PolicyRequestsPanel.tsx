import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'

// Policy questions (HR answers within 3 days) and exception requests (manager, then HR, through the approval chain)
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const QS: Record<string, string> = { open: 'warn', answered: 'ok', closed: 'mute' }
const XS: Record<string, string> = { pending: 'warn', approved: 'ok', rejected: 'danger', withdrawn: 'mute' }
const usePolicies = () => useQuery({ queryKey: ['policies'], queryFn: async () => (await api.get('/policies')).data.data as { id: string; title: string }[] })

export function PolicyQueries({ hr }: { hr: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: policies = [] } = usePolicies()
  const [scope, setScope] = useState<'mine' | 'all'>(hr ? 'all' : 'mine')
  const [f, setF] = useState({ policyId: '', question: '' })
  const [answering, setAnswering] = useState<any>(null)
  const { data = [], isLoading } = useQuery({ queryKey: ['policy-queries', scope], queryFn: async () => (await api.get('/policies/queries', { params: { scope } })).data.data as any[] })
  const ask = useMutation({
    mutationFn: () => api.post('/policies/queries', { question: f.question.trim(), ...(f.policyId && { policyId: f.policyId }) }),
    onSuccess: () => { toast('Sent to HR'); setF({ policyId: '', question: '' }); qc.invalidateQueries({ queryKey: ['policy-queries'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 16 }}>Ask HR about a policy</h3>
        <select className="input" value={f.policyId} onChange={(e) => setF({ ...f, policyId: e.target.value })} aria-label="Policy"><option value="">General question</option>{policies.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        <textarea className="input" rows={3} value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} placeholder="Your question" style={{ height: 'auto', padding: 12 }} maxLength={2000} />
        <div><button className="btn btn-primary btn-sm" disabled={ask.isPending || f.question.trim().length < 5} onClick={() => ask.mutate()}>Ask</button> <span className="dim" style={{ fontSize: 12 }}>HR aims to answer within 3 days.</span></div>
      </section>
      <section data-card className="card" style={{ padding: 8 }}>
        {hr && <div className="chips" style={{ padding: 8 }}>{(['all', 'mine'] as const).map((s) => <button key={s} className={`chip${scope === s ? ' is-on' : ''}`} onClick={() => setScope(s)}>{s === 'all' ? 'Everyone' : 'Mine'}</button>)}</div>}
        {isLoading ? <div className="skeleton" style={{ height: 100, borderRadius: 14 }} /> : !data.length ? <p className="dim" style={{ padding: 14 }}>No questions yet.</p> : data.map((q) => (
          <div key={q.id} style={{ padding: 12, borderBottom: '1px solid var(--line)', display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><span className={`pill ${QS[q.status]}`}>{q.status}</span>{q.overdue && <span className="pill danger">Overdue</span>}{q.policy && <span className="pill mute">{q.policy}</span>}<span className="dim" style={{ fontSize: 12 }}>{scope === 'all' ? `${q.askedBy} · ` : ''}{when(q.createdAt)}</span></div>
            <p style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{q.question}</p>
            {q.answer && <div className="well" style={{ padding: 10, fontSize: 14 }}><strong>{q.answeredByName ?? 'HR'}:</strong> {q.answer}</div>}
            {hr && scope === 'all' && q.status !== 'closed' && <div><button className="btn btn-ghost btn-sm" onClick={() => setAnswering(q)}>{q.answer ? 'Update answer' : 'Answer'}</button></div>}
          </div>
        ))}
      </section>
      {answering && <Answer q={answering} onClose={() => setAnswering(null)} />}
    </div>
  )
}

function Answer({ q, onClose }: { q: any; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [answer, setAnswer] = useState(q.answer ?? '')
  const save = useMutation({
    mutationFn: (close: boolean) => api.post(`/policies/queries/${q.id}/answer`, { answer: answer.trim(), close }),
    onSuccess: () => { toast('Answer sent'); qc.invalidateQueries({ queryKey: ['policy-queries'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={onClose} title="Answer the question">
      <div style={{ display: 'grid', gap: 10 }}>
        <p style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{q.question}</p>
        <textarea className="input" rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} style={{ height: 'auto', padding: 12 }} maxLength={5000} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" disabled={save.isPending || answer.trim().length < 2} onClick={() => save.mutate(false)}>Answer</button>
          <button className="btn btn-primary" disabled={save.isPending || answer.trim().length < 2} onClick={() => save.mutate(true)}>Answer and close</button>
        </div>
      </div>
    </Modal>
  )
}

export function PolicyExceptions({ hr }: { hr: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: policies = [] } = usePolicies()
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [f, setF] = useState({ policyId: '', request: '', reason: '', startDate: '', endDate: '' })
  const { data = [], isLoading } = useQuery({ queryKey: ['policy-exceptions', scope], queryFn: async () => (await api.get('/policies/exceptions', { params: { scope } })).data.data as any[] })
  const refresh = () => qc.invalidateQueries({ queryKey: ['policy-exceptions'] })
  const ask = useMutation({
    mutationFn: () => api.post('/policies/exceptions', { policyId: f.policyId, request: f.request.trim(), reason: f.reason.trim(), ...(f.startDate && { startDate: f.startDate }), ...(f.endDate && { endDate: f.endDate }) }),
    onSuccess: () => { toast('Sent for approval'); setF({ policyId: '', request: '', reason: '', startDate: '', endDate: '' }); refresh() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const withdraw = useMutation({ mutationFn: (id: string) => api.post(`/policies/exceptions/${id}/withdraw`), onSuccess: () => { toast('Withdrawn'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 16 }}>Ask for an exception</h3>
        <select className="input" value={f.policyId} onChange={(e) => setF({ ...f, policyId: e.target.value })} aria-label="Policy"><option value="">Which policy?</option>{policies.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        <input className="input" value={f.request} onChange={(e) => setF({ ...f, request: e.target.value })} placeholder="What should be different for you?" maxLength={500} />
        <textarea className="input" rows={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Why?" style={{ height: 'auto', padding: 12 }} maxLength={2000} />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label className="field"><span>From (optional)</span><input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
          <label className="field"><span>Until (optional)</span><input className="input" type="date" min={f.startDate || undefined} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
        </div>
        <div><button className="btn btn-primary btn-sm" disabled={ask.isPending || !f.policyId || f.request.trim().length < 5 || f.reason.trim().length < 10} onClick={() => ask.mutate()}>Send for approval</button> <span className="dim" style={{ fontSize: 12 }}>Your manager, then HR, decide it under Approvals.</span></div>
      </section>
      <section data-card className="card" style={{ padding: 8 }}>
        {hr && <div className="chips" style={{ padding: 8 }}>{(['mine', 'all'] as const).map((s) => <button key={s} className={`chip${scope === s ? ' is-on' : ''}`} onClick={() => setScope(s)}>{s === 'all' ? 'Everyone' : 'Mine'}</button>)}</div>}
        {isLoading ? <div className="skeleton" style={{ height: 100, borderRadius: 14 }} /> : !data.length ? <p className="dim" style={{ padding: 14 }}>No exception requests.</p> : data.map((x) => (
          <div key={x.id} style={{ padding: 12, borderBottom: '1px solid var(--line)', display: 'grid', gap: 4 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><span className={`pill ${XS[x.status]}`}>{x.status}</span><span className="pill mute">{x.policy}</span>{scope === 'all' && <span className="dim" style={{ fontSize: 12 }}>{x.employee}</span>}{x.startDate && <span className="dim" style={{ fontSize: 12 }}>{x.startDate} – {x.endDate ?? 'open'}</span>}</div>
            <strong style={{ fontWeight: 500 }}>{x.request}</strong>
            <span className="dim" style={{ fontSize: 13 }}>{x.reason}</span>
            {x.trail?.length > 0 && <span className="dim" style={{ fontSize: 12 }}>{x.trail.map((t: any) => `${t.waitingFor}: ${t.status}${t.by ? ` (${t.by})` : ''}`).join(' → ')}</span>}
            {x.decisionNote && <span style={{ fontSize: 13 }}>“{x.decisionNote}”</span>}
            {scope === 'mine' && x.status === 'pending' && <div><button className="btn btn-ghost btn-sm" disabled={withdraw.isPending} onClick={() => withdraw.mutate(x.id)}>Withdraw</button></div>}
          </div>
        ))}
      </section>
    </div>
  )
}

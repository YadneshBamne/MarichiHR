import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import ReasonModal from '../../components/ui/ReasonModal'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { fmtDate } from '../../lib/format'
import { downloadCsv } from '../../lib/hooks/usePayroll'

const STATUS: Record<string, [string, string]> = { manager_review: ['warn', 'Waiting for the manager'], hr_decision: ['info', 'Waiting for HR'], in_review: ['info', 'In review'], closed: ['ok', 'Decided'] }
const OUTCOME: Record<string, string> = { confirmed: 'Confirmed', extended: 'Probation extended', not_confirmed: 'Not confirmed', cancelled: 'Cancelled by HR' }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const today = () => new Date().toISOString().slice(0, 10)

// Probation confirmation: HR opens a review, the manager rates and recommends, HR decides. Everyone is told at each step; the person only ever sees the outcome.
export default function ConfirmationPage() {
  const { hasRole } = useAuth()
  const hr = hasRole('hr_admin') || hasRole('system_admin')
  const manager = hasRole('manager')
  const [tab, setTab] = useState<'cases' | 'due' | 'letters'>('cases')
  const [open, setOpen] = useState<string | null>(null)
  const root = useReveal<HTMLDivElement>(tab + (open ?? ''))
  const cases = useQuery({ queryKey: ['conf-cases'], retry: false, queryFn: async () => (await api.get('/confirmation/cases')).data.data as any[] })
  const blocked = (cases.error as any)?.response?.data?.code === 'NOT_IN_PLAN'
  if (blocked) return (
    <div ref={root}><PageHeader title="Confirmations" sub="Probation reviews and confirmation." />
      <div className="card" style={{ padding: 24 }}><p style={{ marginTop: 0 }}>The confirmation workflow is not part of your company's plan.</p>{hasRole('system_admin') ? <Link className="btn btn-primary" to="/settings/plan">Change the plan</Link> : <p>Ask a system admin to add it.</p>}</div></div>
  )
  const tabs: [typeof tab, string][] = [['cases', 'Reviews'], ...(hr || manager ? [['due', 'Due soon'] as [typeof tab, string]] : []), ...(hr ? [['letters', 'Letters'] as [typeof tab, string]] : [])]
  return (
    <div ref={root}>
      <PageHeader title="Confirmations" sub="Probation reviews: the manager rates and recommends, HR makes the final call.">
        {tabs.length > 1 && (
          <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14 }}>
            {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab(k); setOpen(null) }}>{l}</button>)}
          </div>
        )}
      </PageHeader>
      {tab === 'due' ? <Due hr={hr} onStarted={(id) => { setTab('cases'); setOpen(id) }} /> : tab === 'letters' ? <Letters /> : open ? <Case id={open} hr={hr} onBack={() => setOpen(null)} /> : (
        <div className="card" style={{ padding: 8 }}>
          {cases.isLoading && <p style={{ padding: 16, margin: 0 }}>Loading…</p>}
          {cases.isError && <div style={{ padding: 16, display: 'grid', gap: 8 }}><span>The reviews could not be loaded.</span><div><button className="btn btn-primary btn-sm" onClick={() => cases.refetch()}>Try again</button></div></div>}
          {cases.data?.length === 0 && <p style={{ padding: 16, margin: 0 }}>No reviews yet.</p>}
          {cases.data?.map((c) => (
            <button key={c.id} type="button" className="btn btn-ghost" onClick={() => setOpen(c.id)} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 12, textAlign: 'left', height: 'auto', minHeight: 56, padding: '10px 14px', borderRadius: 16, border: 0 }}>
              <span><strong>{c.employeeName}</strong> <span className="dim">{c.employeeCode}</span></span>
              <span className={`pill ${c.decision ? 'ok' : STATUS[c.status]?.[0] ?? 'mute'}`}>{c.decision ? OUTCOME[c.decision.outcome] : STATUS[c.status]?.[1] ?? c.status}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Due({ hr, onStarted }: { hr: boolean; onStarted: (id: string) => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const due = useQuery({ queryKey: ['conf-due'], queryFn: async () => (await api.get('/confirmation/due')).data.data as any[] })
  const start = useMutation({ mutationFn: async (employeeId: string) => (await api.post('/confirmation/cases', { employeeId })).data.data, onSuccess: (c) => { qc.invalidateQueries({ queryKey: ['conf-cases'] }); qc.invalidateQueries({ queryKey: ['conf-due'] }); onStarted(c.id) }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div className="card" style={{ padding: 8 }}>
      {!hr && <p className="dim" style={{ margin: '8px 14px', fontSize: 13 }}>These are your own people whose probation is ending. HR opens the review and you will be asked to rate them.</p>}
      {due.isError && <div style={{ padding: 16, display: 'grid', gap: 8 }}><span>This list could not be loaded.</span><div><button className="btn btn-primary btn-sm" onClick={() => due.refetch()}>Try again</button></div></div>}
      {due.data?.length === 0 && <p style={{ padding: 16, margin: 0 }}>{hr ? 'Nobody\'s probation ends in the next 90 days.' : 'None of your people are due soon.'}</p>}
      {due.data?.map((d) => (
        <div key={d.employeeId} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 14px', minHeight: 56 }}>
          <div style={{ flex: 1 }}><strong>{d.name}</strong> <span className="dim">{d.code}</span><div className="dim" style={{ fontSize: 13 }}>Probation ends {fmtDate(d.probationEndDate)} · {d.daysLeft < 0 ? `${-d.daysLeft} days ago` : d.daysLeft === 0 ? 'today' : `in ${d.daysLeft} days`}{d.hasManager ? '' : ' · no manager, goes straight to HR'}</div></div>
          {d.canStart && <button className="btn btn-primary btn-sm" disabled={start.isPending} onClick={() => start.mutate(d.employeeId)}>Start review</button>}
        </div>
      ))}
    </div>
  )
}

function Case({ id, hr, onBack }: { id: string; hr: boolean; onBack: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['conf-case', id], retry: false, queryFn: async () => (await api.get(`/confirmation/cases/${id}`)).data.data })
  const c = q.data
  const done = () => { qc.invalidateQueries({ queryKey: ['conf-case', id] }); qc.invalidateQueries({ queryKey: ['conf-cases'] }); qc.invalidateQueries({ queryKey: ['conf-due'] }) }
  const [rv, setRv] = useState({ rating: 3, strengths: '', concerns: '', recommendation: 'confirm', extensionMonths: 3, onBehalfReason: '' })
  const [dc, setDc] = useState({ outcome: 'confirmed', note: '', newEndDate: '' })
  const [ask, setAsk] = useState<null | 'cancel' | 'early'>(null)
  const [reassign, setReassign] = useState(false)
  const [term, setTerm] = useState('')
  // the extension the manager recommended arrives as a date in HR's box
  useEffect(() => { if (c?.suggestedEndDate) setDc((d) => (d.newEndDate ? d : { ...d, outcome: c.review?.recommendation === 'extend' ? 'extended' : d.outcome, newEndDate: c.suggestedEndDate })) }, [c?.suggestedEndDate]) // eslint-disable-line react-hooks/exhaustive-deps
  const people = useQuery({ queryKey: ['conf-people', term], enabled: reassign && term.trim().length >= 2, queryFn: async () => (await api.get('/employees', { params: { search: term.trim(), limit: 8 } })).data.data as any[] })
  const review = useMutation({ mutationFn: async () => api.post(`/confirmation/cases/${id}/review`, { rating: rv.rating, strengths: rv.strengths, concerns: rv.concerns, recommendation: rv.recommendation, extensionMonths: rv.recommendation === 'extend' ? rv.extensionMonths : undefined, ...(!c?.canReview && c?.canReviewOnBehalf && { onBehalfReason: rv.onBehalfReason.trim() }) }), onSuccess: () => { toast('Review sent to HR'); done() }, onError: (e) => toast(errMsg(e), 'error') })
  const decide = useMutation({ mutationFn: async (ackEarly?: boolean) => (await api.post(`/confirmation/cases/${id}/decide`, { outcome: dc.outcome, note: dc.note, newEndDate: dc.outcome === 'extended' ? dc.newEndDate : undefined, ...(ackEarly && { ackEarly: true }) })).data.data, onSuccess: (r) => { setAsk(null); toast(r.nextStep ?? 'Decision recorded'); done() }, onError: (e: any) => { if (e?.response?.data?.code === 'EARLY_CONFIRMATION') setAsk('early'); else toast(errMsg(e), 'error') } })
  const cancel = useMutation({ mutationFn: async (reason: string) => (await api.post(`/confirmation/cases/${id}/cancel`, { reason })).data.data, onSuccess: () => { setAsk(null); toast('Review cancelled'); done(); onBack() }, onError: (e) => toast(errMsg(e), 'error') })
  const hand = useMutation({ mutationFn: async (v: { managerEmployeeId: string; reason: string }) => (await api.post(`/confirmation/cases/${id}/reassign`, v)).data.data, onSuccess: (r) => { setReassign(false); setTerm(''); toast(`Handed to ${r.reviewer}`); done() }, onError: (e) => toast(errMsg(e), 'error') })
  const [pick, setPick] = useState<{ id: string; name: string } | null>(null)
  const [why, setWhy] = useState('')
  if (q.isError) return <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}><span>This review could not be loaded.</span><div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" onClick={() => q.refetch()}>Try again</button><button className="btn btn-ghost btn-sm" onClick={onBack}>Back</button></div></div>
  if (!c) return <p>Loading…</p>
  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>Back</button>
        {c.letterAvailable && <button className="btn btn-primary btn-sm" onClick={() => downloadCsv(`/confirmation/cases/${id}/letter`)}>Download the letter (PDF)</button>}
        {hr && c.status !== 'closed' && <button className="btn btn-ghost btn-sm" onClick={() => setAsk('cancel')}>Cancel this review</button>}
      </div>
      <h2 style={{ margin: 0 }}>{c.employeeName} <span style={{ fontSize: 15 }} className="dim">{c.employeeCode}</span></h2>
      <p style={{ margin: 0 }}>Probation ends {fmtDate(c.probationEndDate)} · <span className={`pill ${STATUS[c.status]?.[0] ?? 'mute'}`}>{STATUS[c.status]?.[1] ?? c.status}</span></p>
      {c.review && (
        <div style={{ padding: 16, borderRadius: 20, border: '1.5px solid var(--line-2)' }}>
          <strong>Manager's review: {c.review.rating}/5, recommends {String(c.review.recommendation).replace('_', ' ')}{c.review.extensionMonths ? ` for ${c.review.extensionMonths} months` : ''}</strong>
          {c.review.onBehalfOf && <p className="dim" style={{ margin: '6px 0 0', fontSize: 13 }}>Written by HR on behalf of the manager: {c.review.onBehalfOf.reason}</p>}
          <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>Strengths: {c.review.strengths}</p>
          {c.review.concerns && <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>Concerns: {c.review.concerns}</p>}
          <p className="dim" style={{ margin: '8px 0 0', fontSize: 12 }}>The employee never sees this review, only the outcome.</p>
        </div>
      )}
      {c.decision && <p style={{ margin: 0 }}><strong>{OUTCOME[c.decision.outcome]}</strong>{c.decision.newEndDate ? ` until ${fmtDate(c.decision.newEndDate)}` : ''}{c.decision.note ? `: ${c.decision.note}` : ''}{c.decision.early ? ' (confirmed before the probation end date)' : ''}</p>}
      {(c.canReview || (c.canReviewOnBehalf && hr)) && (
        <div style={{ display: 'grid', gap: 12 }}>
          <strong>{c.canReview ? 'Manager\'s review' : 'Review on behalf of the manager'}</strong>
          {!c.canReview && <div className="field"><label htmlFor="cf-obr">Why is HR writing it? (kept in the audit log)</label><input id="cf-obr" className="input" value={rv.onBehalfReason} onChange={(e) => setRv({ ...rv, onBehalfReason: e.target.value })} maxLength={500} placeholder="For example: the manager is on leave and the date is close" /></div>}
          <div className="field"><label htmlFor="cf-rate">Overall rating (1 to 5)</label><input id="cf-rate" className="input" type="number" min={1} max={5} value={rv.rating} onChange={(e) => setRv({ ...rv, rating: Number(e.target.value) })} /></div>
          <div className="field"><label htmlFor="cf-str">Strengths</label><textarea id="cf-str" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={rv.strengths} onChange={(e) => setRv({ ...rv, strengths: e.target.value })} /></div>
          <div className="field"><label htmlFor="cf-con">Concerns (HR sees these; the employee never does)</label><textarea id="cf-con" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={rv.concerns} onChange={(e) => setRv({ ...rv, concerns: e.target.value })} /></div>
          <div className="field"><label htmlFor="cf-rec">Recommendation</label>
            <select id="cf-rec" className="input" value={rv.recommendation} onChange={(e) => setRv({ ...rv, recommendation: e.target.value })}><option value="confirm">Confirm</option><option value="extend">Extend probation</option><option value="not_confirm">Do not confirm</option></select></div>
          {rv.recommendation === 'extend' && <div className="field"><label htmlFor="cf-ext">Extend by (months)</label><input id="cf-ext" className="input" type="number" min={1} max={12} value={rv.extensionMonths} onChange={(e) => setRv({ ...rv, extensionMonths: Number(e.target.value) })} /></div>}
          <div><button className="btn btn-primary" disabled={review.isPending || rv.strengths.trim().length < 3 || (!c.canReview && rv.onBehalfReason.trim().length < 5)} onClick={() => review.mutate()}>Send to HR</button></div>
        </div>
      )}
      {hr && c.status === 'manager_review' && (
        <div className="well" style={{ padding: 14, display: 'grid', gap: 8 }}>
          <strong style={{ fontSize: 14 }}>The manager is away or has left?</strong>
          <span className="dim" style={{ fontSize: 13 }}>Hand the review to another manager{c.canReviewOnBehalf ? ', or write it yourself above with a reason' : ''}.</span>
          <div><button className="btn btn-ghost btn-sm" onClick={() => setReassign(true)}>Hand to another manager</button></div>
        </div>
      )}
      {hr && c.status === 'hr_decision' && (
        <div style={{ display: 'grid', gap: 12 }}>
          <strong>HR decision</strong>
          <div className="field"><label htmlFor="cf-out">Outcome</label>
            <select id="cf-out" className="input" value={dc.outcome} onChange={(e) => setDc({ ...dc, outcome: e.target.value })}><option value="confirmed">Confirm</option><option value="extended">Extend probation</option><option value="not_confirmed">Do not confirm</option></select></div>
          {dc.outcome === 'confirmed' && c.daysEarly > 0 && <div className="pill warn" style={{ whiteSpace: 'normal', textTransform: 'none' }}>The probation ends on {fmtDate(c.probationEndDate)}, {c.daysEarly} day{c.daysEarly === 1 ? '' : 's'} from now. You will be asked to confirm that you want to confirm early.</div>}
          {dc.outcome === 'extended' && <div className="field"><label htmlFor="cf-end">New probation end date{c.review?.extensionMonths ? ` (the manager recommended ${c.review.extensionMonths} months)` : ''}</label><input id="cf-end" className="input" type="date" min={today()} value={dc.newEndDate} onChange={(e) => setDc({ ...dc, newEndDate: e.target.value })} /></div>}
          <div className="field"><label htmlFor="cf-note">Note{dc.outcome === 'confirmed' ? ' (optional)' : ''}</label><textarea id="cf-note" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={dc.note} onChange={(e) => setDc({ ...dc, note: e.target.value })} /></div>
          <p className="dim" style={{ margin: 0, fontSize: 13 }}>The employee is told the outcome only, never your note or the concerns. A confirmation or extension letter is made from your template.</p>
          <div><button className="btn btn-primary" disabled={decide.isPending || (dc.outcome !== 'confirmed' && !dc.note.trim()) || (dc.outcome === 'extended' && !dc.newEndDate)} onClick={() => decide.mutate(false)}>Record decision</button></div>
        </div>
      )}
      {ask === 'cancel' && <ReasonModal title="Cancel this review" label="Why is it being cancelled?" help="The review closes without a decision. The person shows up under Due soon again and a new review can be opened. They are not told." confirmLabel="Cancel the review" busy={cancel.isPending} onClose={() => setAsk(null)} onSubmit={(r) => cancel.mutate(r)} />}
      {ask === 'early' && (
        <Modal open onClose={() => setAsk(null)} title="Confirm before the probation ends?" width={460}>
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ margin: 0 }}>The probation ends on <strong>{fmtDate(c.probationEndDate)}</strong>, {c.daysEarly} day{c.daysEarly === 1 ? '' : 's'} from now. Confirming now sets the confirmation date to today.</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="btn btn-ghost" onClick={() => setAsk(null)}>Not yet</button><button className="btn btn-primary" disabled={decide.isPending} onClick={() => decide.mutate(true)}>Confirm now</button></div>
          </div>
        </Modal>)}
      {reassign && (
        <Modal open onClose={() => { setReassign(false); setPick(null); setTerm('') }} title="Hand to another manager" width={460}>
          <div style={{ display: 'grid', gap: 10 }}>
            {pick ? <span className="chip is-on" style={{ justifySelf: 'start' }}>{pick.name} <button type="button" className="link" onClick={() => setPick(null)}>change</button></span> : (
              <>
                <input className="input" placeholder="Search for the new reviewer" value={term} onChange={(e) => setTerm(e.target.value)} autoFocus aria-label="Search for the new reviewer" />
                {people.data?.filter((p) => p.id !== c.employeeId).map((p) => <button key={p.id} type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} onClick={() => setPick({ id: p.id, name: `${p.firstName} ${p.lastName}` })}>{p.firstName} {p.lastName} <span className="dim">{p.employeeCode}</span></button>)}
              </>
            )}
            <label className="field"><span>Why? (kept in the audit log)</span><input className="input" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={500} /></label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="btn btn-ghost" onClick={() => { setReassign(false); setPick(null); setTerm('') }}>Cancel</button><button className="btn btn-primary" disabled={!pick || why.trim().length < 5 || hand.isPending} onClick={() => hand.mutate({ managerEmployeeId: pick!.id, reason: why.trim() })}>Hand over</button></div>
          </div>
        </Modal>)}
    </div>
  )
}

// HR edits the wording of the confirmation and extension letters and previews them as a PDF
function Letters() {
  const toast = useToast()
  const qc = useQueryClient()
  const t = useQuery({ queryKey: ['conf-templates'], queryFn: async () => (await api.get('/confirmation/templates')).data.data as { confirmed: string; extended: string; placeholders: string[]; defaults: { confirmed: string; extended: string } } })
  const [f, setF] = useState<{ confirmed: string; extended: string } | null>(null)
  useEffect(() => { if (t.data && !f) setF({ confirmed: t.data.confirmed, extended: t.data.extended }) }, [t.data]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({ mutationFn: async () => (await api.put('/confirmation/templates', f)).data.data, onSuccess: () => { toast('Letters saved'); qc.invalidateQueries({ queryKey: ['conf-templates'] }) }, onError: (e) => toast(errMsg(e), 'error') })
  if (t.isError) return <div className="card" style={{ padding: 20, display: 'grid', gap: 8 }}><span>The letters could not be loaded.</span><div><button className="btn btn-primary btn-sm" onClick={() => t.refetch()}>Try again</button></div></div>
  if (!t.data || !f) return <p>Loading…</p>
  const box = (k: 'confirmed' | 'extended', title: string) => (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 8 }}>
      <h2 style={{ fontSize: 17 }}>{title}</h2>
      <textarea className="input" rows={10} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} style={{ height: 'auto', padding: 14, borderRadius: 20, fontFamily: 'inherit' }} maxLength={4000} aria-label={title} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setF({ ...f, [k]: t.data!.defaults[k] })}>Use the standard wording</button>
        <button className="btn btn-ghost btn-sm" onClick={() => downloadCsv('/confirmation/templates/preview', { kind: k })}>Preview as PDF (saved wording)</button>
      </div>
    </div>
  )
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="card" style={{ padding: 20 }}>
        <p style={{ margin: 0 }}>These letters are made when someone is confirmed or their probation is extended. Put these in the text and they are filled in for each person:</p>
        <div className="chips" style={{ marginTop: 8 }}>{t.data.placeholders.map((p) => <span key={p} className="chip">{`{${p}}`}</span>)}</div>
      </div>
      {box('confirmed', 'Confirmation letter')}
      {box('extended', 'Extension letter')}
      <div><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save both letters'}</button></div>
    </div>
  )
}

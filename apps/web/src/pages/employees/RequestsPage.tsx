import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { useEmployees } from '../../lib/hooks/useEmployees'
import { fmtDate } from '../../lib/format'

// Self-service onboarding and data requests: HR asks, the person fills in and submits each section, HR accepts it
// or sends it back with a note.
export interface Req { id: string; employeeId: string; employee: string | null; employeeCode: string | null; kind: string; note: string | null; dueDate: string | null; status: string; requestedBy: string | null; createdAt: string; completedAt: string | null; sections: { section: string; label: string; status: string; reviewNote: string | null }[]; progress: { done: number; total: number } }
export const SECTIONS: [string, string, string][] = [
  ['personal', 'Personal details', 'personal'], ['contact', 'Contact details', 'personal'], ['addresses', 'Addresses', 'personal'], ['emergencyContacts', 'Emergency contacts', 'personal'],
  ['family', 'Family & nominees', 'family'], ['education', 'Education', 'qualifications'], ['previousEmployment', 'Previous employment', 'qualifications'], ['identities', 'Identity documents', 'identity'], ['documents', 'Documents', 'documents'],
]
const STATUS: Record<string, string> = { pending: 'mute', submitted: 'info', accepted: 'ok', rejected: 'warn' }
const STATUS_LABEL: Record<string, string> = { pending: 'to fill in', submitted: 'waiting for HR', accepted: 'accepted', rejected: 'sent back' }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const tabOf = (section: string) => SECTIONS.find((s) => s[0] === section)?.[2] ?? 'personal'

export function useRequestActions(onDone: () => void) {
  const toast = useToast()
  return useMutation({ mutationFn: async (f: () => Promise<unknown>) => f(), onSuccess: onDone, onError: (e) => toast(errMsg(e), 'error') })
}

// One request with its sections: the person submits, HR reviews
export function RequestCard({ r, mode, onChange }: { r: Req; mode: 'self' | 'hr'; onChange: () => void }) {
  const act = useRequestActions(onChange)
  const [returning, setReturning] = useState<string | null>(null)
  const [note, setNote] = useState('')
  return (
    <div className="well" style={{ padding: 14, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong style={{ fontWeight: 600 }}>{r.kind === 'onboarding' ? 'Onboarding' : 'Details requested'}{mode === 'hr' && r.employee ? ` · ${r.employee}` : ''}</strong>
        <span className="dim" style={{ fontSize: 12 }}>{r.progress.done}/{r.progress.total} accepted{r.dueDate ? ` · due ${fmtDate(r.dueDate)}` : ''} · <span className={`pill ${r.status === 'open' ? 'info' : r.status === 'completed' ? 'ok' : 'mute'}`}>{r.status}</span></span>
      </div>
      {r.note && <p style={{ fontSize: 13 }}>{r.note}</p>}
      <div style={{ display: 'grid', gap: 6 }}>
        {r.sections.map((s) => (
          <div key={s.section} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
            <span>{s.label} <span className={`pill ${STATUS[s.status]}`}>{STATUS_LABEL[s.status]}</span>{s.reviewNote && s.status === 'rejected' && <span style={{ color: 'var(--warn)', display: 'block', fontSize: 12 }}>HR: {s.reviewNote}</span>}</span>
            {r.status === 'open' && (
              <span style={{ display: 'flex', gap: 4 }}>
                {mode === 'self' && ['pending', 'rejected'].includes(s.status) && <>
                  <Link className="btn btn-ghost btn-sm" to={`/employees/${r.employeeId}?tab=${tabOf(s.section)}`}>Fill in</Link>
                  <button className="btn btn-primary btn-sm" onClick={() => act.mutate(() => api.post(`/profile-requests/${r.id}/sections/${s.section}/submit`))}>Submit</button>
                </>}
                {mode === 'hr' && s.status === 'submitted' && <>
                  <Link className="btn btn-ghost btn-sm" to={`/employees/${r.employeeId}?tab=${tabOf(s.section)}`}>Check</Link>
                  <button className="btn btn-primary btn-sm" onClick={() => act.mutate(() => api.post(`/profile-requests/${r.id}/sections/${s.section}/review`, { accept: true }))}>Accept</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setReturning(s.section); setNote('') }}>Send back</button>
                </>}
              </span>
            )}
          </div>
        ))}
      </div>
      {mode === 'hr' && r.status === 'open' && <div><button className="btn btn-ghost btn-sm" onClick={() => act.mutate(() => api.post(`/profile-requests/${r.id}/cancel`))}>Cancel request</button></div>}
      {returning && (
        <Modal open onClose={() => setReturning(null)} title="Send back for changes">
          <form onSubmit={(e) => { e.preventDefault(); act.mutate(async () => { await api.post(`/profile-requests/${r.id}/sections/${returning}/review`, { accept: false, note }); setReturning(null) }) }} style={{ display: 'grid', gap: 12 }}>
            <label className="field"><span>What needs fixing?</span><textarea className="input" rows={3} required maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => setReturning(null)}>Cancel</button><button className="btn btn-primary">Send back</button></div>
          </form>
        </Modal>
      )}
    </div>
  )
}

export function NewRequestModal({ employeeIds, onClose }: { employeeIds?: string[]; onClose: (ok?: boolean) => void }) {
  const toast = useToast()
  const { data: people } = useEmployees({ limit: 500 })
  const [f, setF] = useState({ kind: employeeIds ? 'onboarding' : 'update', sections: employeeIds ? SECTIONS.map((s) => s[0]) : ['personal'], note: '', dueDate: '', ids: employeeIds ?? ([] as string[]) })
  const save = useMutation({
    mutationFn: () => api.post('/profile-requests', { employeeIds: f.ids, sections: f.sections, kind: f.kind, ...(f.note && { note: f.note }), ...(f.dueDate && { dueDate: f.dueDate }) }),
    onSuccess: (r) => { toast(`Request sent to ${r.data.data.created}`); onClose(true) }, onError: (e) => toast(errMsg(e), 'error'),
  })
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  return (
    <Modal open onClose={() => onClose()} title={f.kind === 'onboarding' ? 'Start onboarding' : 'Ask for details'} width={620}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 14 }}>
        <div className="chips" style={{ display: 'flex', gap: 6 }}>
          {[['onboarding', 'Onboarding (new joiner)'], ['update', 'Update existing details']].map(([k, l]) => <button key={k} type="button" className="chip" aria-pressed={f.kind === k} onClick={() => setF({ ...f, kind: k })} style={f.kind === k ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{l}</button>)}
        </div>
        {!employeeIds && (
          <label className="field"><span>People ({f.ids.length} chosen)</span>
            <div style={{ maxHeight: 180, overflowY: 'auto', display: 'grid', gap: 2, border: '1px solid var(--line)', borderRadius: 12, padding: 8 }}>
              {((people?.data ?? []) as any[]).map((p) => <label key={p.id} style={{ display: 'flex', gap: 8, fontSize: 13 }}><input type="checkbox" checked={f.ids.includes(p.id)} onChange={() => setF({ ...f, ids: toggle(f.ids, p.id) })} /> {p.firstName} {p.lastName} <span className="dim">{p.employeeCode}</span></label>)}
            </div>
          </label>
        )}
        <div className="field"><span style={{ fontSize: 12, fontWeight: 500, color: 'var(--dim)' }}>Sections to fill in</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{SECTIONS.map(([k, l]) => <button key={k} type="button" className="chip" aria-pressed={f.sections.includes(k)} onClick={() => setF({ ...f, sections: toggle(f.sections, k) })} style={f.sections.includes(k) ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{l}</button>)}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          <label className="field"><span>Due by (optional)</span><input className="input" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></label>
        </div>
        <label className="field"><span>Message (optional)</span><textarea className="input" rows={2} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={!f.ids.length || !f.sections.length || save.isPending}>Send</button></div>
      </form>
    </Modal>
  )
}

export default function RequestsPage() {
  const { hasRole } = useAuth()
  const hr = hasRole('hr_admin') || hasRole('system_admin')
  const qc = useQueryClient()
  const [status, setStatus] = useState('open')
  const [creating, setCreating] = useState(false)
  const { data = [], isLoading } = useQuery({ queryKey: ['profile-requests', status, hr], queryFn: async () => (await api.get('/profile-requests', { params: { ...(status && { status }), ...(!hr && { mine: '1' }) } })).data.data as Req[] })
  const root = useReveal<HTMLDivElement>(isLoading)
  const refresh = () => qc.invalidateQueries({ queryKey: ['profile-requests'] })
  return (
    <div ref={root}>
      <PageHeader title={hr ? 'Onboarding & requests' : 'My requests'} sub={hr ? 'Ask new joiners and staff to complete their details, then check each section' : 'Details HR has asked you to complete'}
        actions={hr ? <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> Ask for details</button> : undefined}>
        <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
          {[['open', 'Open'], ['completed', 'Completed'], ['', 'All']].map(([k, l]) => <button key={k} className="chip" aria-pressed={status === k} onClick={() => setStatus(k)} style={status === k ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{l}</button>)}
        </div>
      </PageHeader>
      {isLoading ? <div className="skeleton" style={{ height: 160, borderRadius: 18 }} /> : !data.length ? <section className="card" style={{ padding: 20 }}><p className="dim">{hr ? 'No requests here. Start onboarding from a new joiner\'s profile, or ask several people for details at once.' : 'Nothing to do right now.'}</p></section> : (
        <div style={{ display: 'grid', gap: 12, maxWidth: 860 }}>{data.map((r) => <div key={r.id} data-card><RequestCard r={r} mode={hr ? 'hr' : 'self'} onChange={refresh} /></div>)}</div>
      )}
      {creating && <NewRequestModal onClose={(ok) => { setCreating(false); if (ok) refresh() }} />}
    </div>
  )
}

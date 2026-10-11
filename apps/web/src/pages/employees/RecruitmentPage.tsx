import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { fmtDate } from '../../lib/format'
import { flattenUnits } from '../workplace/AnnouncementsPage'
import MasterSelect from '../../components/ui/MasterSelect'
import { useMasters } from '../../lib/hooks/useMasters'

interface Opening { id: string; title: string; description: string; orgUnitId: string; orgUnit: string | null; employmentType: string; openings: number; salaryMin: number | null; salaryMax: number | null; currency: string; hiringManagerId: string | null; hiringManager: string | null; status: string; closedReason: string | null; requestedBy: string | null; requestedByUserId: string; createdAt: string; canManage: boolean; pipeline: Record<string, number> | null }
interface Cand { id: string; openingId: string; opening?: string; firstName: string; lastName: string; stage: string; source: string; summary: string | null; resumeUrl: string | null; rating: number | null; email?: string; phone?: string | null; rejectionReason?: string | null; referredBy?: string | null; offerCtcAnnual?: number | null; offerJoiningDate?: string | null; offerStatus?: string | null; offerNote?: string | null; hiredEmployeeId?: string | null; interviews?: any; feedbackIn?: number; canManage?: boolean }
interface Interview { id: string; candidateId: string; interviewer: string | null; interviewerUserId: string; scheduledAt: string; mode: string; status: string; rating: number | null; recommendation: string | null; feedback: string | null; candidate?: string; opening?: string }

const OPEN_STATUS: Record<string, string> = { pending_approval: 'warn', open: 'ok', on_hold: 'info', closed: 'mute', rejected: 'danger' }
const STAGE_PILL: Record<string, string> = { applied: 'mute', screening: 'info', interview: 'honey', offer: 'warn', hired: 'ok', rejected: 'danger', withdrawn: 'mute' }
const PIPELINE = ['applied', 'screening', 'interview', 'offer', 'hired'] as const
const label = (s: string) => s.replace(/_/g, ' ')
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const range = (o: Opening) => o.salaryMin || o.salaryMax ? `${[o.salaryMin, o.salaryMax].filter((x) => x != null).map((x) => x!.toLocaleString()).join(' – ')} ${o.currency}/yr` : null
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export default function RecruitmentPage() {
  const { label: ml } = useMasters()
  const { hasRole } = useAuth()
  const isHR = hasRole('hr_admin')
  const canOpen = isHR || hasRole('manager')
  const [tab, setTab] = useState<'openings' | 'interviews' | 'referrals'>('openings')
  const [creating, setCreating] = useState(false)
  const [referring, setReferring] = useState<Opening | null>(null)
  const { data = [], isLoading } = useQuery({ queryKey: ['openings'], queryFn: async () => (await api.get('/recruitment/openings')).data.data as Opening[] })
  const root = useReveal<HTMLDivElement>(`${tab}${isLoading}`)
  const mine = data.filter((o) => o.canManage)
  const board = data.filter((o) => !o.canManage && o.status === 'open')
  return (
    <div ref={root}>
      <PageHeader title="Recruitment" sub={isHR ? 'Hiring requests, candidates, interviews and offers' : 'Open positions, your referrals and interviews you are on'}
        actions={canOpen ? <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> {isHR ? 'New opening' : 'Request a hire'}</button> : undefined}>
        <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
          {([['openings', 'Openings'], ['interviews', 'My interviews'], ['referrals', 'My referrals']] as const).map(([k, l]) => <button key={k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      </PageHeader>
      {tab === 'interviews' ? <MyInterviews /> : tab === 'referrals' ? <MyReferrals /> : isLoading ? <div className="skeleton" style={{ height: 180, borderRadius: 22 }} /> : (
        <>
          {mine.length > 0 && (
            <section data-card className="card" style={{ padding: 8, overflowX: 'auto', marginBottom: 18 }}>
              <h3 style={{ fontSize: 15, padding: '10px 12px 4px' }}>{isHR ? 'All openings' : 'Openings you manage'}</h3>
              <table className="tbl" style={{ width: '100%', minWidth: 760 }}>
                <thead><tr><th>Position</th><th>Department</th><th>Hiring manager</th><th>Pipeline</th><th>Status</th></tr></thead>
                <tbody>{mine.map((o) => (
                  <tr key={o.id} data-row>
                    <td><Link to={`/recruitment/${o.id}`} className="link" style={{ fontWeight: 600 }}>{o.title}</Link><div className="dim" style={{ fontSize: 12 }}>{o.openings} seat{o.openings > 1 ? 's' : ''} · {ml('employment_type', o.employmentType)}</div></td>
                    <td>{o.orgUnit ?? '—'}</td>
                    <td>{o.hiringManager ?? '—'}</td>
                    <td style={{ fontSize: 12 }}>{o.pipeline ? PIPELINE.map((s) => <span key={s} title={s} style={{ marginRight: 8 }}><span className="dim">{s.slice(0, 1).toUpperCase()}</span> {o.pipeline![s]}</span>) : '—'}</td>
                    <td><span className={`pill ${OPEN_STATUS[o.status] ?? 'mute'}`}>{label(o.status)}</span></td>
                  </tr>))}</tbody>
              </table>
            </section>
          )}
          <h3 data-rise style={{ fontSize: 15, margin: '6px 4px 10px' }}>Open positions</h3>
          {!board.length && !mine.some((o) => o.status === 'open') ? <section className="card" style={{ padding: 20 }}><p className="dim">No open positions right now.</p></section> : (
            <div className="dgrid">
              {data.filter((o) => o.status === 'open').map((o) => (
                <section key={o.id} data-card className="card span-4" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong style={{ fontSize: 16 }}>{o.title}</strong><Icon name="briefcase" size={16} /></div>
                  <div className="dim" style={{ fontSize: 13 }}>{[o.orgUnit, ml('employment_type', o.employmentType), range(o)].filter(Boolean).join(' · ')}</div>
                  {o.description && <p style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 84, overflow: 'hidden' }}>{o.description}</p>}
                  <div style={{ marginTop: 'auto', display: 'flex', gap: 8 }}>
                    <button className="btn btn-honey btn-sm" onClick={() => setReferring(o)}><Icon name="user" size={14} /> Refer someone</button>
                    {o.canManage && <Link to={`/recruitment/${o.id}`} className="btn btn-ghost btn-sm">Pipeline</Link>}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
      {creating && <OpeningModal onClose={() => setCreating(false)} />}
      {referring && <CandidateModal opening={referring} referral onClose={() => setReferring(null)} />}
    </div>
  )
}

function OpeningModal({ onClose, edit }: { onClose: () => void; edit?: Opening }) {
  const { hasRole } = useAuth()
  const isHR = hasRole('hr_admin')
  const qc = useQueryClient()
  const toast = useToast()
  const [f, setF] = useState({ title: edit?.title ?? '', description: edit?.description ?? '', orgUnitId: edit?.orgUnitId ?? '', employmentType: edit?.employmentType ?? 'full_time', openings: String(edit?.openings ?? 1), salaryMin: edit?.salaryMin?.toString() ?? '', salaryMax: edit?.salaryMax?.toString() ?? '', hiringManagerId: edit?.hiringManagerId ?? '' })
  const { data: units = [] } = useQuery({ queryKey: ['unit-tree'], queryFn: async () => flattenUnits((await api.get('/employees/org-units/tree')).data.data) })
  const { data: people = [] } = useQuery({ queryKey: ['recruit-people'], enabled: isHR, queryFn: async () => (await api.get('/employees', { params: { limit: 500 } })).data.data as any[] })
  const save = useMutation({
    mutationFn: () => {
      const body: any = { title: f.title, description: f.description, orgUnitId: f.orgUnitId, employmentType: f.employmentType, openings: Number(f.openings), salaryMin: f.salaryMin ? Number(f.salaryMin) : null, salaryMax: f.salaryMax ? Number(f.salaryMax) : null }
      if (isHR) body.hiringManagerId = f.hiringManagerId || null
      return edit ? api.patch(`/recruitment/openings/${edit.id}`, body) : api.post('/recruitment/openings', body)
    },
    onSuccess: () => { toast(edit ? 'Saved' : isHR ? 'Opening created' : 'Request sent to HR'); qc.invalidateQueries({ queryKey: ['openings'] }); qc.invalidateQueries({ queryKey: ['opening'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value })
  return (
    <Modal open onClose={onClose} title={edit ? 'Edit opening' : isHR ? 'New opening' : 'Request a hire'}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Position title</span><input className="input" required minLength={2} value={f.title} onChange={set('title')} /></label>
        <label className="field"><span>Department</span><select className="input" required value={f.orgUnitId} onChange={set('orgUnitId')}><option value="">Choose…</option>{units.map((u) => <option key={u.id} value={u.id}>{'  '.repeat(u.depth)}{u.name}</option>)}</select></label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label className="field"><span>Type</span><MasterSelect list="employment_type" className="input" value={f.employmentType} onChange={(v) => setF({ ...f, employmentType: v })} /></label>
          <label className="field"><span>Seats</span><input className="input" type="number" min={1} max={500} value={f.openings} onChange={set('openings')} /></label>
          <label className="field"><span>Salary from (yearly)</span><input className="input" type="number" min={0} value={f.salaryMin} onChange={set('salaryMin')} /></label>
          <label className="field"><span>Salary to (yearly)</span><input className="input" type="number" min={0} value={f.salaryMax} onChange={set('salaryMax')} /></label>
        </div>
        {isHR && <label className="field"><span>Hiring manager</span><select className="input" value={f.hiringManagerId} onChange={set('hiringManagerId')}><option value="">None</option>{people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}</select></label>}
        <label className="field"><span>About the role</span><textarea className="input" rows={5} maxLength={5000} value={f.description} onChange={set('description')} /></label>
        {!isHR && !edit && <p className="dim" style={{ fontSize: 12 }}>HR approves the request before it opens. You will be the hiring manager.</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>{edit ? 'Save' : isHR ? 'Create' : 'Send request'}</button></div>
      </form>
    </Modal>
  )
}

function CandidateModal({ opening, referral, onClose }: { opening: { id: string; title: string }; referral?: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '', resumeUrl: '', summary: '', source: 'direct' })
  const save = useMutation({
    mutationFn: () => {
      const body: any = { firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone || null, resumeUrl: f.resumeUrl || null, summary: f.summary || null }
      if (!referral) body.source = f.source
      return api.post(`/recruitment/openings/${opening.id}/${referral ? 'refer' : 'candidates'}`, body)
    },
    onSuccess: () => { toast(referral ? 'Thanks! HR has your referral' : 'Candidate added'); qc.invalidateQueries({ queryKey: ['opening', opening.id] }); qc.invalidateQueries({ queryKey: ['openings'] }); qc.invalidateQueries({ queryKey: ['my-referrals'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value })
  return (
    <Modal open onClose={onClose} title={`${referral ? 'Refer someone for' : 'Add a candidate to'} ${opening.title}`}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label className="field"><span>First name</span><input className="input" required value={f.firstName} onChange={set('firstName')} /></label>
          <label className="field"><span>Last name</span><input className="input" required value={f.lastName} onChange={set('lastName')} /></label>
          <label className="field"><span>Email</span><input className="input" type="email" required value={f.email} onChange={set('email')} /></label>
          <label className="field"><span>Phone</span><input className="input" value={f.phone} onChange={set('phone')} /></label>
        </div>
        <label className="field"><span>CV link (Drive, Dropbox, LinkedIn…)</span><input className="input" type="url" placeholder="https://" value={f.resumeUrl} onChange={set('resumeUrl')} /></label>
        {!referral && <label className="field"><span>Source</span><MasterSelect list="source_of_hire" className="input" value={f.source} onChange={(v) => setF({ ...f, source: v })} /></label>}
        <label className="field"><span>{referral ? 'Why they would be great' : 'Notes'}</span><textarea className="input" rows={3} maxLength={2000} value={f.summary} onChange={set('summary')} /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>{referral ? 'Send referral' : 'Add'}</button></div>
      </form>
    </Modal>
  )
}

function MyInterviews() {
  const { data = [], isLoading } = useQuery({ queryKey: ['my-interviews'], queryFn: async () => (await api.get('/recruitment/interviews/mine')).data.data as Interview[] })
  if (isLoading) return <div className="skeleton" style={{ height: 140, borderRadius: 22 }} />
  return (
    <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
      {!data.length ? <p className="dim" style={{ padding: 16 }}>You have no interviews.</p> : (
        <table className="tbl" style={{ width: '100%', minWidth: 620 }}>
          <thead><tr><th>Candidate</th><th>Position</th><th>When</th><th>Status</th></tr></thead>
          <tbody>{data.map((i) => (
            <tr key={i.id} data-row>
              <td><Link className="link" to={`/recruitment/candidates/${i.candidateId}`} style={{ fontWeight: 600 }}>{i.candidate}</Link></td>
              <td>{i.opening}</td><td>{when(i.scheduledAt)} · {label(i.mode)}</td>
              <td><span className={`pill ${i.status === 'completed' ? 'ok' : i.status === 'cancelled' ? 'mute' : 'warn'}`}>{i.status === 'scheduled' ? 'feedback due' : i.status}</span></td>
            </tr>))}</tbody>
        </table>
      )}
    </section>
  )
}

function MyReferrals() {
  const { data = [], isLoading } = useQuery({ queryKey: ['my-referrals'], queryFn: async () => (await api.get('/recruitment/referrals/mine')).data.data as { id: string; name: string; opening: string; stage: string; createdAt: string }[] })
  if (isLoading) return <div className="skeleton" style={{ height: 140, borderRadius: 22 }} />
  return (
    <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
      {!data.length ? <p className="dim" style={{ padding: 16 }}>You haven’t referred anyone yet. Pick an open position and use Refer someone.</p> : (
        <table className="tbl" style={{ width: '100%', minWidth: 520 }}>
          <thead><tr><th>Person</th><th>Position</th><th>Referred</th><th>Stage</th></tr></thead>
          <tbody>{data.map((r) => <tr key={r.id} data-row><td style={{ fontWeight: 600 }}>{r.name}</td><td>{r.opening}</td><td>{fmtDate(r.createdAt)}</td><td><span className={`pill ${STAGE_PILL[r.stage]}`}>{r.stage}</span></td></tr>)}</tbody>
        </table>
      )}
    </section>
  )
}

export function OpeningPage() {
  const { label: ml } = useMasters()
  const { id = '' } = useParams()
  const { hasRole, user } = useAuth()
  const isHR = hasRole('hr_admin')
  const qc = useQueryClient()
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const { data: o, isLoading, error } = useQuery({ queryKey: ['opening', id], queryFn: async () => (await api.get(`/recruitment/openings/${id}`)).data.data as Opening & { candidates: Cand[] } })
  const root = useReveal<HTMLDivElement>(isLoading)
  const act = useMutation({ mutationFn: async (f: () => Promise<any>) => f(), onSuccess: () => { qc.invalidateQueries({ queryKey: ['opening', id] }); qc.invalidateQueries({ queryKey: ['openings'] }) }, onError: (e) => toast(errMsg(e), 'error') })
  if (isLoading) return <div className="skeleton" style={{ height: 240, borderRadius: 22 }} />
  if (error || !o) return <section className="card" style={{ padding: 28 }}><h2>Opening not found</h2><Link to="/recruitment" className="link">Back to recruitment</Link></section>
  const cands = o.candidates ?? []
  const closed = cands.filter((c) => c.stage === 'rejected' || c.stage === 'withdrawn')
  const status = (s: string, closedReason?: string) => act.mutate(async () => { await api.patch(`/recruitment/openings/${id}`, { status: s, ...(closedReason ? { closedReason } : {}) }); toast('Updated') })
  return (
    <div ref={root}>
      <PageHeader title={o.title} sub={<>{[o.orgUnit, ml('employment_type', o.employmentType), `${o.openings} seat${o.openings > 1 ? 's' : ''}`, range(o), o.hiringManager && `hiring manager ${o.hiringManager}`].filter(Boolean).join(' · ')} <span className={`pill ${OPEN_STATUS[o.status]}`} style={{ marginLeft: 6 }}>{label(o.status)}</span></>}
        actions={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/recruitment" className="btn btn-ghost btn-sm"><Icon name="chevronLeft" size={14} /> All openings</Link>
          {o.canManage && o.status === 'open' && <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add candidate</button>}
        </div>} />
      {o.status === 'pending_approval' && (
        <section data-card className="card" style={{ padding: 18, marginBottom: 18, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>Requested by <strong>{o.requestedBy}</strong> on {fmtDate(o.createdAt)}. Waiting for HR approval.</span>
          {isHR && o.requestedByUserId !== user?.id && <>
            <button className="btn btn-primary btn-sm" onClick={() => act.mutate(async () => { await api.post(`/recruitment/openings/${id}/approve`, {}); toast('Approved, the opening is live') })}>Approve</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { const note = prompt('Reason for rejecting'); if (note) act.mutate(async () => { await api.post(`/recruitment/openings/${id}/reject`, { note }); toast('Rejected') }) }}>Reject</button>
          </>}
        </section>
      )}
      {o.closedReason && <p className="dim" data-rise style={{ marginBottom: 12 }}>Closed: {o.closedReason}</p>}
      {isHR && !['pending_approval', 'rejected'].includes(o.status) && (
        <div data-rise style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {o.status !== 'closed' && <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}><Icon name="settings" size={14} /> Edit</button>}
          {o.status === 'open' && <button className="btn btn-ghost btn-sm" onClick={() => status('on_hold')}><Icon name="pause" size={14} /> Put on hold</button>}
          {o.status !== 'open' && <button className="btn btn-ghost btn-sm" onClick={() => status('open')}><Icon name="play" size={14} /> {o.status === 'closed' ? 'Reopen' : 'Resume'}</button>}
          {o.status !== 'closed' && <button className="btn btn-ghost btn-sm" onClick={() => { const r = prompt('Why is it closing?', 'Filled'); if (r) status('closed', r) }}><Icon name="x" size={14} /> Close</button>}
        </div>
      )}
      {o.canManage && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, alignItems: 'start' }}>
          {PIPELINE.map((s) => {
            const col = cands.filter((c) => c.stage === s)
            return (
              <section key={s} data-card className="card" style={{ padding: 12, background: 'var(--well)', boxShadow: 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}><span>{s}</span><span className="dim">{col.length}</span></div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {col.map((c) => <CandCard key={c.id} c={c} />)}
                  {!col.length && <span className="dim" style={{ fontSize: 12 }}>—</span>}
                </div>
              </section>
            )
          })}
        </div>
      )}
      {closed.length > 0 && <button className="btn btn-ghost btn-sm" style={{ marginTop: 14 }} onClick={() => setShowClosed(!showClosed)}>{showClosed ? 'Hide' : 'Show'} {closed.length} rejected or withdrawn</button>}
      {showClosed && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, marginTop: 10 }}>{closed.map((c) => <CandCard key={c.id} c={c} />)}</div>}
      {o.description && <section data-card className="card" style={{ padding: 20, marginTop: 18 }}><h3 style={{ fontSize: 15, marginBottom: 8 }}>About the role</h3><p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 14 }}>{o.description}</p></section>}
      {adding && <CandidateModal opening={o} onClose={() => setAdding(false)} />}
      {editing && <OpeningModal edit={o} onClose={() => setEditing(false)} />}
    </div>
  )
}

function CandCard({ c }: { c: Cand }) {
  const { label: ml } = useMasters()
  return (
    <Link to={`/recruitment/candidates/${c.id}`} className="card row-link" style={{ padding: 10, display: 'block', boxShadow: 'none' }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{c.firstName} {c.lastName}</div>
      <div className="dim" style={{ fontSize: 12, display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
        <span>{ml('source_of_hire', c.source)}</span>
        {c.rating ? <span>{'★'.repeat(c.rating)}</span> : null}
        {c.interviews ? <span>{c.feedbackIn}/{c.interviews} feedback</span> : null}
        {c.offerStatus && <span className={`pill ${c.offerStatus === 'accepted' ? 'ok' : c.offerStatus === 'declined' ? 'danger' : 'warn'}`}>offer {c.offerStatus}</span>}
        {(c.stage === 'rejected' || c.stage === 'withdrawn') && <span className={`pill ${STAGE_PILL[c.stage]}`}>{c.stage}</span>}
      </div>
    </Link>
  )
}

export function CandidatePage() {
  const { label: ml } = useMasters()
  const { id = '' } = useParams()
  const { hasRole, user } = useAuth()
  const isHR = hasRole('hr_admin')
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const [modal, setModal] = useState<'schedule' | 'offer' | 'hire' | null>(null)
  const [fb, setFb] = useState<Interview | null>(null)
  const { data: c, isLoading, error } = useQuery({ queryKey: ['candidate', id], queryFn: async () => (await api.get(`/recruitment/candidates/${id}`)).data.data as Cand & { interviews: Interview[] } })
  const root = useReveal<HTMLDivElement>(isLoading)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['candidate', id] }); qc.invalidateQueries({ queryKey: ['opening'] }); qc.invalidateQueries({ queryKey: ['my-interviews'] }) }
  const act = useMutation({ mutationFn: async (f: () => Promise<any>) => f(), onSuccess: refresh, onError: (e) => toast(errMsg(e), 'error') })
  if (isLoading) return <div className="skeleton" style={{ height: 240, borderRadius: 22 }} />
  if (error || !c) return <section className="card" style={{ padding: 28 }}><h2>Candidate not found</h2><Link to="/recruitment" className="link">Back to recruitment</Link></section>
  const live = !['hired', 'rejected', 'withdrawn'].includes(c.stage)
  const move = (stage: string, rejectionReason?: string) => act.mutate(async () => { await api.patch(`/recruitment/candidates/${id}`, { stage, ...(rejectionReason ? { rejectionReason } : {}) }); toast(`Moved to ${stage}`) })
  return (
    <div ref={root}>
      <PageHeader title={`${c.firstName} ${c.lastName}`} sub={<>{c.opening} · <span className={`pill ${STAGE_PILL[c.stage]}`}>{c.stage}</span></>}
        actions={<Link to={c.canManage ? `/recruitment/${c.openingId}` : '/recruitment'} className="btn btn-ghost btn-sm"><Icon name="chevronLeft" size={14} /> Back</Link>} />
      <div className="dgrid">
        <section data-card className="card span-4" style={{ padding: 20, display: 'grid', gap: 10, alignContent: 'start' }}>
          {c.email && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Icon name="mail" size={14} /> <a className="link" href={`mailto:${c.email}`}>{c.email}</a></div>}
          {c.phone && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Icon name="phone" size={14} /> {c.phone}</div>}
          {c.resumeUrl && <a className="btn btn-ghost btn-sm" href={c.resumeUrl} target="_blank" rel="noopener noreferrer"><Icon name="file" size={14} /> Open CV</a>}
          <div className="dim" style={{ fontSize: 13 }}>Source: {ml('source_of_hire', c.source)}{c.referredBy ? ` · referred by ${c.referredBy}` : ''}</div>
          {c.summary && <p style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{c.summary}</p>}
          {c.rejectionReason && <p className="pill danger" style={{ whiteSpace: 'normal' }}>Rejected: {c.rejectionReason}</p>}
          {c.canManage && (
            <label className="field"><span>Your rating</span>
              <div style={{ display: 'flex', gap: 2 }}>{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className="btn btn-icon btn-sm" aria-label={`${n} stars`} style={{ color: (c.rating ?? 0) >= n ? 'var(--honey)' : 'var(--dim)' }} onClick={() => act.mutate(() => api.patch(`/recruitment/candidates/${id}`, { rating: n }))}>★</button>)}</div>
            </label>
          )}
          {c.offerStatus && (
            <div className="well" style={{ padding: 12, fontSize: 13 }}>
              <strong>Offer {c.offerStatus}</strong><br />{c.offerCtcAnnual?.toLocaleString()} per year · joining {fmtDate(c.offerJoiningDate)}{c.offerNote && <><br />{c.offerNote}</>}
            </div>
          )}
          {c.hiredEmployeeId && <Link className="btn btn-honey btn-sm" to={`/employees/${c.hiredEmployeeId}`}><Icon name="user" size={14} /> Open employee profile</Link>}
          {c.canManage && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              {live && c.stage === 'applied' && <button className="btn btn-ghost btn-sm" onClick={() => move('screening')}>Move to screening</button>}
              {live && c.stage !== 'offer' && <button className="btn btn-ghost btn-sm" onClick={() => setModal('schedule')}><Icon name="calendar" size={14} /> Schedule interview</button>}
              {live && isHR && c.offerStatus !== 'made' && c.offerStatus !== 'accepted' && <button className="btn btn-primary btn-sm" onClick={() => setModal('offer')}>Make offer</button>}
              {isHR && c.offerStatus === 'made' && live && <>
                <button className="btn btn-primary btn-sm" onClick={() => act.mutate(async () => { await api.post(`/recruitment/candidates/${id}/offer-response`, { accepted: true }); toast('Offer accepted') })}>Offer accepted</button>
                <button className="btn btn-ghost btn-sm" onClick={() => act.mutate(async () => { await api.post(`/recruitment/candidates/${id}/offer-response`, { accepted: false }); toast('Offer declined') })}>Declined</button>
              </>}
              {isHR && c.offerStatus === 'accepted' && c.stage === 'offer' && <button className="btn btn-honey btn-sm" onClick={() => setModal('hire')}><Icon name="check" size={14} /> Hire</button>}
              {live && <button className="btn btn-ghost btn-sm" onClick={() => { const r = prompt('Reason for rejecting'); if (r && r.trim().length > 1) move('rejected', r.trim()) }}>Reject</button>}
              {live && <button className="btn btn-ghost btn-sm" onClick={() => move('withdrawn')}>Withdrew</button>}
              {isHR && (c.stage === 'rejected' || c.stage === 'withdrawn') && <button className="btn btn-ghost btn-sm" onClick={() => move('screening')}>Bring back</button>}
            </div>
          )}
        </section>
        <section data-card className="card span-8" style={{ padding: 20 }}>
          <h3 style={{ fontSize: 15, marginBottom: 12 }}>Interviews</h3>
          {!c.interviews.length ? <p className="dim">No interviews yet.</p> : (
            <div style={{ display: 'grid', gap: 10 }}>
              {c.interviews.map((i) => (
                <div key={i.id} className="well" style={{ padding: 14, display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{i.interviewer}</strong>
                    <span className="dim" style={{ fontSize: 13 }}>{when(i.scheduledAt)} · {label(i.mode)} <span className={`pill ${i.status === 'completed' ? 'ok' : i.status === 'cancelled' ? 'mute' : 'warn'}`}>{i.status}</span></span>
                  </div>
                  {i.status === 'completed' && <div style={{ fontSize: 13 }}><span className="pill info">{label(i.recommendation ?? '')}</span> {'★'.repeat(i.rating ?? 0)}<p style={{ whiteSpace: 'pre-wrap', marginTop: 6, lineHeight: 1.5 }}>{i.feedback}</p></div>}
                  <div style={{ display: 'flex', gap: 6 }}>
                    {i.interviewerUserId === user?.id && i.status !== 'cancelled' && <button className="btn btn-primary btn-sm" onClick={() => setFb(i)}>{i.status === 'completed' ? 'Edit feedback' : 'Give feedback'}</button>}
                    {c.canManage && i.status === 'scheduled' && <button className="btn btn-ghost btn-sm" onClick={() => act.mutate(async () => { await api.post(`/recruitment/interviews/${i.id}/cancel`); toast('Interview cancelled') })}>Cancel</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      {modal === 'schedule' && <ScheduleModal id={id} onClose={() => { setModal(null); refresh() }} />}
      {modal === 'offer' && <OfferModal id={id} onClose={() => { setModal(null); refresh() }} />}
      {modal === 'hire' && <HireModal c={c} onClose={(empId) => { setModal(null); refresh(); if (empId) navigate(`/employees/${empId}`) }} />}
      {fb && <FeedbackModal i={fb} onClose={() => { setFb(null); refresh() }} />}
    </div>
  )
}

function ScheduleModal({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ interviewerUserId: '', at: '', mode: 'video' })
  const { data: people = [] } = useQuery({ queryKey: ['recruit-people'], queryFn: async () => (await api.get('/employees', { params: { limit: 500 } })).data.data as any[] })
  const save = useMutation({ mutationFn: () => api.post(`/recruitment/candidates/${id}/interviews`, { interviewerUserId: f.interviewerUserId, scheduledAt: new Date(f.at).toISOString(), mode: f.mode }), onSuccess: () => { toast('Interview scheduled'); onClose() }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <Modal open onClose={onClose} title="Schedule an interview">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Interviewer</span><select className="input" required value={f.interviewerUserId} onChange={(e) => setF({ ...f, interviewerUserId: e.target.value })}><option value="">Choose…</option>{people.filter((p) => p.userId).map((p) => <option key={p.id} value={p.userId}>{p.firstName} {p.lastName}</option>)}</select></label>
        <label className="field"><span>When (your time)</span><input className="input" type="datetime-local" required value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} /></label>
        <label className="field"><span>How</span><select className="input" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="video">Video</option><option value="phone">Phone</option><option value="in_person">In person</option></select></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Schedule</button></div>
      </form>
    </Modal>
  )
}

function FeedbackModal({ i, onClose }: { i: Interview; onClose: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ rating: i.rating ?? 3, recommendation: i.recommendation ?? 'hire', feedback: i.feedback ?? '' })
  const save = useMutation({ mutationFn: () => api.post(`/recruitment/interviews/${i.id}/feedback`, f), onSuccess: () => { toast('Feedback saved'); onClose() }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <Modal open onClose={onClose} title="Interview feedback">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Rating</span><div style={{ display: 'flex', gap: 2 }}>{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className="btn btn-icon btn-sm" aria-label={`${n} stars`} style={{ color: f.rating >= n ? 'var(--honey)' : 'var(--dim)' }} onClick={() => setF({ ...f, rating: n })}>★</button>)}</div></label>
        <div className="chips" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{['strong_hire', 'hire', 'no_hire', 'strong_no_hire'].map((r) => <button key={r} type="button" className="chip" aria-pressed={f.recommendation === r} style={f.recommendation === r ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined} onClick={() => setF({ ...f, recommendation: r })}>{label(r)}</button>)}</div>
        <label className="field"><span>Notes (strengths, concerns, evidence)</span><textarea className="input" rows={6} required minLength={5} maxLength={5000} value={f.feedback} onChange={(e) => setF({ ...f, feedback: e.target.value })} /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Submit</button></div>
      </form>
    </Modal>
  )
}

function OfferModal({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ ctcAnnual: '', joiningDate: '', note: '' })
  const save = useMutation({ mutationFn: () => api.post(`/recruitment/candidates/${id}/offer`, { ctcAnnual: Number(f.ctcAnnual), joiningDate: f.joiningDate, ...(f.note ? { note: f.note } : {}) }), onSuccess: () => { toast('Offer recorded'); onClose() }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <Modal open onClose={onClose} title="Make an offer">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Yearly pay (CTC)</span><input className="input" type="number" min={1} required value={f.ctcAnnual} onChange={(e) => setF({ ...f, ctcAnnual: e.target.value })} /></label>
        <label className="field"><span>Joining date</span><input className="input" type="date" required value={f.joiningDate} onChange={(e) => setF({ ...f, joiningDate: e.target.value })} /></label>
        <label className="field"><span>Note (benefits, conditions)</span><textarea className="input" rows={3} maxLength={1000} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Record offer</button></div>
      </form>
    </Modal>
  )
}

function HireModal({ c, onClose }: { c: Cand; onClose: (employeeId?: string) => void }) {
  const toast = useToast()
  const [f, setF] = useState({ workEmail: '', hireDate: c.offerJoiningDate?.slice(0, 10) ?? '', referralBonus: '' })
  const save = useMutation({
    mutationFn: async () => (await api.post(`/recruitment/candidates/${c.id}/hire`, { workEmail: f.workEmail, hireDate: f.hireDate, ...(f.referralBonus ? { referralBonus: Number(f.referralBonus) } : {}) })).data.data,
    onSuccess: (d: any) => { toast(`${c.firstName} is now ${d.employee.employeeCode}. Grant login access on their profile.`); onClose(d.employee.id) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={() => onClose()} title={`Hire ${c.firstName} ${c.lastName}`}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <p className="dim" style={{ fontSize: 13 }}>Creates the employee record in the opening’s department, reporting to the hiring manager. Login access is granted separately on the profile.</p>
        <label className="field"><span>Work email</span><input className="input" type="email" required value={f.workEmail} onChange={(e) => setF({ ...f, workEmail: e.target.value })} /></label>
        <label className="field"><span>Joining date</span><input className="input" type="date" required value={f.hireDate} onChange={(e) => setF({ ...f, hireDate: e.target.value })} /></label>
        {c.referredBy && <label className="field"><span>Referral bonus for {c.referredBy} (optional, approved in Incentives)</span><input className="input" type="number" min={1} value={f.referralBonus} onChange={(e) => setF({ ...f, referralBonus: e.target.value })} /></label>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-honey" disabled={save.isPending}>Hire</button></div>
      </form>
    </Modal>
  )
}

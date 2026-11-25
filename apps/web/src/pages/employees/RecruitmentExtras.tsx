import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { downloadCsv } from '../../lib/hooks/usePayroll'
import { fmtDate } from '../../lib/format'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn']
const STAGE_PILL: Record<string, string> = { applied: 'mute', screening: 'info', interview: 'honey', offer: 'warn', hired: 'ok', rejected: 'danger', withdrawn: 'mute' }

// One reason box in place of the browser prompt()
export function ReasonDialog({ title, label, confirm, initial = '', min = 2, onClose, onSubmit }: { title: string; label: string; confirm: string; initial?: string; min?: number; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [v, setV] = useState(initial)
  return (
    <Modal open onClose={onClose} title={title} width={440}>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(v.trim()) }} style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>{label}</span><textarea className="input" style={{ minHeight: 80, height: 'auto', padding: 12 }} autoFocus maxLength={500} value={v} onChange={(e) => setV(e.target.value)} /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn btn-ghost" onClick={onClose}>Back</button><button className="btn btn-primary" disabled={v.trim().length < min}>{confirm}</button></div>
      </form>
    </Modal>
  )
}

// Candidates across every opening
export function SearchTab() {
  const [q, setQ] = useState('')
  const [stage, setStage] = useState('')
  const { data = [], isFetching } = useQuery({ queryKey: ['cand-search', q, stage], queryFn: async () => (await api.get('/recruitment/candidates', { params: { ...(q.trim() && { q: q.trim() }), ...(stage && { stage }) } })).data.data as any[] })
  return (
    <section data-card className="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <input className="input" style={{ flex: '1 1 240px' }} placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" style={{ width: 170 }} value={stage} onChange={(e) => setStage(e.target.value)}><option value="">Any stage</option>{STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
      </div>
      {!data.length ? <p className="dim">{isFetching ? 'Searching…' : 'No candidates match.'}</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ width: '100%', minWidth: 560 }}>
            <thead><tr><th>Candidate</th><th>Position</th><th>Stage</th><th>Added</th></tr></thead>
            <tbody>{data.map((c) => (
              <tr key={c.id} data-row>
                <td><Link className="link" to={`/recruitment/candidates/${c.id}`} style={{ fontWeight: 600 }}>{c.name}</Link><div className="dim" style={{ fontSize: 12 }}>{c.email}</div></td>
                <td>{c.opening}</td>
                <td><span className={`pill ${STAGE_PILL[c.stage] ?? 'mute'}`}>{c.stage}</span>{c.offerStatus ? <span className="dim" style={{ fontSize: 12, marginLeft: 6 }}>offer {c.offerStatus}</span> : null}</td>
                <td>{fmtDate(c.createdAt)}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// HR edits the wording of the three candidate emails
export function TemplatesTab() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['recruit-templates'], queryFn: async () => (await api.get('/recruitment/templates')).data.data as { placeholders: string[]; templates: any[] } })
  const [edit, setEdit] = useState<{ key: string; subject: string; body: string } | null>(null)
  const save = useMutation({
    mutationFn: async () => api.put(`/recruitment/templates/${edit!.key}`, { subject: edit!.subject, body: edit!.body }),
    onSuccess: () => { toast('Template saved'); setEdit(null); qc.invalidateQueries({ queryKey: ['recruit-templates'] }) }, onError: (e) => toast(errMsg(e), 'error'),
  })
  const reset = useMutation({
    mutationFn: async (key: string) => api.delete(`/recruitment/templates/${key}`),
    onSuccess: () => { toast('Back to the standard wording'); setEdit(null); qc.invalidateQueries({ queryKey: ['recruit-templates'] }) }, onError: (e) => toast(errMsg(e), 'error'),
  })
  if (!data) return <div className="skeleton" style={{ height: 140, borderRadius: 22 }} />
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <p className="dim" style={{ fontSize: 13 }}>Placeholders you can use: {data.placeholders.map((p) => <code key={p} style={{ marginRight: 6 }}>{`{${p}}`}</code>)}. A line whose placeholder is empty (no meeting link, no note) is left out.</p>
      {data.templates.map((t) => (
        <section key={t.key} data-card className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <strong>{t.label}{t.custom && <span className="pill honey" style={{ marginLeft: 8 }}>edited</span>}</strong>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setEdit({ key: t.key, subject: t.subject, body: t.body })}>Edit</button>
              {t.custom && <button className="btn btn-ghost btn-sm" onClick={() => reset.mutate(t.key)}>Use standard wording</button>}
            </div>
          </div>
          <div style={{ fontSize: 13 }}><span className="dim">Subject: </span>{t.subject}</div>
          <pre className="well" style={{ margin: 0, padding: 12, fontSize: 12, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{t.body}</pre>
        </section>
      ))}
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={`Edit: ${data.templates.find((t) => t.key === edit.key)?.label}`} width={620}>
          <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
            <label className="field"><span>Subject</span><input className="input" required minLength={3} value={edit.subject} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></label>
            <label className="field"><span>Message</span><textarea className="input" style={{ minHeight: 240, height: 'auto', padding: 12 }} required minLength={10} maxLength={5000} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Save</button></div>
          </form>
        </Modal>
      )}
    </div>
  )
}

// Preview, edit and send one of the candidate emails. Nothing leaves until HR presses Send.
export function EmailDialog({ c, interviews, initial, onClose, onSent }: { c: any; interviews: any[]; initial: 'interview' | 'rejection' | 'offer'; onClose: () => void; onSent: () => void }) {
  const toast = useToast()
  const scheduled = interviews.filter((i) => i.status === 'scheduled')
  const [template, setTemplate] = useState(initial)
  const [interviewId, setInterviewId] = useState(scheduled[0]?.id ?? '')
  const [link, setLink] = useState('')
  const [rejectNow, setRejectNow] = useState(false)
  const [reason, setReason] = useState('')
  const [draft, setDraft] = useState<{ to: string; subject: string; body: string; attachment: string | null } | null>(null)
  const base = { template, ...(template === 'interview' && { interviewId, ...(link && { link }) }), ...(template === 'rejection' && rejectNow && { rejectNow: true, reason }) }
  const preview = useMutation({ mutationFn: async () => (await api.post(`/recruitment/candidates/${c.id}/email/preview`, base)).data.data, onSuccess: setDraft, onError: (e) => toast(errMsg(e), 'error') })
  const send = useMutation({
    mutationFn: async () => (await api.post(`/recruitment/candidates/${c.id}/email/send`, { ...base, subject: draft!.subject, body: draft!.body })).data.data,
    onSuccess: (d: any) => { toast(`Email sent to ${d.to}`); onSent() }, onError: (e) => toast(errMsg(e), 'error'),
  })
  const ready = template === 'interview' ? !!interviewId : template === 'rejection' && rejectNow ? reason.trim().length >= 2 : true
  return (
    <Modal open onClose={onClose} title={`Email ${c.firstName} ${c.lastName}`} width={620}>
      {!draft ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <label className="field"><span>Which email</span><select className="input" value={template} onChange={(e) => setTemplate(e.target.value as any)}><option value="interview">Interview invitation</option><option value="rejection">Rejection</option><option value="offer" disabled={c.stage !== 'offer'}>Offer{c.stage !== 'offer' ? ' (make the offer first)' : ''}</option></select></label>
          {template === 'interview' && (<>
            <label className="field"><span>Interview</span>
              <select className="input" value={interviewId} onChange={(e) => setInterviewId(e.target.value)}><option value="">{scheduled.length ? 'Choose…' : 'No scheduled interview. Schedule one first.'}</option>{scheduled.map((i) => <option key={i.id} value={i.id}>{when(i.scheduledAt)} · {i.interviewer}</option>)}</select></label>
            <label className="field"><span>Meeting link (optional)</span><input className="input" type="url" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} /></label>
            <p className="dim" style={{ fontSize: 12, margin: 0 }}>A calendar file (interview.ics) is attached to the email.</p>
          </>)}
          {template === 'rejection' && (<>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}><input type="checkbox" checked={rejectNow} onChange={(e) => setRejectNow(e.target.checked)} /> Also move the candidate to Rejected when I send</label>
            {rejectNow && <label className="field"><span>Reason (kept on the candidate, not in the email)</span><input className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
          </>)}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!ready || preview.isPending} onClick={() => preview.mutate()}>Preview</button></div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="dim" style={{ fontSize: 13 }}>To {draft.to}{draft.attachment ? ` · attachment ${draft.attachment}` : ''}. You can edit the text before sending.</div>
          <label className="field"><span>Subject</span><input className="input" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></label>
          <label className="field"><span>Message</span><textarea className="input" style={{ minHeight: 240, height: 'auto', padding: 12 }} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={() => setDraft(null)}>Back</button>
            <button className="btn btn-primary" disabled={send.isPending || draft.subject.trim().length < 3 || draft.body.trim().length < 10} onClick={() => send.mutate()}><Icon name="mail" size={14} /> {template === 'rejection' && rejectNow ? 'Send and reject' : 'Send'}</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

const HISTORY_TEXT: Record<string, string> = { CANDIDATE_EMAIL_SENT: 'Email sent', OFFER_MADE: 'Offer made', OFFER_WITHDRAWN: 'Offer withdrawn', OFFER_SKIPPED_INTERVIEW: 'Offer made without an interview' }
export function HistoryCard({ id }: { id: string }) {
  const { data = [] } = useQuery({ queryKey: ['cand-history', id], queryFn: async () => (await api.get(`/recruitment/candidates/${id}/history`)).data.data as any[] })
  if (!data.length) return null
  return (
    <section data-card className="card" style={{ padding: 20, marginTop: 16 }}>
      <h3 style={{ fontSize: 15, marginBottom: 10 }}>History</h3>
      <div style={{ display: 'grid', gap: 6 }}>
        {data.map((h) => (
          <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, flexWrap: 'wrap' }}>
            <span>{HISTORY_TEXT[h.action] ?? h.action.toLowerCase().replace(/_/g, ' ')}{h.detail?.subject ? `: ${h.detail.subject}` : ''}{h.detail?.reason ? ` (${h.detail.reason})` : ''}</span>
            <span className="dim">{h.by ?? 'System'} · {when(h.at)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// The CV: a link the HR pasted, or a file uploaded here (private, opened through a short-lived link)
export function CvControls({ c, onChange }: { c: any; onChange: () => void }) {
  const toast = useToast()
  const open = async () => { try { window.open((await api.get(`/recruitment/candidates/${c.id}/cv`)).data.data.url, '_blank', 'noopener') } catch (e) { toast(errMsg(e), 'error') } }
  const upload = async (f?: File) => {
    if (!f) return
    const fd = new FormData(); fd.append('file', f)
    try { await api.post(`/recruitment/candidates/${c.id}/cv`, fd); toast('CV uploaded'); onChange() } catch (e) { toast(errMsg(e), 'error') }
  }
  const remove = async () => { try { await api.delete(`/recruitment/candidates/${c.id}/cv`); toast('CV removed'); onChange() } catch (e) { toast(errMsg(e), 'error') } }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {c.resumeFile ? <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><button className="btn btn-ghost btn-sm" onClick={open}><Icon name="file" size={14} /> Open CV ({c.resumeFile})</button>{c.canManage && <button className="btn btn-ghost btn-sm" onClick={remove}>Remove</button>}</div>
        : c.resumeUrl ? <a className="btn btn-ghost btn-sm" href={c.resumeUrl} target="_blank" rel="noopener noreferrer"><Icon name="file" size={14} /> Open CV link</a> : null}
      {c.canManage && !c.resumeFile && <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}><Icon name="plus" size={14} /> Upload CV (PDF or Word, 5 MB)<input type="file" accept=".pdf,.doc,.docx" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} /></label>}
    </div>
  )
}

export const icsDownload = (interviewId: string) => downloadCsv(`/recruitment/interviews/${interviewId}/ics`)

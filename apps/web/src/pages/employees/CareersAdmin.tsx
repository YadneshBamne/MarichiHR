import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'

// Recruitment > Careers page (HR): switch the public careers page on, write its texts, and choose which openings are shown
type Opening = { id: string; title: string; status: string; published: boolean; publicDescription: string }
type Data = { slug: string | null; enabled: boolean; headline: string; intro: string; applyNote: string; contactEmail: string; showSalary: boolean; openings: Opening[] }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const STATUS: Record<string, string> = { open: 'Open', on_hold: 'On hold', pending_approval: 'Waiting for approval' }

export default function CareersAdmin() {
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['careers-admin'], queryFn: async () => (await api.get('/recruitment/careers')).data.data as Data })
  const [f, setF] = useState({ enabled: false, headline: '', intro: '', applyNote: '', contactEmail: '', showSalary: false })
  const [edit, setEdit] = useState<Opening | null>(null)
  const [text, setText] = useState('')
  useEffect(() => { if (q.data) setF({ enabled: q.data.enabled, headline: q.data.headline, intro: q.data.intro, applyNote: q.data.applyNote, contactEmail: q.data.contactEmail, showSalary: q.data.showSalary }) }, [q.data])
  const refresh = () => qc.invalidateQueries({ queryKey: ['careers-admin'] })
  const save = useMutation({ mutationFn: async () => api.put('/recruitment/careers/settings', f), onSuccess: () => { toast('Careers page saved'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const openingSave = useMutation({
    mutationFn: async (v: { id: string; published?: boolean; publicDescription?: string }) => api.put(`/recruitment/careers/openings/${v.id}`, { ...(v.published !== undefined && { published: v.published }), ...(v.publicDescription !== undefined && { publicDescription: v.publicDescription }) }),
    onSuccess: (_r, v) => { toast(v.published === true ? 'Shown on the careers page' : v.published === false ? 'Hidden from the careers page' : 'Description saved'); setEdit(null); refresh() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  if (q.isLoading || !q.data) return <div className="skeleton" style={{ height: 260, borderRadius: 22 }} />
  const link = q.data.slug ? `${window.location.origin}/careers/${q.data.slug}` : ''
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const dirty = JSON.stringify(f) !== JSON.stringify({ enabled: q.data.enabled, headline: q.data.headline, intro: q.data.intro, applyNote: q.data.applyNote, contactEmail: q.data.contactEmail, showSalary: q.data.showSalary })
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <section className="card" style={{ padding: 20, display: 'grid', gap: 14 }}>
        <div><h2 style={{ fontSize: 18 }}>Your public careers page</h2><p className="dim" style={{ fontSize: 13, marginTop: 4 }}>A page anyone can open without signing in, with the openings you choose below and an application form. Applicants land in the opening's pipeline as "Careers page" candidates.</p></div>
        <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}><input type="checkbox" checked={f.enabled} onChange={set('enabled')} /> <span><strong>Careers page is on</strong> <span className="dim">(off means the link shows "not available")</span></span></label>
        <div className="field"><label htmlFor="cp-h">Headline</label><input id="cp-h" className="input" maxLength={120} value={f.headline} onChange={set('headline')} placeholder="Careers at your company" /></div>
        <div className="field"><label htmlFor="cp-i">Introduction</label><textarea id="cp-i" className="input" rows={3} maxLength={1500} value={f.intro} onChange={set('intro')} placeholder="Who you are and why people enjoy working with you" style={{ height: 'auto', padding: 12, borderRadius: 18 }} /></div>
        <div className="field"><label htmlFor="cp-n">Note on the application form</label><textarea id="cp-n" className="input" rows={2} maxLength={600} value={f.applyNote} onChange={set('applyNote')} placeholder="For example: we are an equal opportunity employer, or how long you keep applications" style={{ height: 'auto', padding: 12, borderRadius: 18 }} /></div>
        <div className="field" style={{ maxWidth: 360 }}><label htmlFor="cp-e">Email for questions</label><input id="cp-e" className="input" type="email" maxLength={200} value={f.contactEmail} onChange={set('contactEmail')} placeholder="careers@yourcompany.com" /></div>
        <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}><input type="checkbox" checked={f.showSalary} onChange={set('showSalary')} /> Show the salary range on each opening (taken from the opening)</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-primary" disabled={save.isPending || !dirty} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
          {link && (
            <>
              <input className="input" readOnly value={link} aria-label="Careers page link" onFocus={(e) => e.currentTarget.select()} style={{ flex: '1 1 260px', minWidth: 0 }} />
              <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Link copied'), () => toast('Select the link and copy it', 'error'))}>Copy link</button>
              <a className="btn btn-ghost btn-sm" href={link} target="_blank" rel="noopener noreferrer">{q.data.enabled ? 'Open' : 'Preview (shows "not available" until it is on)'}</a>
            </>
          )}
        </div>
      </section>

      <section className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
        <div><h2 style={{ fontSize: 18 }}>Openings on the page</h2><p className="dim" style={{ fontSize: 13, marginTop: 4 }}>Only openings that are open and switched on here appear. Pausing or closing an opening hides it at once.</p></div>
        {q.data.openings.length === 0 && <p className="dim">No openings yet. Create one on the Openings tab.</p>}
        {q.data.openings.map((o) => (
          <div key={o.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <strong style={{ fontWeight: 600 }}>{o.title}</strong>
              <div className="dim" style={{ fontSize: 12.5, display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                <span className={`pill ${o.status === 'open' ? 'ok' : 'warn'}`} style={{ textTransform: 'none' }}>{STATUS[o.status] ?? o.status}</span>
                {o.published && o.status !== 'open' && <span>Switched on, but hidden until it is open</span>}
                {!o.publicDescription && <span>No public description yet</span>}
              </div>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={o.published} disabled={openingSave.isPending} onChange={(e) => { if (e.target.checked && !o.publicDescription) { setEdit(o); setText(''); return } openingSave.mutate({ id: o.id, published: e.target.checked }) }} /> Show on careers page
            </label>
            <button className="btn btn-ghost btn-sm" onClick={() => { setEdit(o); setText(o.publicDescription) }}>{o.publicDescription ? 'Edit description' : 'Write description'}</button>
          </div>
        ))}
      </section>

      {edit && (
        <Modal open onClose={() => setEdit(null)} title={`Public description: ${edit.title}`} width={640}>
          <div style={{ display: 'grid', gap: 12 }}>
            <p className="dim" style={{ fontSize: 13 }}>What applicants read: the role, what they will do, and what you are looking for. Plain text; blank lines make paragraphs. Do not include internal notes.</p>
            <textarea className="input" rows={12} maxLength={6000} value={text} onChange={(e) => setText(e.target.value)} placeholder={'About the role\n\nWhat you will do\n- ...\n\nWhat we are looking for\n- ...'} style={{ height: 'auto', padding: 12, borderRadius: 18 }} aria-label="Public description" />
            <span className="muted" style={{ fontSize: 12, textAlign: 'right' }}>{text.length}/6000</span>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-ghost" disabled={openingSave.isPending || text.trim().length < 1} onClick={() => openingSave.mutate({ id: edit.id, publicDescription: text })}>Save only</button>
              <button className="btn btn-primary" disabled={openingSave.isPending || text.trim().length < 20} onClick={() => openingSave.mutate({ id: edit.id, publicDescription: text, published: true })}>Save and show on the page</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

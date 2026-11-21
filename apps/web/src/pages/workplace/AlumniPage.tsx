import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '')
const LETTERS: Record<string, string> = { experience: 'Experience letter', relieving: 'Relieving letter', salary_certificate: 'Salary certificate', other: 'Other letter' }
const STATUS: Record<string, [string, string]> = { requested: ['warn', 'Waiting for HR'], issued: ['ok', 'Ready'], declined: ['mute', 'Declined'] }

// One page, two views: HR sees everyone who left, switches their login on or off and answers letter requests;
// a former employee sees only their own record, the documents HR shared and their letter requests.
export default function AlumniPage() {
  const { hasRole } = useAuth()
  const alumna = hasRole('alumni') && !hasRole('hr_admin') && !hasRole('system_admin')
  return alumna ? <Mine /> : <Staff />
}

function Staff() {
  const toast = useToast()
  const qc = useQueryClient()
  const root = useReveal<HTMLDivElement>('alumni-staff')
  const [issued, setIssued] = useState<{ name: string; email: string; temporaryPassword: string } | null>(null)
  const list = useQuery({ queryKey: ['alumni'], queryFn: async () => (await api.get('/alumni')).data.data as { pendingLetters: number; alumni: any[] } })
  const letters = useQuery({ queryKey: ['alumni-letters'], queryFn: async () => (await api.get('/alumni/letters', { params: { status: 'requested' } })).data.data as any[] })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['alumni'] }); qc.invalidateQueries({ queryKey: ['alumni-letters'] }) }
  const enable = useMutation({ mutationFn: async (a: any) => ({ name: a.name, ...(await api.post(`/alumni/${a.employeeId}/enable`)).data.data }), onSuccess: (r) => { setIssued(r); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const disable = useMutation({ mutationFn: async (a: any) => (await api.post(`/alumni/${a.employeeId}/disable`)).data.data, onSuccess: () => { toast('Alumni access switched off'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div ref={root}>
      <PageHeader title="Alumni" sub="People who have left can keep a restricted login to download their letters and ask for new ones. They see nothing else." />
      {issued && (
        <div className="card" style={{ padding: 18, marginBottom: 16, display: 'grid', gap: 6 }} role="status">
          <strong>Alumni login ready for {issued.name}</strong>
          <span>Email: {issued.email}</span>
          <span>Temporary password (shown once): <code>{issued.temporaryPassword}</code></span>
          <span className="dim" style={{ fontSize: 13 }}>Send it to their personal address or phone, not a work mailbox. They choose their own password at first sign-in.</span>
          <div><button className="btn btn-ghost btn-sm" onClick={() => setIssued(null)}>Done</button></div>
        </div>
      )}
      {(letters.data?.length ?? 0) > 0 && (
        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
          <h2 style={{ fontSize: 17, marginBottom: 8 }}>Letter requests</h2>
          {letters.data!.map((l) => <LetterRow key={l.id} l={l} onDone={refresh} />)}
        </div>
      )}
      <div className="card" style={{ padding: 8 }}>
        {list.isLoading && <p style={{ padding: 16 }}>Loading…</p>}
        {list.data?.alumni.length === 0 && <p style={{ padding: 16, margin: 0 }}>No one has left yet. People appear here after their full and final settlement is paid.</p>}
        {list.data?.alumni.map((a) => (
          <div key={a.employeeId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
            <span style={{ minWidth: 0 }}><strong>{a.name}</strong> <span className="dim">{a.code}</span>
              <span className="dim" style={{ display: 'block', fontSize: 13 }}>Left {when(a.lastWorkingDate)}</span></span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className={`pill ${a.access === 'enabled' ? 'ok' : 'mute'}`}>{a.access === 'enabled' ? 'Login on' : a.access === 'disabled' ? 'Login off' : 'No login'}</span>
              {a.access === 'enabled'
                ? <button className="btn btn-ghost btn-sm" disabled={disable.isPending} onClick={() => disable.mutate(a)}>Switch off</button>
                : <button className="btn btn-primary btn-sm" disabled={enable.isPending} onClick={() => enable.mutate(a)}>{a.access === 'disabled' ? 'Switch on again' : 'Give alumni access'}</button>}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function LetterRow({ l, onDone }: { l: any; onDone: () => void }) {
  const toast = useToast()
  const [doc, setDoc] = useState('')
  const [note, setNote] = useState('')
  const issue = useMutation({ mutationFn: async () => (await api.post(`/alumni/letters/${l.id}/issue`, { documentId: doc.trim() })).data.data, onSuccess: () => { toast('Letter issued'); onDone() }, onError: (e) => toast(errMsg(e), 'error') })
  const decline = useMutation({ mutationFn: async () => (await api.post(`/alumni/letters/${l.id}/decline`, { note })).data.data, onSuccess: () => { toast('Request declined'); onDone() }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ padding: '10px 0', borderTop: '1px solid var(--line)', display: 'grid', gap: 8 }}>
      <span><strong>{l.employeeName}</strong> asked for a {LETTERS[l.type]?.toLowerCase()} <span className="dim">· {when(l.createdAt)}</span>{l.note ? <span className="dim" style={{ display: 'block', fontSize: 13 }}>“{l.note}”</span> : null}</span>
      <span className="dim" style={{ fontSize: 13 }}>Upload the letter on their profile under Documents (visible to the employee), then paste its document id here.</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 260px' }} placeholder="Document id" aria-label="Document id" value={doc} onChange={(e) => setDoc(e.target.value)} />
        <button className="btn btn-primary btn-sm" disabled={issue.isPending || doc.trim().length < 10} onClick={() => issue.mutate()}>Issue</button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 260px' }} placeholder="Reason, if you decline" aria-label="Reason for declining" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn btn-ghost btn-sm" disabled={decline.isPending || note.trim().length < 3} onClick={() => decline.mutate()}>Decline</button>
      </div>
    </div>
  )
}

function Mine() {
  const toast = useToast()
  const qc = useQueryClient()
  const root = useReveal<HTMLDivElement>('alumni-mine')
  const me = useQuery({ queryKey: ['alumni-me'], queryFn: async () => (await api.get('/alumni/me')).data.data as any })
  const docs = useQuery({ queryKey: ['alumni-docs'], queryFn: async () => (await api.get('/alumni/me/documents')).data.data as any[] })
  const letters = useQuery({ queryKey: ['alumni-my-letters'], queryFn: async () => (await api.get('/alumni/letters')).data.data as any[] })
  const [type, setType] = useState('experience')
  const [note, setNote] = useState('')
  const ask = useMutation({ mutationFn: async () => (await api.post('/alumni/me/letters', { type, ...(note.trim() && { note: note.trim() }) })).data.data, onSuccess: () => { toast('Request sent to HR'); setNote(''); qc.invalidateQueries({ queryKey: ['alumni-my-letters'] }) }, onError: (e) => toast(errMsg(e), 'error') })
  const open = async (id: string) => { try { window.open((await api.get(`/alumni/me/documents/${id}/download`)).data.data.url, '_blank', 'noopener') } catch (e) { toast(errMsg(e), 'error') } }
  return (
    <div ref={root}>
      <PageHeader title={me.data ? `Welcome back, ${String(me.data.name).split(' ')[0]}` : 'Alumni'} sub="Your letters and records from your time here." />
      {me.data && (
        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
          <strong>{me.data.name}</strong> <span className="dim">{me.data.code}</span>
          <span className="dim" style={{ display: 'block', fontSize: 14 }}>{[me.data.position, me.data.department].filter(Boolean).join(' · ')}</span>
          <span className="dim" style={{ display: 'block', fontSize: 14 }}>Joined {when(me.data.hireDate)} · Left {when(me.data.lastWorkingDate)}</span>
        </div>
      )}
      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
        <h2 style={{ fontSize: 17, marginBottom: 8 }}>Your documents</h2>
        {docs.data?.length === 0 && <p style={{ margin: 0 }} className="dim">HR hasn't shared any documents yet. Ask for a letter below.</p>}
        {docs.data?.map((d) => (
          <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--line)' }}>
            <span>{d.title || d.fileName}<span className="dim" style={{ display: 'block', fontSize: 13 }}>{when(d.createdAt)}</span></span>
            <button className="btn btn-ghost btn-sm" onClick={() => open(d.id)}>Download</button>
          </div>
        ))}
      </div>
      <div className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
        <h2 style={{ fontSize: 17 }}>Ask for a letter</h2>
        <div className="field"><label htmlFor="al-type">Which letter?</label>
          <select id="al-type" className="input" value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(LETTERS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="al-note">What is it for? (optional)</label><input id="al-note" className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></div>
        <div><button className="btn btn-primary" disabled={ask.isPending} onClick={() => ask.mutate()}>{ask.isPending ? 'Sending…' : 'Send to HR'}</button></div>
        {letters.data?.map((l) => (
          <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
            <span>{LETTERS[l.type]} <span className="dim">· {when(l.createdAt)}</span>{l.response ? <span className="dim" style={{ display: 'block', fontSize: 13 }}>{l.response}</span> : null}</span>
            <span className={`pill ${STATUS[l.status]?.[0] ?? 'mute'}`}>{STATUS[l.status]?.[1] ?? l.status}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { fmtDate } from '../../lib/format'

// Personal data (Zambia DPA 2021 and similar): everyone downloads a copy of theirs; HR handles erasure for leavers
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export default function PrivacyPage() {
  const { user, hasRole } = useAuth()
  const hr = hasRole('hr_admin') || hasRole('system_admin')
  const toast = useToast()
  const root = useReveal<HTMLDivElement>()
  const download = async (employeeId: string, label: string) => {
    try {
      const data = (await api.get(`/privacy/export/${employeeId}`)).data.data
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = `personal-data-${label}.json`; a.click()
    } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <div ref={root}>
      <PageHeader title="Your data" sub="What MarichiHR holds about you, and how personal data is erased after someone leaves." />
      <div style={{ display: 'grid', gap: 'var(--gap)' }}>
        <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
          <h3 style={{ fontSize: 16 }}>Download a copy of your data</h3>
          <p className="dim" style={{ fontSize: 13 }}>Your profile, addresses, family and emergency contacts, education and past jobs, document list, leave, two years of attendance and your payslip totals, as a JSON file. Bank and ID numbers show only their last digits.</p>
          <div><button className="btn btn-primary btn-sm" disabled={!user?.employee?.id} onClick={() => download(user!.employee!.id, user!.employee!.code ?? 'me')}>Download my data</button></div>
          <p className="dim" style={{ fontSize: 12 }}>After you leave the company you can ask HR to erase your personal details. Pay, tax and leave records are kept for the period the law requires.</p>
        </section>
        {hr && <Requests download={download} />}
      </div>
    </div>
  )
}

function Requests({ download }: { download: (id: string, label: string) => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data = [] } = useQuery({ queryKey: ['privacy-requests'], queryFn: async () => (await api.get('/privacy/requests', { params: { scope: 'all' } })).data.data as any[] })
  const { data: people = [] } = useQuery({ queryKey: ['privacy-people'], queryFn: async () => (await api.get('/employees', { params: { limit: 500, showArchived: true } })).data.data as any[] })
  const [f, setF] = useState({ employeeId: '', reason: '' })
  const ask = useMutation({
    mutationFn: () => api.post('/privacy/erasure', { employeeId: f.employeeId, ...(f.reason.trim() && { reason: f.reason.trim() }) }),
    onSuccess: () => { toast('Request recorded. Another HR admin decides it.'); setF({ employeeId: '', reason: '' }); qc.invalidateQueries({ queryKey: ['privacy-requests'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean; note?: string }) => api.post(`/privacy/requests/${v.id}/decide`, { approve: v.approve, ...(v.note && { note: v.note }) }),
    onSuccess: () => { toast('Done'); qc.invalidateQueries({ queryKey: ['privacy-requests'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const pick = people.find((p) => p.id === f.employeeId)
  return (
    <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 12 }}>
      <h3 style={{ fontSize: 16 }}>Requests (HR)</h3>
      <p className="dim" style={{ fontSize: 13 }}>Record a request someone made (by email or letter): download their data for them, or ask to erase it. Erasure is decided by an HR admin other than the one who records it, and only once the person has left. It removes their personal details, documents and login; pay, tax, leave and attendance stay under their employee code.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
        <select className="input" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })} aria-label="Person"><option value="">Person…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName} ({p.employeeCode}){!p.active ? ' · left' : ''}</option>)}</select>
        <input className="input" placeholder="What they asked for (optional)" value={f.reason} maxLength={500} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-ghost btn-sm" disabled={!pick} onClick={() => download(pick.id, pick.employeeCode)}>Download their data</button>
        <button className="btn btn-primary btn-sm" disabled={!pick || ask.isPending} onClick={() => ask.mutate()}>Ask to erase</button>
      </div>
      {data.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', borderTop: '1px solid var(--line)', paddingTop: 10, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 220 }}><strong style={{ fontWeight: 500 }}>{r.employee}</strong> <span className={`pill ${r.status === 'done' ? 'ok' : r.status === 'rejected' ? 'mute' : 'warn'}`}>{r.status === 'done' ? 'erased' : r.status}</span><div className="dim" style={{ fontSize: 12 }}>{fmtDate(r.createdAt)}{r.reason ? ` · ${r.reason}` : ''}{r.note ? ` · ${r.note}` : ''}{r.status === 'pending' && !r.hasLeft ? ' · still employed: finish their exit first' : ''}</div></span>
          {r.status === 'pending' && <>
            <button className="btn btn-primary btn-sm" disabled={decide.isPending || !r.hasLeft} onClick={() => { if (confirm('Erase this person’s personal details, documents and login? This cannot be undone.')) decide.mutate({ id: r.id, approve: true }) }}>Erase</button>
            <button className="btn btn-ghost btn-sm" disabled={decide.isPending} onClick={() => { const note = window.prompt('Why decline?'); if (note) decide.mutate({ id: r.id, approve: false, note }) }}>Decline</button>
          </>}
        </div>
      ))}
    </section>
  )
}

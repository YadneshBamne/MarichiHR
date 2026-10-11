import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Icon from '../../components/ui/Icon'
import Modal from '../../components/ui/Modal'
import MasterSelect from '../../components/ui/MasterSelect'
import PageHeader from '../../components/ui/PageHeader'
import { useToast } from '../../components/ui/Toast'
import { useAuth } from '../../contexts/AuthContext'
import { useMasters } from '../../lib/hooks/useMasters'
import { useReveal } from '../../lib/motion'
import { fmtDate } from '../../lib/format'

interface Doc { id: string; category: string; title: string; fileName: string; mimeType: string; size: number; expiryDate: string | null; visibility: 'employee' | 'hr'; createdAt: string }
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx'
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const expiring = (d: string | null) => d && new Date(d).getTime() - Date.now() < 30 * 86400000

// Files on a person: the person and HR see them; HR can keep some HR-only
export default function DocumentsTab({ employeeId }: { employeeId: string }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { hasRole } = useAuth()
  const hr = hasRole('hr_admin') || hasRole('system_admin')
  const { label } = useMasters()
  const { data, isLoading } = useQuery({ queryKey: ['documents', employeeId], queryFn: async () => (await api.get(`/employees/${employeeId}/documents`)).data.data as { documents: Doc[]; canUpload: boolean; storageReady: boolean } })
  const [adding, setAdding] = useState(false)
  const refresh = () => qc.invalidateQueries({ queryKey: ['documents', employeeId] })
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/employees/${employeeId}/documents/${id}`), onSuccess: () => { toast('Removed'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const open = async (d: Doc) => {
    try { window.open((await api.get(`/employees/${employeeId}/documents/${d.id}/download`)).data.data.url, '_blank', 'noopener') } catch (e) { toast(errMsg(e), 'error') }
  }
  if (isLoading || !data) return <div className="skeleton" style={{ height: 160, borderRadius: 14 }} />
  const groups = [...new Set(data.documents.map((d) => d.category))]
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15 }}>Documents</h3>
        {data.canUpload && <button className="btn btn-primary btn-sm" disabled={!data.storageReady} onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Upload</button>}
      </div>
      {!data.storageReady && <p className="pill warn" style={{ whiteSpace: 'normal' }}>Document storage isn't set up on this server yet.</p>}
      {!data.documents.length ? <p className="dim" style={{ fontSize: 13 }}>{data.canUpload ? 'No documents yet. Upload a CV, ID scan, licence or letter.' : 'Only the person and HR can see documents.'}</p> : groups.map((g) => (
        <div key={g} style={{ display: 'grid', gap: 6 }}>
          <span className="dim" style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase' }}>{label('document_category', g)}</span>
          {data.documents.filter((d) => d.category === g).map((d) => (
            <div key={d.id} className="well" style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 2, fontSize: 13, minWidth: 0 }}>
                <strong style={{ fontWeight: 600, overflowWrap: 'anywhere' }}><Icon name="file" size={13} /> {d.title}</strong>
                <span className="dim">{d.fileName} · {kb(d.size)} · added {fmtDate(d.createdAt)}{d.expiryDate ? ` · expires ${fmtDate(d.expiryDate)}` : ''}</span>
              </div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                {expiring(d.expiryDate) && <span className="pill warn">{new Date(d.expiryDate!) < new Date() ? 'expired' : 'expires soon'}</span>}
                {d.visibility === 'hr' && <span className="pill night">HR only</span>}
                <button className="btn btn-ghost btn-sm" onClick={() => open(d)}><Icon name="download" size={13} /> Open</button>
                <button className="btn btn-ghost btn-sm" onClick={() => remove.mutate(d.id)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      ))}
      {adding && <UploadModal employeeId={employeeId} hr={hr} onClose={(ok) => { setAdding(false); if (ok) refresh() }} />}
    </div>
  )
}

function UploadModal({ employeeId, hr, onClose }: { employeeId: string; hr: boolean; onClose: (ok?: boolean) => void }) {
  const toast = useToast()
  const [f, setF] = useState({ category: 'cv', title: '', expiryDate: '', visibility: 'employee' })
  const [file, setFile] = useState<File | null>(null)
  const save = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      fd.append('category', f.category)
      if (f.title) fd.append('title', f.title)
      if (f.expiryDate) fd.append('expiryDate', f.expiryDate)
      if (hr) fd.append('visibility', f.visibility)
      fd.append('file', file!)
      return api.post(`/employees/${employeeId}/documents`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    },
    onSuccess: () => { toast('Uploaded'); onClose(true) }, onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={() => onClose()} title="Upload a document">
      <form onSubmit={(e) => { e.preventDefault(); if (file) save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>File (PDF, image or Word, up to 10 MB)</span><input className="input" type="file" accept={ACCEPT} required onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          <label className="field"><span>Category</span><MasterSelect list="document_category" value={f.category} onChange={(v) => setF({ ...f, category: v })} /></label>
          <label className="field"><span>Title</span><input className="input" maxLength={160} placeholder={file?.name ?? 'Optional'} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="field"><span>Expires (optional)</span><input className="input" type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} /></label>
          {hr && <label className="field"><span>Who can see it</span><select className="input select" value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}><option value="employee">The person and HR</option><option value="hr">HR only</option></select></label>}
        </div>
        {f.expiryDate && <span className="dim" style={{ fontSize: 12 }}>The person and HR are reminded 30 days and 7 days before, and on the day.</span>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={!file || save.isPending}>{save.isPending ? 'Uploading…' : 'Upload'}</button></div>
      </form>
    </Modal>
  )
}

// HR: many files at once, each named after the person's employee ID
export function BulkDocumentsPage() {
  const toast = useToast()
  const [category, setCategory] = useState('cv')
  const [visibility, setVisibility] = useState('employee')
  const [files, setFiles] = useState<File[]>([])
  const [result, setResult] = useState<{ uploaded: number; results: { file: string; status: string; employeeCode?: string; error?: string }[] } | null>(null)
  const root = useReveal<HTMLDivElement>(!!result)
  const send = useMutation({
    mutationFn: async () => {
      const all: NonNullable<typeof result>['results'] = []
      for (let i = 0; i < files.length; i += 20) { // 20 per request keeps each upload small
        const fd = new FormData()
        fd.append('category', category)
        fd.append('visibility', visibility)
        files.slice(i, i + 20).forEach((f) => fd.append('files', f))
        all.push(...(await api.post('/employees/documents/bulk', fd, { headers: { 'Content-Type': 'multipart/form-data' } })).data.data.results)
      }
      return { uploaded: all.filter((r) => r.status === 'uploaded').length, results: all }
    },
    onSuccess: (r) => { setResult(r); toast(`${r.uploaded} of ${r.results.length} uploaded`) }, onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <div ref={root}>
      <PageHeader title="Upload documents" sub="Many files at once, matched to people by employee ID" actions={<Link to="/employees" className="btn btn-ghost btn-sm"><Icon name="chevronLeft" size={14} /> Employees</Link>} />
      <section data-card className="card" style={{ padding: 22, display: 'grid', gap: 14, maxWidth: 760 }}>
        <p className="dim" style={{ fontSize: 13 }}>Name each file starting with the person's employee ID, for example <b>EMP0042.pdf</b> or <b>EMP0042 - driving licence.jpg</b>. Text after the ID becomes the document title.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          <label className="field"><span>Category for all files</span><MasterSelect list="document_category" value={category} onChange={setCategory} /></label>
          <label className="field"><span>Who can see them</span><select className="input select" value={visibility} onChange={(e) => setVisibility(e.target.value)}><option value="employee">The person and HR</option><option value="hr">HR only</option></select></label>
        </div>
        <label className="field"><span>Files (up to 10 MB each)</span><input className="input" type="file" multiple accept={ACCEPT} onChange={(e) => { setFiles([...(e.target.files ?? [])]); setResult(null) }} /></label>
        <div><button className="btn btn-primary" disabled={!files.length || send.isPending} onClick={() => send.mutate()}>{send.isPending ? 'Uploading…' : `Upload ${files.length || ''} file${files.length === 1 ? '' : 's'}`}</button></div>
      </section>
      {result && (
        <section data-card className="card" style={{ padding: 8, marginTop: 18, overflowX: 'auto', maxWidth: 760 }}>
          <table className="tbl" style={{ width: '100%', minWidth: 480 }}>
            <thead><tr><th>File</th><th>Person</th><th>Result</th></tr></thead>
            <tbody>{result.results.map((r) => <tr key={r.file}><td style={{ overflowWrap: 'anywhere' }}>{r.file}</td><td>{r.employeeCode ?? '—'}</td><td>{r.status === 'uploaded' ? <span className="pill ok">uploaded</span> : <span style={{ color: 'var(--danger)', fontSize: 13 }}>{r.error}</span>}</td></tr>)}</tbody>
          </table>
        </section>
      )}
    </div>
  )
}

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import MasterSelect from '../../components/ui/MasterSelect'
import { useToast } from '../../components/ui/Toast'
import { useMasters } from '../../lib/hooks/useMasters'
import { useOrgTree, useJobPositions, useWorkLocations, useEmployees } from '../../lib/hooks/useEmployees'
import { COUNTRIES } from '../../components/company/CompanyParts'
import { fmtDate } from '../../lib/format'

// The full employee record (personal, job, family, qualifications, identity), shown and edited by section.
// Which fields appear, which are required and what the person may edit come from the company's form settings.

export interface FieldSetting { key: string; label: string; section: string; kind: string; master: string | null; locked: boolean; sensitive: boolean; mode: 'display' | 'mandatory' | 'hidden'; employeeCanEdit: boolean }
export interface Record360 {
  employeeId: string; values: Record<string, any>; customFields: Record<string, any>
  addresses: any[]; family: any[]; emergencyContacts: any[]; education: any[]; previousEmployment: any[]; identities: any[]; positionHistory: any[]
  settings: { fields: FieldSetting[]; customFields: { id: string; key: string; label: string; section: string; type: string; masterList: string | null; options: { code: string; label: string }[] | null; active: boolean }[] }
  can: { seeSensitive: boolean; editAny: boolean; edit: Record<string, boolean>; verify: boolean; reveal: boolean }
  missing: string[]
}

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const country = (c?: string | null) => (c ? COUNTRIES.find(([k]) => k === c)?.[1] ?? c : '')

export function useRecord(employeeId: string) {
  return useQuery({ queryKey: ['record', employeeId], queryFn: async () => (await api.get(`/employees/${employeeId}/record`)).data.data as Record360 })
}
function useRefresh(employeeId: string) {
  const qc = useQueryClient()
  return () => { qc.invalidateQueries({ queryKey: ['record', employeeId] }); qc.invalidateQueries({ queryKey: ['employee', employeeId] }); qc.invalidateQueries({ queryKey: ['employee-360', employeeId] }) }
}

function Row({ label, value, required }: { label: string; value?: React.ReactNode; required?: boolean }) {
  const empty = value == null || value === '' || (Array.isArray(value) && !value.length)
  return (
    <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
      <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 500 }}>{label}{required && empty && <span style={{ color: 'var(--danger)' }}> · required</span>}</span>
      <span style={{ fontSize: 13, color: empty ? 'var(--line-2)' : 'var(--ink)', overflowWrap: 'anywhere' }}>{empty ? '—' : value}</span>
    </div>
  )
}
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 18 }
const card: React.CSSProperties = { display: 'grid', gap: 14 }
function Head({ title, action }: { title: string; action?: React.ReactNode }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><h3 style={{ fontSize: 15 }}>{title}</h3>{action}</div>
}

export function MissingBanner({ rec }: { rec: Record360 }) {
  if (!rec.missing.length) return null
  return <div className="well" style={{ padding: '10px 14px', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Icon name="alert" size={14} /> <strong style={{ fontWeight: 600 }}>Still needed:</strong> {rec.missing.join(', ')}</div>
}

// ─── Scalar fields (personal, contact, job) ───────────────────────────────────

function display(f: FieldSetting, v: any, label: (k: string, c?: string | null) => string) {
  if (v == null || v === '') return null
  if (f.kind === 'date') return fmtDate(v)
  if (f.kind === 'master') return label(f.master!, v)
  if (f.kind === 'masters') return (v as string[]).map((c) => label(f.master!, c)).join(', ')
  if (f.kind === 'country') return country(v)
  return String(v)
}

export function FieldsCard({ rec, sections, title }: { rec: Record360; sections: string[]; title: string }) {
  const toast = useToast()
  const refresh = useRefresh(rec.employeeId)
  const { label, values: options } = useMasters()
  const fields = rec.settings.fields.filter((f) => sections.includes(f.section) && f.kind !== 'section' && f.mode !== 'hidden' && f.key in rec.values)
  const editable = fields.filter((f) => rec.can.edit[f.key] && !['employmentType', 'employeeCategory', 'workEmail'].includes(f.key))
  const [form, setForm] = useState<Record<string, any> | null>(null)
  const save = useMutation({
    mutationFn: async () => {
      const changed = Object.fromEntries(Object.entries(form!).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(rec.values[k] ?? null)))
      return api.patch(`/employees/${rec.employeeId}/record`, { values: changed })
    },
    onSuccess: () => { toast('Saved'); setForm(null); refresh() }, onError: (e) => toast(errMsg(e), 'error'),
  })
  const input = (f: FieldSetting) => {
    const v = form![f.key] ?? ''
    const set = (x: any) => setForm({ ...form!, [f.key]: x === '' ? null : x })
    if (f.kind === 'master') return <MasterSelect list={f.master!} value={v} onChange={set} placeholder="—" />
    if (f.kind === 'masters') return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{options(f.master!).map((o) => { const on = (v || []).includes(o.code); return <button type="button" key={o.code} className="chip" aria-pressed={on} onClick={() => set(on ? v.filter((c: string) => c !== o.code) : [...(v || []), o.code])} style={on ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{o.label}</button> })}</div>
    )
    if (f.kind === 'country') return <select className="input select" value={v} onChange={(e) => set(e.target.value)}><option value="">—</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
    return <input className="input" type={f.kind === 'date' ? 'date' : f.kind === 'email' ? 'email' : f.kind === 'phone' ? 'tel' : 'text'} value={v} maxLength={200} onChange={(e) => set(e.target.value)} />
  }
  return (
    <section style={card}>
      <Head title={title} action={editable.length > 0 && !form ? <button className="btn btn-ghost btn-sm" onClick={() => setForm(Object.fromEntries(editable.map((f) => [f.key, rec.values[f.key]])))}><Icon name="settings" size={13} /> Edit</button> : undefined} />
      {form ? (
        <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 14 }}>
          <div style={grid}>{editable.map((f) => <label key={f.key} className="field" style={{ minWidth: 0 }}><span>{f.label}{f.mode === 'mandatory' && ' *'}</span>{input(f)}</label>)}</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm(null)}>Cancel</button><button className="btn btn-primary btn-sm" disabled={save.isPending}>Save</button></div>
        </form>
      ) : <div style={grid}>{fields.map((f) => <Row key={f.key} label={f.label} value={display(f, rec.values[f.key], label)} required={f.mode === 'mandatory'} />)}</div>}
    </section>
  )
}

// ─── List sections ────────────────────────────────────────────────────────────

interface Col { key: string; label: string; type?: 'text' | 'date' | 'master' | 'number' | 'year' | 'bool' | 'country' | 'select' | 'email' | 'phone'; master?: string; options?: [string, string][]; required?: boolean; wide?: boolean }
const SPECS: Record<string, { title: string; cols: Col[]; summary: (x: any, l: (k: string, c?: string | null) => string) => React.ReactNode }> = {
  addresses: {
    title: 'Addresses',
    cols: [{ key: 'kind', label: 'Type', type: 'select', options: [['present', 'Present'], ['permanent', 'Permanent'], ['contact', 'Contact']], required: true }, { key: 'line1', label: 'Address line 1', required: true, wide: true }, { key: 'line2', label: 'Address line 2', wide: true }, { key: 'city', label: 'City' }, { key: 'state', label: 'Province / state' }, { key: 'postalCode', label: 'Postal code' }, { key: 'country', label: 'Country', type: 'country' }],
    summary: (x) => <><strong style={{ textTransform: 'capitalize' }}>{x.kind}</strong><span className="dim">{[x.line1, x.line2, x.city, x.state, x.postalCode, country(x.country)].filter(Boolean).join(', ')}</span></>,
  },
  emergencyContacts: {
    title: 'Emergency contacts',
    cols: [{ key: 'name', label: 'Name', required: true }, { key: 'relationship', label: 'Relationship', type: 'master', master: 'relationship', required: true }, { key: 'phone', label: 'Phone', type: 'phone', required: true }, { key: 'altPhone', label: 'Other phone', type: 'phone' }, { key: 'email', label: 'Email', type: 'email' }, { key: 'priority', label: 'Call order', type: 'number' }],
    summary: (x, l) => <><strong>{x.name}</strong><span className="dim">{l('relationship', x.relationship)} · {x.phone}{x.altPhone ? ` / ${x.altPhone}` : ''}</span></>,
  },
  family: {
    title: 'Family & nominees',
    cols: [{ key: 'name', label: 'Name', required: true }, { key: 'relationship', label: 'Relationship', type: 'master', master: 'relationship', required: true }, { key: 'dateOfBirth', label: 'Date of birth', type: 'date' }, { key: 'gender', label: 'Gender', type: 'master', master: 'gender' }, { key: 'bloodGroup', label: 'Blood group', type: 'master', master: 'blood_group' }, { key: 'nationality', label: 'Nationality', type: 'master', master: 'nationality' }, { key: 'profession', label: 'Profession' }, { key: 'phone', label: 'Phone', type: 'phone' }, { key: 'isDependent', label: 'Dependent', type: 'bool' }, { key: 'nomineeShare', label: 'Nominee share %', type: 'number' }],
    summary: (x, l) => <><strong>{x.name}</strong><span className="dim">{[l('relationship', x.relationship), x.dateOfBirth && fmtDate(x.dateOfBirth), x.isDependent && 'dependent', x.nomineeShare != null && `nominee ${x.nomineeShare}%`].filter(Boolean).join(' · ')}</span></>,
  },
  education: {
    title: 'Education',
    cols: [{ key: 'qualification', label: 'Qualification', type: 'master', master: 'qualification', required: true }, { key: 'institute', label: 'Institute', required: true, wide: true }, { key: 'specialisation', label: 'Specialisation' }, { key: 'startYear', label: 'From (year)', type: 'year' }, { key: 'endYear', label: 'To (year)', type: 'year' }, { key: 'grade', label: 'Grade / score' }],
    summary: (x, l) => <><strong>{l('qualification', x.qualification)}{x.specialisation ? `, ${x.specialisation}` : ''}</strong><span className="dim">{x.institute}{x.startYear || x.endYear ? ` · ${x.startYear ?? ''}–${x.endYear ?? ''}` : ''}{x.grade ? ` · ${x.grade}` : ''}</span></>,
  },
  previousEmployment: {
    title: 'Previous employment',
    cols: [{ key: 'company', label: 'Company', required: true, wide: true }, { key: 'designation', label: 'Designation' }, { key: 'fromDate', label: 'From', type: 'date' }, { key: 'toDate', label: 'To', type: 'date' }, { key: 'reasonForLeaving', label: 'Reason for leaving', wide: true }, { key: 'lastSalary', label: 'Last salary', type: 'number' }, { key: 'currency', label: 'Currency' }, { key: 'pfMemberId', label: 'PF member ID' }],
    summary: (x) => <><strong>{x.company}</strong><span className="dim">{[x.designation, (x.fromDate || x.toDate) && `${x.fromDate ? fmtDate(x.fromDate) : '?'} – ${x.toDate ? fmtDate(x.toDate) : '?'}`, x.reasonForLeaving].filter(Boolean).join(' · ')}</span></>,
  },
}

export function ListSection({ rec, section }: { rec: Record360; section: keyof typeof SPECS }) {
  const toast = useToast()
  const refresh = useRefresh(rec.employeeId)
  const { label } = useMasters()
  const spec = SPECS[section]
  const setting = rec.settings.fields.find((f) => f.key === section)
  const [edit, setEdit] = useState<Record<string, any> | null>(null)
  const rows: any[] = (rec as any)[section] ?? []
  const canEdit = !!rec.can.edit[section]
  const act = useMutation({ mutationFn: async (f: () => Promise<unknown>) => f(), onSuccess: () => { refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  if (!setting || setting.mode === 'hidden') return null
  if (setting.sensitive && !rec.can.seeSensitive) return null
  const submit = () => act.mutate(async () => {
    const body: Record<string, any> = {}
    for (const c of spec.cols) {
      let v = edit![c.key]
      if (v === '' || v === undefined) v = null
      if (v != null && (c.type === 'number' || c.type === 'year')) v = Number(v)
      if (c.key === 'kind' || v !== null || edit!.id) body[c.key] = v
    }
    if (edit!.id) { delete body.kind; await api.patch(`/employees/${rec.employeeId}/record/${section}/${edit!.id}`, body) } else await api.post(`/employees/${rec.employeeId}/record/${section}`, body)
    toast('Saved'); setEdit(null)
  })
  const field = (c: Col) => {
    const v = edit![c.key] ?? ''
    const set = (x: any) => setEdit({ ...edit!, [c.key]: x })
    if (c.type === 'master') return <MasterSelect list={c.master!} value={v} onChange={set} placeholder="—" required={c.required} />
    if (c.type === 'select') return <select className="input select" value={v} disabled={!!edit!.id} onChange={(e) => set(e.target.value)}>{c.options!.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
    if (c.type === 'country') return <select className="input select" value={v} onChange={(e) => set(e.target.value)}><option value="">—</option>{COUNTRIES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
    if (c.type === 'bool') return <label style={{ display: 'flex', gap: 8, alignItems: 'center', height: 40 }}><input type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} /> Yes</label>
    return <input className="input" required={c.required} type={c.type === 'date' ? 'date' : c.type === 'number' || c.type === 'year' ? 'number' : c.type === 'email' ? 'email' : c.type === 'phone' ? 'tel' : 'text'} step={c.type === 'number' ? 'any' : undefined} value={v} onChange={(e) => set(e.target.value)} />
  }
  return (
    <section style={card}>
      <Head title={`${spec.title}${setting.mode === 'mandatory' ? ' *' : ''}`} action={canEdit ? <button className="btn btn-ghost btn-sm" onClick={() => setEdit(section === 'addresses' ? { kind: ['present', 'permanent', 'contact'].find((k) => !rows.some((r) => r.kind === k)) ?? 'present' } : section === 'emergencyContacts' ? { priority: rows.length + 1 } : {})}><Icon name="plus" size={13} /> Add</button> : undefined} />
      {!rows.length ? <p className="dim" style={{ fontSize: 13 }}>Nothing added yet.</p> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {rows.map((x) => (
            <div key={x.id} className="well" style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 2, fontSize: 13, minWidth: 0 }}>{spec.summary(x, label)}</div>
              {canEdit && <div style={{ display: 'flex', gap: 4 }}><button className="btn btn-ghost btn-sm" onClick={() => setEdit({ ...x })}>Edit</button><button className="btn btn-ghost btn-sm" onClick={() => act.mutate(() => api.delete(`/employees/${rec.employeeId}/record/${section}/${x.id}`))}>Remove</button></div>}
            </div>
          ))}
        </div>
      )}
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={`${edit.id ? 'Edit' : 'Add'}: ${spec.title.toLowerCase()}`}>
          <form onSubmit={(e) => { e.preventDefault(); submit() }} style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
              {spec.cols.map((c) => <label key={c.key} className="field" style={{ gridColumn: c.wide ? '1 / -1' : undefined, minWidth: 0 }}><span>{c.label}{c.required && ' *'}</span>{field(c)}</label>)}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={act.isPending}>Save</button></div>
          </form>
        </Modal>
      )}
    </section>
  )
}

// ─── Identity documents ───────────────────────────────────────────────────────

export function IdentitySection({ rec }: { rec: Record360 }) {
  const toast = useToast()
  const refresh = useRefresh(rec.employeeId)
  const { label, values } = useMasters()
  const setting = rec.settings.fields.find((f) => f.key === 'identities')
  const [edit, setEdit] = useState<Record<string, any> | null>(null)
  const [shown, setShown] = useState<Record<string, string>>({})
  const canEdit = !!rec.can.edit.identities
  const act = useMutation({ mutationFn: async (f: () => Promise<unknown>) => f(), onSuccess: () => refresh(), onError: (e) => toast(errMsg(e), 'error') })
  if (!setting || setting.mode === 'hidden' || !rec.can.seeSensitive) return null
  const hasExpiry = (t?: string) => !!values('identity_document').find((x) => x.code === t)?.meta?.hasExpiry
  const soon = (d?: string | null) => d && new Date(d).getTime() - Date.now() < 60 * 86400000
  const submit = () => act.mutate(async () => {
    const body: any = { issueDate: edit!.issueDate || null, expiryDate: edit!.expiryDate || null, issuingCountry: edit!.issuingCountry || null, details: edit!.details || null }
    if (edit!.number) body.number = edit!.number
    if (edit!.id) await api.patch(`/employees/${rec.employeeId}/identities/${edit!.id}`, body)
    else await api.post(`/employees/${rec.employeeId}/identities`, { ...body, documentType: edit!.documentType })
    toast('Saved'); setEdit(null)
  })
  const reveal = async (id: string) => {
    try { const r = await api.post(`/employees/${rec.employeeId}/identities/${id}/reveal`); setShown({ ...shown, [id]: r.data.data.number }) } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <section style={card}>
      <Head title={`Identity documents${setting.mode === 'mandatory' ? ' *' : ''}`} action={canEdit ? <button className="btn btn-ghost btn-sm" onClick={() => setEdit({ documentType: values('identity_document').find((d) => !rec.identities.some((i) => i.documentType === d.code))?.code ?? '' })}><Icon name="plus" size={13} /> Add</button> : undefined} />
      {!rec.identities.length ? <p className="dim" style={{ fontSize: 13 }}>No documents recorded.</p> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {rec.identities.map((i) => (
            <div key={i.id} className="well" style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 2, fontSize: 13 }}>
                <strong>{label('identity_document', i.documentType)} <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 400 }}>{shown[i.id] ?? i.numberMasked}</span></strong>
                <span className="dim">{[i.issuingCountry && country(i.issuingCountry), i.details, i.issueDate && `issued ${fmtDate(i.issueDate)}`, i.expiryDate && `expires ${fmtDate(i.expiryDate)}`].filter(Boolean).join(' · ')}</span>
              </div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                {soon(i.expiryDate) && <span className="pill warn">{new Date(i.expiryDate) < new Date() ? 'expired' : 'expires soon'}</span>}
                <span className={`pill ${i.verified ? 'ok' : 'mute'}`}>{i.verified ? 'verified' : 'not verified'}</span>
                {rec.can.reveal && !shown[i.id] && <button className="btn btn-ghost btn-sm" onClick={() => reveal(i.id)}>Show</button>}
                {rec.can.verify && !i.verified && <button className="btn btn-ghost btn-sm" onClick={() => act.mutate(() => api.post(`/employees/${rec.employeeId}/identities/${i.id}/verify`))}>Verify</button>}
                {canEdit && <button className="btn btn-ghost btn-sm" onClick={() => setEdit({ ...i, number: '' })}>Edit</button>}
                {canEdit && (rec.can.editAny || !i.verified) && <button className="btn btn-ghost btn-sm" onClick={() => act.mutate(() => api.delete(`/employees/${rec.employeeId}/identities/${i.id}`))}>Remove</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="dim" style={{ fontSize: 12 }}>Numbers are stored encrypted. HR sees a full number only on request, and each look is recorded in the audit log.</p>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? `Edit ${label('identity_document', edit.documentType)}` : 'Add identity document'}>
          <form onSubmit={(e) => { e.preventDefault(); submit() }} style={{ display: 'grid', gap: 12 }}>
            {!edit.id && <label className="field"><span>Document</span><MasterSelect list="identity_document" value={edit.documentType} onChange={(v) => setEdit({ ...edit, documentType: v })} required placeholder="Choose…" /></label>}
            <label className="field"><span>{edit.id ? 'New number (leave empty to keep the current one)' : 'Number *'}</span><input className="input" autoComplete="off" required={!edit.id} value={edit.number} maxLength={40} onChange={(e) => setEdit({ ...edit, number: e.target.value })} /></label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
              <label className="field"><span>Issued</span><input className="input" type="date" value={edit.issueDate ?? ''} onChange={(e) => setEdit({ ...edit, issueDate: e.target.value })} /></label>
              {hasExpiry(edit.documentType) && <label className="field"><span>Expires</span><input className="input" type="date" value={edit.expiryDate ?? ''} onChange={(e) => setEdit({ ...edit, expiryDate: e.target.value })} /></label>}
              <label className="field"><span>Issuing country</span><select className="input select" value={edit.issuingCountry ?? ''} onChange={(e) => setEdit({ ...edit, issuingCountry: e.target.value })}><option value="">—</option>{COUNTRIES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
              <label className="field"><span>{edit.documentType === 'driving_licence' ? 'Licence class' : 'Details'}</span><input className="input" value={edit.details ?? ''} maxLength={100} onChange={(e) => setEdit({ ...edit, details: e.target.value })} /></label>
            </div>
            {edit.id && <span className="dim" style={{ fontSize: 12 }}>Changing the document clears its verification; HR checks it again.</span>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={act.isPending}>Save</button></div>
          </form>
        </Modal>
      )}
    </section>
  )
}

// ─── Position history ─────────────────────────────────────────────────────────

export function PositionHistory({ rec }: { rec: Record360 }) {
  const toast = useToast()
  const refresh = useRefresh(rec.employeeId)
  const { label } = useMasters()
  const [open, setOpen] = useState(false)
  return (
    <section style={card}>
      <Head title="Position history" action={rec.can.editAny ? <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}><Icon name="arrowRight" size={13} /> Change position</button> : undefined} />
      <div style={{ display: 'grid', gap: 0 }}>
        {rec.positionHistory.map((h, i) => (
          <div key={h.id} style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: 12, padding: '10px 0', borderTop: i ? '1px solid var(--line)' : undefined, fontSize: 13 }}>
            <span className="dim">{fmtDate(h.effectiveFrom)}{!h.applied && <span className="pill info" style={{ marginLeft: 6 }}>scheduled</span>}</span>
            <span><strong style={{ fontWeight: 600 }}>{h.reason ?? 'Change'}</strong>
              <span className="dim" style={{ display: 'block' }}>{[h.department, h.position, h.manager && `reports to ${h.manager}`, h.location, h.employmentType && label('employment_type', h.employmentType), h.employeeCategory && label('employee_category', h.employeeCategory)].filter(Boolean).join(' · ') || 'No placement change recorded'}</span>
            </span>
          </div>
        ))}
      </div>
      {open && <PositionModal rec={rec} onClose={(ok) => { setOpen(false); if (ok) { toast('Position change saved'); refresh() } }} />}
    </section>
  )
}

function PositionModal({ rec, onClose }: { rec: Record360; onClose: (ok?: boolean) => void }) {
  const toast = useToast()
  const { data: tree } = useOrgTree()
  const { data: positions = [] } = useJobPositions()
  const { data: locations = [] } = useWorkLocations()
  const { data: people } = useEmployees({ limit: 500 })
  const { data: payGroups = [] } = useQuery({ queryKey: ['pay-groups'], queryFn: async () => (await api.get('/payroll/pay-groups')).data.data as { id: string; name: string; active: boolean }[] })
  const { data: entities = [] } = useQuery({ queryKey: ['legal-entities'], queryFn: async () => (await api.get('/company/entities')).data.data as { id: string; name: string; active: boolean }[] })
  const units: { id: string; name: string; depth: number }[] = []
  const walk = (ns: any[], d: number) => (ns ?? []).forEach((n) => { units.push({ id: n.id, name: n.name, depth: d }); walk(n.children ?? [], d + 1) })
  walk(Array.isArray(tree) ? tree : tree ? [tree] : [], 0)
  const [f, setF] = useState<Record<string, string>>({ effectiveFrom: new Date().toISOString().slice(0, 10), reason: '' })
  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, any> = { effectiveFrom: f.effectiveFrom, reason: f.reason }
      for (const k of ['orgUnitId', 'jobPositionId', 'managerId', 'workLocationId', 'employmentType', 'employeeCategory']) if (f[k] !== undefined) body[k] = f[k] === '__none' ? null : f[k]
      // The employing entity applies now (it is not part of the dated position history)
      if (f.legalEntityId !== undefined || f.payGroupId !== undefined) await api.patch(`/employees/${rec.employeeId}`, { ...(f.legalEntityId !== undefined && { legalEntityId: f.legalEntityId === '__none' ? null : f.legalEntityId }), ...(f.payGroupId !== undefined && { payGroupId: f.payGroupId === '__none' ? null : f.payGroupId }) })
      if (Object.keys(body).length > 2 || (f.legalEntityId === undefined && f.payGroupId === undefined)) await api.post(`/employees/${rec.employeeId}/position`, body)
    },
    onSuccess: () => onClose(true), onError: (e) => toast(errMsg(e), 'error'),
  })
  const sel = (k: string, items: [string, string][], allowNone = true) => (
    <select className="input select" value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value || (undefined as any) })}>
      <option value="">Keep as is</option>{allowNone && <option value="__none">None</option>}{items.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
    </select>
  )
  return (
    <Modal open onClose={() => onClose()} title="Change position">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          <label className="field"><span>Effective from *</span><input className="input" type="date" required value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></label>
          <label className="field"><span>Department</span>{sel('orgUnitId', units.map((u) => [u.id, `${'  '.repeat(u.depth)}${u.name}`]), false)}</label>
          <label className="field"><span>Position</span>{sel('jobPositionId', (positions as any[]).map((p) => [p.id, p.title]))}</label>
          <label className="field"><span>Reports to</span>{sel('managerId', ((people?.data ?? []) as any[]).filter((p) => p.id !== rec.employeeId).map((p) => [p.id, `${p.firstName} ${p.lastName}`]))}</label>
          <label className="field"><span>Work location</span>{sel('workLocationId', (locations as any[]).map((l) => [l.id, l.name]))}</label>
          {payGroups.some((x) => x.active) && <label className="field"><span>Pay group (applies now)</span>{sel('payGroupId', payGroups.filter((x) => x.active).map((x) => [x.id, x.name]))}</label>}
          {entities.length > 0 && <label className="field"><span>Employing entity (applies now)</span>{sel('legalEntityId', entities.filter((x) => x.active).map((x) => [x.id, x.name]))}</label>}
          <label className="field"><span>Employment type</span><MasterSelect list="employment_type" value={f.employmentType ?? ''} onChange={(v) => setF({ ...f, employmentType: v || (undefined as any) })} placeholder="Keep as is" /></label>
          <label className="field"><span>Employee category</span><MasterSelect list="employee_category" value={f.employeeCategory ?? ''} onChange={(v) => setF({ ...f, employeeCategory: v || (undefined as any) })} placeholder="Keep as is" /></label>
        </div>
        <label className="field"><span>Reason *</span><input className="input" required minLength={2} maxLength={300} placeholder="Promotion, transfer, new manager…" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
        <span className="dim" style={{ fontSize: 12 }}>A future date is applied automatically on the day.</span>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Save</button></div>
      </form>
    </Modal>
  )
}

// ─── Custom fields ────────────────────────────────────────────────────────────

export function CustomFieldsCard({ rec }: { rec: Record360 }) {
  const toast = useToast()
  const refresh = useRefresh(rec.employeeId)
  const { label } = useMasters()
  const defs = rec.settings.customFields.filter((c) => c.active)
  const [form, setForm] = useState<Record<string, any> | null>(null)
  const save = useMutation({ mutationFn: () => api.patch(`/employees/${rec.employeeId}/record`, { customFields: form }), onSuccess: () => { toast('Saved'); setForm(null); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  if (!defs.length) return null
  const show = (d: typeof defs[number], v: any) => v == null || v === '' ? null : d.type === 'yes_no' ? (v ? 'Yes' : 'No') : d.type === 'date' ? fmtDate(v) : d.type === 'list' ? (d.masterList ? label(d.masterList, v) : d.options?.find((o) => o.code === v)?.label ?? v) : String(v)
  return (
    <section style={card}>
      <Head title="More details" action={rec.can.editAny && !form ? <button className="btn btn-ghost btn-sm" onClick={() => setForm(Object.fromEntries(defs.map((d) => [d.key, rec.customFields[d.key] ?? null])))}><Icon name="settings" size={13} /> Edit</button> : undefined} />
      {form ? (
        <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
          <div style={grid}>{defs.map((d) => {
            const v = form[d.key]
            const set = (x: any) => setForm({ ...form, [d.key]: x === '' ? null : x })
            return <label key={d.key} className="field"><span>{d.label}</span>{
              d.type === 'yes_no' ? <select className="input select" value={v == null ? '' : v ? 'y' : 'n'} onChange={(e) => set(e.target.value === '' ? null : e.target.value === 'y')}><option value="">—</option><option value="y">Yes</option><option value="n">No</option></select>
              : d.type === 'list' ? (d.masterList ? <MasterSelect list={d.masterList} value={v ?? ''} onChange={set} placeholder="—" /> : <select className="input select" value={v ?? ''} onChange={(e) => set(e.target.value)}><option value="">—</option>{d.options?.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</select>)
              : <input className="input" type={d.type === 'date' ? 'date' : d.type === 'number' ? 'number' : 'text'} value={v ?? ''} onChange={(e) => set(d.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)} />
            }</label>
          })}</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm(null)}>Cancel</button><button className="btn btn-primary btn-sm" disabled={save.isPending}>Save</button></div>
        </form>
      ) : <div style={grid}>{defs.map((d) => <Row key={d.key} label={d.label} value={show(d, rec.customFields[d.key])} />)}</div>}
    </section>
  )
}

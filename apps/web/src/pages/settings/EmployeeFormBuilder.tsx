import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useMasters } from '../../lib/hooks/useMasters'
import type { FieldSetting, Record360 } from '../employees/RecordSections'

// Form builder: for every field and section of the employee record, whether it is shown, required or hidden and
// whether employees may fill it themselves; plus the company's own custom fields.
const SECTION_NAMES: Record<string, string> = { personal: 'Personal', contact: 'Contact', job: 'Job', addresses: 'Sections', family: 'Sections', emergencyContacts: 'Sections', education: 'Sections', previousEmployment: 'Sections', identities: 'Sections' }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export default function EmployeeFormBuilder() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['form-settings'], queryFn: async () => (await api.get('/employees/form-settings')).data.data as Record360['settings'] })
  const [draft, setDraft] = useState<FieldSetting[]>([])
  const [adding, setAdding] = useState(false)
  useEffect(() => { if (data) setDraft(data.fields) }, [data])
  const dirty = data && JSON.stringify(draft) !== JSON.stringify(data.fields)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['form-settings'] }); qc.invalidateQueries({ queryKey: ['record'] }) }
  const save = useMutation({
    mutationFn: () => api.put('/employees/form-settings', { fields: draft.filter((f) => !f.locked).map((f) => ({ field: f.key, mode: f.mode, employeeCanEdit: f.employeeCanEdit })) }),
    onSuccess: () => { toast('Employee form saved'); refresh() }, onError: (e) => toast(errMsg(e), 'error'),
  })
  const toggle = useMutation({ mutationFn: ({ id, label, active }: { id: string; label: string; active: boolean }) => api.patch(`/employees/custom-fields/${id}`, { label, active }), onSuccess: refresh, onError: (e) => toast(errMsg(e), 'error') })
  const set = (key: string, patch: Partial<FieldSetting>) => setDraft(draft.map((f) => (f.key === key ? { ...f, ...patch } : f)))
  if (!data) return <div className="skeleton" style={{ height: 240, borderRadius: 18 }} />
  const groups = [...new Set(draft.map((f) => SECTION_NAMES[f.section]))]
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: 10, flexWrap: 'wrap' }}>
          <p className="dim" style={{ fontSize: 13, maxWidth: 640 }}>These settings drive Add person, bulk import, each employee's profile and the "still needed" list. Locked fields are always required.</p>
          <button className="btn btn-primary btn-sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save changes</button>
        </div>
        <table className="tbl" style={{ width: '100%', minWidth: 560 }}>
          <thead><tr><th>Field</th><th>Shown as</th><th>Employee fills it</th></tr></thead>
          {groups.map((g) => (
            <tbody key={g}>
              <tr><td colSpan={3} className="dim" style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', paddingTop: 16 }}>{g}</td></tr>
              {draft.filter((f) => SECTION_NAMES[f.section] === g).map((f) => (
                <tr key={f.key}>
                  <td><strong style={{ fontWeight: 600 }}>{f.label}</strong>{f.sensitive && <span className="dim" style={{ fontSize: 11 }}> · private to the person and HR</span>}</td>
                  <td>{f.locked ? <span className="pill night">Always required</span> : (
                    <div className="chips" style={{ display: 'flex', gap: 4 }}>
                      {(['display', 'mandatory', 'hidden'] as const).map((m) => <button key={m} type="button" className="chip" aria-pressed={f.mode === m} onClick={() => set(f.key, { mode: m })} style={f.mode === m ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{m === 'display' ? 'Optional' : m === 'mandatory' ? 'Required' : 'Hidden'}</button>)}
                    </div>
                  )}</td>
                  <td>{f.locked ? <span className="dim">HR</span> : <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.employeeCanEdit} disabled={f.mode === 'hidden'} onChange={(e) => set(f.key, { employeeCanEdit: e.target.checked })} /> Yes</label>}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </section>

      <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h3 style={{ fontSize: 15 }}>Custom fields</h3><button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add field</button></div>
        {!data.customFields.length ? <p className="dim" style={{ fontSize: 13 }}>Add anything your company records that isn't in the standard form: a T-shirt size, a union number, a shift preference.</p> : (
          <div style={{ display: 'grid', gap: 6 }}>
            {data.customFields.map((c) => (
              <div key={c.id} className="well" style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', opacity: c.active ? 1 : 0.55 }}>
                <span style={{ fontSize: 13 }}><strong style={{ fontWeight: 600 }}>{c.label}</strong> <span className="dim">· {c.type.replace('_', '/')}{c.masterList ? ` from ${c.masterList.replace(/_/g, ' ')}` : c.options ? ` (${c.options.map((o) => o.label).join(', ')})` : ''}</span></span>
                <button className="btn btn-ghost btn-sm" onClick={() => toggle.mutate({ id: c.id, label: c.label, active: !c.active })}>{c.active ? 'Retire' : 'Restore'}</button>
              </div>
            ))}
          </div>
        )}
      </section>
      {adding && <AddCustomField onClose={(ok) => { setAdding(false); if (ok) refresh() }} />}
    </div>
  )
}

function AddCustomField({ onClose }: { onClose: (ok?: boolean) => void }) {
  const toast = useToast()
  const { lists } = useMasters()
  const [f, setF] = useState({ label: '', type: 'text', source: 'own', masterList: '', options: '' })
  const save = useMutation({
    mutationFn: () => api.post('/employees/custom-fields', {
      label: f.label, type: f.type,
      ...(f.type === 'list' && f.source === 'master' ? { masterList: f.masterList } : {}),
      ...(f.type === 'list' && f.source === 'own' ? { options: f.options.split(',').map((x) => x.trim()).filter(Boolean).map((l) => ({ code: l.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40), label: l })) } : {}),
    }),
    onSuccess: () => { toast('Field added'); onClose(true) }, onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={() => onClose()} title="Add a custom field">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Name</span><input className="input" required maxLength={80} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
        <label className="field"><span>Type</span><select className="input select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="yes_no">Yes / no</option><option value="list">Pick from a list</option></select></label>
        {f.type === 'list' && <>
          <div style={{ display: 'flex', gap: 14, fontSize: 13 }}><label><input type="radio" checked={f.source === 'own'} onChange={() => setF({ ...f, source: 'own' })} /> Its own options</label><label><input type="radio" checked={f.source === 'master'} onChange={() => setF({ ...f, source: 'master' })} /> A master list</label></div>
          {f.source === 'own'
            ? <label className="field"><span>Options, separated by commas</span><input className="input" required value={f.options} placeholder="Small, Medium, Large" onChange={(e) => setF({ ...f, options: e.target.value })} /></label>
            : <label className="field"><span>Master list</span><select className="input select" required value={f.masterList} onChange={(e) => setF({ ...f, masterList: e.target.value })}><option value="">Choose…</option>{lists.map((l) => <option key={l.key} value={l.key}>{l.name}</option>)}</select></label>}
        </>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Add</button></div>
      </form>
    </Modal>
  )
}

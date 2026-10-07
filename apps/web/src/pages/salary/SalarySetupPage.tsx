import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useStructureTypes, useSalaryWrite, errMsg } from '../../lib/hooks/useSalary'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle, selectStyle } from '../../components/ui/FormField'
import StructuresTab from './StructuresTab'
import GradeBandsTab from './GradeBandsTab'
import ContractsTab from './ContractsTab'
import { card, th, td, empty, primaryBtn, ghostBtn, linkBtn, errorBox, footer } from './styles'

type Tab = 'structures' | 'types' | 'bands' | 'contracts'

export default function SalarySetupPage() {
  const { hasRole } = useAuth()
  const canEdit = hasRole('hr_admin')
  const [tab, setTab] = useState<Tab>('structures')
  const tabs: [Tab, string][] = [['structures', 'Structures & rules'], ['types', 'Structure types'], ['bands', 'Grade bands'], ['contracts', 'Contracts']]

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 'clamp(32px, 4vw, 46px)', fontFamily: 'var(--font-display)', fontWeight: 400, letterSpacing: '-0.02em', margin: 0 }}>Salary structures</h2>
        <p style={{ fontSize: 13, color: 'var(--faint)', marginTop: 2 }}>Salary structures, formula rules, grade bands and employee contracts{canEdit ? '' : ' (read only)'}</p>
      </div>
      <div className="chips" style={{ marginBottom: 20 }}>
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`chip${tab === k ? ' is-on' : ''}`}>{label}</button>
        ))}
      </div>
      {tab === 'structures' && <StructuresTab canEdit={canEdit} />}
      {tab === 'types' && <StructureTypesTab canEdit={canEdit} />}
      {tab === 'bands' && <GradeBandsTab canEdit={canEdit} />}
      {tab === 'contracts' && <ContractsTab canEdit={canEdit} />}
    </div>
  )
}

function StructureTypesTab({ canEdit }: { canEdit: boolean }) {
  const { data: types = [], isLoading } = useStructureTypes()
  const write = useSalaryWrite()
  const [editing, setEditing] = useState<null | { id?: string; name: string; wageType: string }>(null)
  const [error, setError] = useState('')

  const save = async () => {
    setError('')
    try {
      const body = { name: editing!.name.trim(), wageType: editing!.wageType }
      await write.mutateAsync(editing!.id ? { method: 'patch', path: `/salary/structure-types/${editing!.id}`, body } : { method: 'post', path: '/salary/structure-types', body })
      setEditing(null)
    } catch (err) { setError(errMsg(err)) }
  }
  const archive = async (id: string) => {
    setError('')
    try { await write.mutateAsync({ method: 'patch', path: `/salary/structure-types/${id}`, body: { active: false } }) } catch (err) { setError(errMsg(err)) }
  }

  return (
    <>
      {canEdit && <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}><button style={primaryBtn} onClick={() => setEditing({ name: '', wageType: 'monthly' })}>+ New type</button></div>}
      <div style={card}>
        {isLoading ? <div style={empty}>Loading...</div> : types.length === 0 ? <div style={empty}>No structure types yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Name', 'Wage type', 'Structures', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {types.map((t: any) => (
                <tr key={t.id}>
                  <td style={td}><strong>{t.name}</strong></td>
                  <td style={{ ...td, textTransform: 'capitalize' }}>{t.wageType}</td>
                  <td style={td}>{t.structures.map((s: any) => s.code).join(', ') || '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {canEdit && <><button style={linkBtn} onClick={() => setEditing({ id: t.id, name: t.name, wageType: t.wageType })}>Edit</button><button style={{ ...linkBtn, color: 'var(--danger)' }} onClick={() => archive(t.id)}>Archive</button></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {error && !editing && <div style={errorBox}>{error}</div>}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit structure type' : 'New structure type'} width={440}>
        {editing && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <FormField label="Name" required><input style={inputStyle} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></FormField>
            <FormField label="Wage type">
              <select style={selectStyle} value={editing.wageType} onChange={(e) => setEditing({ ...editing, wageType: e.target.value })}>
                <option value="monthly">Monthly</option><option value="hourly">Hourly</option>
              </select>
            </FormField>
          </div>
        )}
        {error && <div style={errorBox}>{error}</div>}
        <div style={footer}><button style={ghostBtn} onClick={() => setEditing(null)}>Cancel</button><button style={primaryBtn} disabled={!editing?.name.trim() || write.isPending} onClick={save}>Save</button></div>
      </Modal>
    </>
  )
}

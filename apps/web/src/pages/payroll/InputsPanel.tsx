import { useState } from 'react'
import { useCycleInputs, useInputTypes, useAddInput, useApproveInput } from '../../lib/hooks/usePayroll'
import { useEmployees } from '../../lib/hooks/useEmployees'
import { useAuth } from '../../contexts/AuthContext'
import Badge from '../../components/ui/Badge'
import { FormField, inputStyle, selectStyle } from '../../components/ui/FormField'
import { money } from '../../lib/format'

export default function InputsPanel({ cycleId, editable, currency }: { cycleId: string; editable: boolean; currency: string }) {
  const { user, hasRole } = useAuth()
  const canAdd = hasRole('hr_admin') || hasRole('payroll_admin')
  const { data: inputs = [] } = useCycleInputs(cycleId)
  const { data: types = [] } = useInputTypes()
  const { data: empData } = useEmployees({ limit: 100 })
  const add = useAddInput(cycleId)
  const approve = useApproveInput(cycleId)
  const [form, setForm] = useState({ employeeId: '', inputTypeId: '', amount: '', description: '' })
  const [error, setError] = useState('')

  const employees = empData?.data || []
  const nameOf = (id: string) => {
    const e = employees.find((x: any) => x.id === id)
    return e ? `${e.firstName} ${e.lastName}` : id.slice(0, 8)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await add.mutateAsync({ employeeId: form.employeeId, inputTypeId: form.inputTypeId, amount: parseFloat(form.amount), description: form.description || undefined })
      setForm({ employeeId: '', inputTypeId: '', amount: '', description: '' })
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to add input')
    }
  }

  const doApprove = async (id: string) => {
    setError('')
    try { await approve.mutateAsync(id) } catch (err: any) { setError(err?.response?.data?.message || 'Approval failed') }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {editable && canAdd && (
        <form onSubmit={submit} style={{ backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: 10, padding: 16, display: 'grid', gridTemplateColumns: '1.2fr 1.2fr 0.8fr 1.5fr auto', gap: 10, alignItems: 'end' }}>
          <FormField label="Employee" required>
            <select style={selectStyle} value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} required>
              <option value="">Select...</option>
              {employees.map((e: any) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
            </select>
          </FormField>
          <FormField label="Type" required>
            <select style={selectStyle} value={form.inputTypeId} onChange={(e) => setForm({ ...form, inputTypeId: e.target.value })} required>
              <option value="">Select...</option>
              {types.map((t: any) => <option key={t.id} value={t.id}>{t.name} ({t.category})</option>)}
            </select>
          </FormField>
          <FormField label="Amount" required><input style={inputStyle} type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></FormField>
          <FormField label="Description"><input style={inputStyle} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></FormField>
          <button type="submit" disabled={add.isPending} style={{ padding: '9px 16px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}>Add</button>
        </form>
      )}

      {error && <div style={{ backgroundColor: '#faece7', color: '#993C1D', borderRadius: 6, padding: '10px 12px', fontSize: 13 }}>{error}</div>}

      <div style={{ backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: 10, overflow: 'hidden' }}>
        {inputs.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#8c8c88', fontSize: 13 }}>No manual inputs for this cycle.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Employee', 'Type', 'Amount', 'Description', 'Status', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {inputs.map((i: any) => {
                const isMaker = i.addedBy === user?.id
                return (
                  <tr key={i.id} style={{ borderBottom: '0.5px solid #f5f4f0' }}>
                    <td style={td}>{nameOf(i.employeeId)}</td>
                    <td style={td}>{i.inputType?.name}</td>
                    <td style={td}>{i.inputType?.category === 'deductions' ? '−' : '+'}{money(i.amount, currency)}</td>
                    <td style={{ ...td, color: '#5c5c58' }}>{i.description || '—'}</td>
                    <td style={td}><Badge label={i.approvedBy ? 'approved' : 'pending'} /></td>
                    <td style={td}>
                      {!i.approvedBy && editable && canAdd && (
                        <button
                          disabled={isMaker || approve.isPending}
                          title={isMaker ? 'Must be approved by a different user' : ''}
                          onClick={() => doApprove(i.id)}
                          style={{ padding: '5px 12px', backgroundColor: '#e1f5ee', color: '#0F6E56', border: '0.5px solid #b8e8d4', borderRadius: 4, fontSize: 12, cursor: isMaker ? 'not-allowed' : 'pointer', opacity: isMaker ? 0.4 : 1 }}
                        >Approve</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      <div style={{ fontSize: 12, color: '#8c8c88' }}>Unapproved inputs are ignored when payroll runs. Re-run the cycle after approving.</div>
    </div>
  )
}
const th: React.CSSProperties = { padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, color: '#8c8c88', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '0.5px solid #e2e0da', backgroundColor: '#f9f8f6' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: 13, color: '#1a1a18' }

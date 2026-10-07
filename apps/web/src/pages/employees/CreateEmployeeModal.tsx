import { useState } from 'react'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle, selectStyle } from '../../components/ui/FormField'
import { useCreateEmployee, useOrgTree, useJobPositions, useWorkLocations } from '../../lib/hooks/useEmployees'

interface Props {
  open: boolean
  onClose: () => void
}

export default function CreateEmployeeModal({ open, onClose }: Props) {
  const createEmployee = useCreateEmployee()
  const { data: orgTree = [] } = useOrgTree()
  const { data: positions = [] } = useJobPositions()
  const { data: locations = [] } = useWorkLocations()

  const [form, setForm] = useState({
    firstName: '', lastName: '', workEmail: '',
    orgUnitId: '', jobPositionId: '', workLocationId: '',
    hireDate: new Date().toISOString().split('T')[0],
    employmentType: 'full_time', taxJurisdiction: 'ZM',
  })
  const [result, setResult] = useState<{ tempPassword: string; employeeCode: string } | null>(null)
  const [error, setError] = useState('')

  const flattenOrg = (units: any[], depth = 0): any[] =>
    units.flatMap((u: any) => [{ ...u, depth }, ...flattenOrg(u.children || [], depth + 1)])

  const flatOrg = flattenOrg(orgTree)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const res = await createEmployee.mutateAsync(form)
      setResult({ tempPassword: res.tempPassword, employeeCode: res.employee.employeeCode })
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to create employee')
    }
  }

  const handleClose = () => {
    setForm({ firstName: '', lastName: '', workEmail: '', orgUnitId: '', jobPositionId: '', workLocationId: '', hireDate: new Date().toISOString().split('T')[0], employmentType: 'full_time', taxJurisdiction: 'ZM' })
    setResult(null)
    setError('')
    onClose()
  }

  if (result) {
    return (
      <Modal open={open} onClose={handleClose} title="Employee Created">
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>✅</div>
          <div style={{ fontSize: '16px', fontWeight: '500', color: 'var(--ink)', marginBottom: '4px' }}>
            {form.firstName} {form.lastName} added
          </div>
          <div style={{ fontSize: '13px', color: 'var(--dim)', marginBottom: '20px' }}>
            Employee code: <strong>{result.employeeCode}</strong>
          </div>
          <div style={{ backgroundColor: 'var(--warn-bg)', border: '1px solid var(--honey-2)', borderRadius: '14px', padding: '14px', textAlign: 'left', marginBottom: '20px' }}>
            <div style={{ fontSize: '12px', fontWeight: '500', color: 'var(--warn)', marginBottom: '6px' }}>
              🔐 Temporary Password — share securely
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: '15px', color: 'var(--ink)', letterSpacing: '0.05em' }}>
              {result.tempPassword}
            </div>
          </div>
          <button onClick={handleClose} style={{ padding: '9px 24px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: '12px', fontSize: '13px', cursor: 'pointer' }}>
            Done
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={open} onClose={handleClose} title="Add Employee" width={600}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <FormField label="First name" required>
            <input style={inputStyle} value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
          </FormField>
          <FormField label="Last name" required>
            <input style={inputStyle} value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
          </FormField>
        </div>

        <FormField label="Work email" required>
          <input style={inputStyle} type="email" value={form.workEmail} onChange={(e) => setForm({ ...form, workEmail: e.target.value })} required />
        </FormField>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <FormField label="Department / Org unit" required>
            <select style={selectStyle} value={form.orgUnitId} onChange={(e) => setForm({ ...form, orgUnitId: e.target.value })} required>
              <option value="">Select...</option>
              {flatOrg.map((u: any) => (
                <option key={u.id} value={u.id}>
                  {'  '.repeat(u.depth)}{u.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Job position">
            <select style={selectStyle} value={form.jobPositionId} onChange={(e) => setForm({ ...form, jobPositionId: e.target.value })}>
              <option value="">Select...</option>
              {positions.map((p: any) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </FormField>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <FormField label="Work location">
            <select style={selectStyle} value={form.workLocationId} onChange={(e) => setForm({ ...form, workLocationId: e.target.value })}>
              <option value="">Select...</option>
              {locations.map((l: any) => (
                <option key={l.id} value={l.id}>{l.name} {l.city ? `(${l.city})` : ''}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Employment type" required>
            <select style={selectStyle} value={form.employmentType} onChange={(e) => setForm({ ...form, employmentType: e.target.value })}>
              <option value="full_time">Full Time</option>
              <option value="part_time">Part Time</option>
              <option value="contractor">Contractor</option>
              <option value="intern">Intern</option>
            </select>
          </FormField>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <FormField label="Hire date" required>
            <input style={inputStyle} type="date" value={form.hireDate} onChange={(e) => setForm({ ...form, hireDate: e.target.value })} required />
          </FormField>
          <FormField label="Tax jurisdiction">
            <select style={selectStyle} value={form.taxJurisdiction} onChange={(e) => setForm({ ...form, taxJurisdiction: e.target.value })}>
              <option value="ZM">Zambia (ZRA)</option>
              <option value="IN">India (Income Tax)</option>
              <option value="KE">Kenya (eTIMS)</option>
              <option value="NG">Nigeria (NRS)</option>
            </select>
          </FormField>
        </div>

        {error && (
          <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: '12px', padding: '10px 12px', fontSize: '13px', border: '1px solid var(--danger-line)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button type="button" onClick={handleClose} style={{ padding: '9px 18px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: '12px', fontSize: '13px', cursor: 'pointer', color: 'var(--ink)' }}>
            Cancel
          </button>
          <button type="submit" disabled={createEmployee.isPending} style={{ padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', opacity: createEmployee.isPending ? 0.7 : 1 }}>
            {createEmployee.isPending ? 'Creating...' : 'Create Employee'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useAuth } from '../../contexts/AuthContext'
import { useCreateEmployee, useOrgTree, useJobPositions, useWorkLocations, useEmployees } from '../../lib/hooks/useEmployees'
import { TemporaryPassword } from '../../components/company/AccessCard'
import { COUNTRIES } from '../../components/company/CompanyParts'

interface Props { open: boolean; onClose: () => void }

const ROLES = [
  { v: 'employee', l: 'Employee', h: 'Self-service only' },
  { v: 'manager', l: 'Manager', h: 'Approves their team' },
  { v: 'hr_admin', l: 'HR admin', h: 'Runs people operations' },
  { v: 'payroll_admin', l: 'Payroll / finance', h: 'Runs payroll and finance approvals' },
]
const today = () => new Date().toISOString().slice(0, 10)

// Add a person, place them in the hierarchy (unit + manager), and optionally create their login straight away
export default function CreateEmployeeModal({ open, onClose }: Props) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const createEmployee = useCreateEmployee()
  const { data: orgTree = [] } = useOrgTree()
  const { data: positions = [] } = useJobPositions()
  const { data: locations = [] } = useWorkLocations()
  const { data: people } = useEmployees({ limit: 100 })
  const flatOrg = ((function flat(units: any[], depth = 0): any[] { return units.flatMap((u: any) => [{ ...u, depth }, ...flat(u.children || [], depth + 1)]) })(Array.isArray(orgTree) ? orgTree : []))
  const initial = () => ({
    firstName: '', lastName: '', workEmail: '', orgUnitId: '', jobPositionId: '', workLocationId: '', managerId: user?.employee?.id ?? '',
    hireDate: today(), employmentType: 'full_time', taxJurisdiction: (user?.tenant as any)?.primaryCountry || '', role: 'employee', createLogin: true,
  })
  const [form, setForm] = useState(initial)
  const [result, setResult] = useState<{ name: string; code: string; email: string; password?: string; accessError?: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!form.orgUnitId && flatOrg[0]) setForm((f) => ({ ...f, orgUnitId: flatOrg[0].id })) }, [flatOrg.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const body: Record<string, unknown> = { firstName: form.firstName.trim(), lastName: form.lastName.trim(), workEmail: form.workEmail.trim().toLowerCase(), orgUnitId: form.orgUnitId, hireDate: form.hireDate, employmentType: form.employmentType }
      for (const k of ['jobPositionId', 'workLocationId', 'managerId', 'taxJurisdiction'] as const) if (form[k]) body[k] = form[k]
      const res = await createEmployee.mutateAsync(body)
      const emp = res.employee
      let password: string | undefined, accessError: string | undefined
      if (form.createLogin || form.role !== 'employee') {
        try {
          const acc = (await api.put(`/employees/${emp.id}/access`, { roles: form.role === 'employee' ? [] : [form.role], ...(form.createLogin && { password: 'generate', loginEnabled: true }) })).data.data
          password = acc.temporaryPassword
        } catch (err: any) { accessError = err?.response?.data?.message || 'Login could not be created' }
      }
      qc.invalidateQueries({ queryKey: ['employees'] })
      setResult({ name: `${form.firstName} ${form.lastName}`.trim(), code: emp.employeeCode, email: body.workEmail as string, password, accessError })
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Could not add this person')
    } finally { setBusy(false) }
  }
  const close = () => { setForm(initial()); setResult(null); setError(''); onClose() }

  if (result) {
    return (
      <Modal open={open} onClose={close} title="Person added">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--honey)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="check" size={20} stroke={2.2} /></span>
            <div><div style={{ fontFamily: 'var(--font-display)', fontSize: 22 }}>{result.name}</div><div className="dim" style={{ fontSize: 13 }}>Employee code {result.code}</div></div>
          </div>
          {result.password && <TemporaryPassword email={result.email} password={result.password} workspace={user?.tenant?.slug} />}
          {!result.password && !result.accessError && <p className="dim" style={{ fontSize: 13 }}>No login yet. Create one any time from their profile under Login & access.</p>}
          {result.accessError && <div role="alert" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 14, padding: '10px 14px', fontSize: 13 }}>{result.accessError}. You can retry from their profile.</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => { setForm(initial()); setResult(null) }}><Icon name="plus" size={14} /> Add another</button>
            <button className="btn btn-primary" onClick={close}>Done</button>
          </div>
        </div>
      </Modal>
    )
  }

  const managers = (people?.data ?? []).filter((p: any) => p.id)
  return (
    <Modal open={open} onClose={close} title="Add a person" width={640}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="grid-2">
          <div className="field"><label htmlFor="ce-fn">First name</label><input id="ce-fn" className="input" value={form.firstName} onChange={(e) => set('firstName', e.target.value)} required /></div>
          <div className="field"><label htmlFor="ce-ln">Last name</label><input id="ce-ln" className="input" value={form.lastName} onChange={(e) => set('lastName', e.target.value)} required /></div>
        </div>
        <div className="field"><label htmlFor="ce-em">Work email (their sign-in)</label><input id="ce-em" className="input" type="email" value={form.workEmail} onChange={(e) => set('workEmail', e.target.value)} required /></div>
        <div className="grid-2">
          <div className="field"><label htmlFor="ce-unit">Department</label>
            <select id="ce-unit" className="input select" value={form.orgUnitId} onChange={(e) => set('orgUnitId', e.target.value)} required>
              {flatOrg.map((u: any) => <option key={u.id} value={u.id}>{'· '.repeat(u.depth)}{u.name}</option>)}
            </select></div>
          <div className="field"><label htmlFor="ce-mgr">Reports to</label>
            <select id="ce-mgr" className="input select" value={form.managerId} onChange={(e) => set('managerId', e.target.value)}>
              <option value="">No manager</option>
              {managers.map((p: any) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}{p.jobPosition?.title ? ` · ${p.jobPosition.title}` : ''}</option>)}
            </select></div>
          <div className="field"><label htmlFor="ce-pos">Job position</label>
            <select id="ce-pos" className="input select" value={form.jobPositionId} onChange={(e) => set('jobPositionId', e.target.value)}>
              <option value="">None</option>{positions.map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select></div>
          <div className="field"><label htmlFor="ce-loc">Work location</label>
            <select id="ce-loc" className="input select" value={form.workLocationId} onChange={(e) => set('workLocationId', e.target.value)}>
              <option value="">None</option>{locations.map((l: any) => <option key={l.id} value={l.id}>{l.name}{l.city ? ` (${l.city})` : ''}</option>)}
            </select></div>
          <div className="field"><label htmlFor="ce-type">Employment type</label>
            <select id="ce-type" className="input select" value={form.employmentType} onChange={(e) => set('employmentType', e.target.value)}>
              <option value="full_time">Full time</option><option value="part_time">Part time</option><option value="contractor">Contractor</option><option value="intern">Intern</option>
            </select></div>
          <div className="field"><label htmlFor="ce-hire">Start date</label><input id="ce-hire" className="input" type="date" value={form.hireDate} onChange={(e) => set('hireDate', e.target.value)} required /></div>
          <div className="field"><label htmlFor="ce-tax">Tax country</label>
            <select id="ce-tax" className="input select" value={form.taxJurisdiction} onChange={(e) => set('taxJurisdiction', e.target.value)}>
              <option value="">Not set</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
            </select></div>
        </div>

        <fieldset className="well" style={{ border: 'none', padding: 16 }}>
          <legend style={{ fontWeight: 500, fontSize: 14, padding: 0, float: 'left', width: '100%', marginBottom: 10 }}>Login & role</legend>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, clear: 'both' }}>
            {ROLES.map((r) => (
              <label key={r.v} className="card" style={{ padding: 10, cursor: 'pointer', border: form.role === r.v ? '1.5px solid var(--night)' : '1px solid var(--hair)' }}>
                <input type="radio" name="ce-role" value={r.v} checked={form.role === r.v} onChange={() => set('role', r.v)} style={{ marginRight: 6 }} />
                <strong style={{ fontWeight: 500, fontSize: 13 }}>{r.l}</strong><div className="dim" style={{ fontSize: 11, marginTop: 2 }}>{r.h}</div>
              </label>
            ))}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13 }}>
            <input type="checkbox" checked={form.createLogin} onChange={(e) => set('createLogin', e.target.checked)} /> Create their login now (temporary password, changed at first sign-in)
          </label>
        </fieldset>

        {error && <div role="alert" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 14, padding: '10px 14px', fontSize: 13 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !form.firstName.trim() || !form.lastName.trim() || !form.workEmail.trim() || !form.orgUnitId}>{busy ? 'Adding…' : 'Add person'}</button>
        </div>
      </form>
    </Modal>
  )
}

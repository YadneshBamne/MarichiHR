import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { useMasters } from '../../lib/hooks/useMasters'
import { useOrgTree, useWorkLocations } from '../../lib/hooks/useEmployees'

// Attendance policies (greytHR "attendance schemes"): office hours and the rules applied to each day, per group
interface Policy {
  id?: string; name: string; priority: number; isDefault: boolean; active: boolean; people?: number
  orgUnitIds: string[]; workLocationIds: string[]; employeeCategories: string[]; employmentTypes: string[]
  flexible: boolean; startTime: string; endTime: string; graceInMinutes: number; graceOutMinutes: number; halfDayHours: number; fullDayHours: number
  lateEarlyAllowedPerMonth: number; latePenalty: 'none' | 'half_day_lop' | 'full_day_lop'; regularisationDaysBack: number; regularisationPerMonth: number
  overtimeEnabled: boolean; overtimeAfterHours: number; overtimeRate: number; overtimeMaxHoursPerMonth: number | null
  compOffEnabled: boolean; compOffHalfDayHours: number; compOffFullDayHours: number; allowWeb: boolean; requireGeofence: boolean; lwpFlagAfterAbsences?: number | null
}
const PENALTY: Record<string, string> = { none: 'Flag only', half_day_lop: 'Half a day of pay', full_day_lop: 'A full day of pay' }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export default function AttendancePoliciesPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['attendance-policies'], queryFn: async () => (await api.get('/attendance/policies')).data.data as { policies: Policy[]; uncovered: number; builtIn: Policy } })
  const [edit, setEdit] = useState<Policy | null>(null)
  const root = useReveal<HTMLDivElement>(isLoading)
  const { label } = useMasters()
  const { data: tree } = useOrgTree()
  const { data: locations = [] } = useWorkLocations()
  const units: { id: string; name: string }[] = []
  const walk = (ns: any[]) => (ns ?? []).forEach((n) => { units.push({ id: n.id, name: n.name }); walk(n.children ?? []) })
  walk(Array.isArray(tree) ? tree : tree ? [tree] : [])
  const who = (p: Policy) => {
    if (p.isDefault) return 'Everyone not covered by another policy'
    const parts = [
      p.orgUnitIds.length && `in ${p.orgUnitIds.map((id) => units.find((u) => u.id === id)?.name ?? '?').join(', ')}`,
      p.workLocationIds.length && `at ${p.workLocationIds.map((id) => (locations as any[]).find((l) => l.id === id)?.name ?? '?').join(', ')}`,
      p.employeeCategories.length && p.employeeCategories.map((c) => label('employee_category', c)).join(', '),
      p.employmentTypes.length && p.employmentTypes.map((c) => label('employment_type', c)).join(', '),
    ].filter(Boolean)
    return parts.length ? `People ${parts.join(' · ')}` : 'Everyone'
  }
  return (
    <div ref={root}>
      <PageHeader title="Attendance policies" sub="Office hours, grace time, late rules, regularisation, overtime and comp-off for each group of people"
        actions={<button className="btn btn-primary btn-sm" disabled={!data} onClick={() => setEdit({ ...data!.builtIn, name: '', priority: 100, isDefault: !data!.policies.some((p) => p.isDefault), active: true, orgUnitIds: [], workLocationIds: [], employeeCategories: [], employmentTypes: [] })}><Icon name="plus" size={14} /> New policy</button>} />
      {isLoading || !data ? <div className="skeleton" style={{ height: 200, borderRadius: 18 }} /> : (
        <div style={{ display: 'grid', gap: 12, maxWidth: 900 }}>
          {!data.policies.length && <section data-card className="card" style={{ padding: 18 }}><p className="dim" style={{ fontSize: 13 }}>No policies yet, so everyone follows the standard rules: 09:00–17:00, 10 minutes grace, 8 hours a full day, 4 a half day, overtime after 8 hours at 1.5×. Create a policy to set your own.</p></section>}
          {data.uncovered > 0 && data.policies.length > 0 && <p className="pill warn" style={{ whiteSpace: 'normal' }}>{data.uncovered} people match no policy and follow the standard rules. Make one policy the default to cover everyone.</p>}
          {data.policies.map((p) => (
            <section key={p.id} data-card className="card" style={{ padding: 18, display: 'grid', gap: 8, opacity: p.active ? 1 : 0.55 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <div><strong style={{ fontSize: 16 }}>{p.name}</strong> {p.isDefault && <span className="pill night">default</span>} {!p.active && <span className="pill mute">retired</span>}<div className="dim" style={{ fontSize: 13 }}>{who(p)} · {p.people ?? 0} {p.people === 1 ? 'person' : 'people'}</div></div>
                <button className="btn btn-ghost btn-sm" onClick={() => setEdit(p)}>Edit</button>
              </div>
              <div className="dim" style={{ fontSize: 13, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <span>{p.flexible ? 'Flexible hours' : `${p.startTime}–${p.endTime}`}{!p.flexible && ` · grace ${p.graceInMinutes}/${p.graceOutMinutes} min`}</span>
                <span>Full day {p.fullDayHours} h · half {p.halfDayHours} h</span>
                <span>Late/early: {p.lateEarlyAllowedPerMonth} a month, then {PENALTY[p.latePenalty].toLowerCase()}</span>
                <span>Regularise {p.regularisationDaysBack} days back, {p.regularisationPerMonth}/month</span>
                <span>{p.overtimeEnabled ? `Overtime after ${p.overtimeAfterHours} h at ${p.overtimeRate}×${p.overtimeMaxHoursPerMonth != null ? `, max ${p.overtimeMaxHoursPerMonth} h/month` : ''}` : 'No overtime'}</span>
                {p.compOffEnabled && <span>Comp-off for working off days</span>}
                {!p.allowWeb && <span>No web clock-in</span>}{p.requireGeofence && <span>Location required</span>}
              </div>
            </section>
          ))}
        </div>
      )}
      {edit && <PolicyModal p={edit} units={units} locations={locations as any[]} onClose={(ok) => { setEdit(null); if (ok) qc.invalidateQueries({ queryKey: ['attendance-policies'] }) }} />}
    </div>
  )
}

function PolicyModal({ p, units, locations, onClose }: { p: Policy; units: { id: string; name: string }[]; locations: any[]; onClose: (ok?: boolean) => void }) {
  const toast = useToast()
  const { values } = useMasters()
  const [f, setF] = useState<Policy>(p)
  const set = (patch: Partial<Policy>) => setF({ ...f, ...patch })
  const toggle = (k: 'orgUnitIds' | 'workLocationIds' | 'employeeCategories' | 'employmentTypes', v: string) => set({ [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] } as any)
  const save = useMutation({
    mutationFn: () => {
      const { id, people, ...body } = f as any
      delete body.tenantId; delete body.createdAt; delete body.updatedAt
      return id ? api.patch(`/attendance/policies/${id}`, body) : api.post('/attendance/policies', body)
    },
    onSuccess: () => { toast('Policy saved'); onClose(true) }, onError: (e) => toast(errMsg(e), 'error'),
  })
  const num = (k: keyof Policy, step = 1, min = 0) => <input className="input" type="number" step={step} min={min} value={(f[k] as any) ?? ''} onChange={(e) => set({ [k]: e.target.value === '' ? null : Number(e.target.value) } as any)} />
  const yes = (k: keyof Policy, text: string) => <label style={{ display: 'flex', gap: 8, fontSize: 14, alignItems: 'center' }}><input type="checkbox" checked={!!f[k]} onChange={(e) => set({ [k]: e.target.checked } as any)} /> {text}</label>
  const chips = (k: 'orgUnitIds' | 'workLocationIds' | 'employeeCategories' | 'employmentTypes', items: [string, string][]) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{items.map(([v, l]) => <button key={v} type="button" className="chip" aria-pressed={f[k].includes(v)} onClick={() => toggle(k, v)} style={f[k].includes(v) ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{l}</button>)}</div>
  )
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }
  const head = (t: string) => <h3 style={{ fontSize: 14, marginTop: 6 }}>{t}</h3>
  return (
    <Modal open onClose={() => onClose()} title={p.id ? `Edit ${p.name}` : 'New attendance policy'} width={720}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <div style={grid}>
          <label className="field" style={{ gridColumn: 'span 2' }}><span>Name</span><input className="input" required value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <label className="field"><span>Priority (lower wins)</span>{num('priority')}</label>
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>{yes('isDefault', 'Default for everyone else')}{p.id && !p.isDefault && yes('active', 'Active')}</div>
        {!f.isDefault && <>
          {head('Applies to (leave empty for everyone)')}
          <div style={{ display: 'grid', gap: 8 }}>
            <span className="dim" style={{ fontSize: 12 }}>Departments</span>{chips('orgUnitIds', units.map((u) => [u.id, u.name]))}
            <span className="dim" style={{ fontSize: 12 }}>Locations</span>{chips('workLocationIds', locations.map((l) => [l.id, l.name]))}
            <span className="dim" style={{ fontSize: 12 }}>Employee categories</span>{chips('employeeCategories', values('employee_category').map((v) => [v.code, v.label]))}
            <span className="dim" style={{ fontSize: 12 }}>Employment types</span>{chips('employmentTypes', values('employment_type').map((v) => [v.code, v.label]))}
          </div>
        </>}
        {head('Office hours')}
        {yes('flexible', 'Flexible hours (only hours worked count, no start or end time)')}
        <div style={grid}>
          {!f.flexible && <>
            <label className="field"><span>Start</span><input className="input" type="time" value={f.startTime} onChange={(e) => set({ startTime: e.target.value })} /></label>
            <label className="field"><span>End</span><input className="input" type="time" value={f.endTime} onChange={(e) => set({ endTime: e.target.value })} /></label>
            <label className="field"><span>Grace in (min)</span>{num('graceInMinutes')}</label>
            <label className="field"><span>Grace out (min)</span>{num('graceOutMinutes')}</label>
          </>}
          <label className="field"><span>Full day (hours)</span>{num('fullDayHours', 0.25)}</label>
          <label className="field"><span>Half day (hours)</span>{num('halfDayHours', 0.25)}</label>
        </div>
        {!f.flexible && <>
          {head('Late arrival and early leaving')}
          <div style={grid}>
            <label className="field"><span>Allowed per month</span>{num('lateEarlyAllowedPerMonth')}</label>
            <label className="field" style={{ gridColumn: 'span 2' }}><span>Each one after that costs</span><select className="input select" value={f.latePenalty} onChange={(e) => set({ latePenalty: e.target.value as any })}>{Object.entries(PENALTY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          </div>
        </>}
        {head('Regularisation')}
        <div style={grid}>
          <label className="field"><span>Days back allowed</span>{num('regularisationDaysBack')}</label>
          <label className="field"><span>Requests per month</span>{num('regularisationPerMonth')}</label>
        </div>
        {head('Overtime and comp-off')}
        {yes('overtimeEnabled', 'Pay overtime')}
        {f.overtimeEnabled && <div style={grid}>
          <label className="field"><span>After (hours a day)</span>{num('overtimeAfterHours', 0.25)}</label>
          <label className="field"><span>Rate (× hourly pay)</span>{num('overtimeRate', 0.25)}</label>
          <label className="field"><span>Max hours a month</span><input className="input" type="number" min={0} placeholder="No limit" value={f.overtimeMaxHoursPerMonth ?? ''} onChange={(e) => set({ overtimeMaxHoursPerMonth: e.target.value === '' ? null : Number(e.target.value) })} /></label>
        </div>}
        {yes('compOffEnabled', 'Working a weekly off or holiday earns comp-off leave')}
        {f.compOffEnabled && <div style={grid}>
          <label className="field"><span>Half a day for (hours)</span>{num('compOffHalfDayHours', 0.25)}</label>
          <label className="field"><span>A full day for (hours)</span>{num('compOffFullDayHours', 0.25)}</label>
        </div>}
        {head('Marking attendance')}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>{yes('allowWeb', 'Allow clocking in from the web')}{yes('requireGeofence', 'Require location (geofence) to clock in')}</div>
        <label className="field" style={{ maxWidth: 360 }}><span>Tell HR after this many unapproved absences in a month (for unpaid-leave review)</span><input className="input" type="number" min={1} max={31} placeholder="Off" value={f.lwpFlagAfterAbsences ?? ''} onChange={(e) => set({ lwpFlagAfterAbsences: e.target.value === '' ? null : Number(e.target.value) })} /></label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Save policy</button></div>
      </form>
    </Modal>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import PageHeader from '../../components/ui/PageHeader'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useOrgTree } from '../../lib/hooks/useEmployees'
import { useMasters } from '../../lib/hooks/useMasters'
import { flattenUnits } from '../workplace/AnnouncementsPage'
import { ReportView, type Report } from './ReportsPage'

// Report builder: pick employee columns (in the order clicked), filter, optionally group, preview, save, export.
interface Field { key: string; label: string; group: string; type: string; groupable: boolean }
interface Def { name: string; columns: string[]; groupBy: string | null; filters: { status: 'active' | 'exited' | 'all'; departmentIds?: string[]; employmentTypes?: string[]; hiredFrom?: string; hiredTo?: string } }
const EMPTY: Def = { name: '', columns: ['employee_id', 'name', 'department', 'job_title', 'hire_date'], groupBy: null, filters: { status: 'active' } }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const clean = (d: Def): Def => ({ ...d, name: d.name.trim() || 'Untitled report', filters: Object.fromEntries(Object.entries(d.filters).filter(([, v]) => (Array.isArray(v) ? v.length : v))) as Def['filters'] })

export default function ReportBuilderPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const { data: tree } = useOrgTree()
  const units = useMemo(() => flattenUnits(tree), [tree])
  const masters = useMasters()
  const { data: fields = [] } = useQuery({ queryKey: ['builder-fields'], queryFn: async () => (await api.get('/reports/builder/fields')).data.data as Field[] })
  const { data: saved } = useQuery({ queryKey: ['builder-saved', id], queryFn: async () => (await api.get(`/reports/builder/saved/${id}`)).data.data as Def, enabled: !!id })
  const [def, setDef] = useState<Def>(EMPTY)
  useEffect(() => { if (saved) setDef({ name: saved.name, columns: saved.columns, groupBy: saved.groupBy, filters: { ...saved.filters, status: saved.filters.status ?? 'active' } }) }, [saved])
  const [report, setReport] = useState<Report | null>(null)
  const groups = useMemo(() => [...new Set(fields.map((f) => f.group))], [fields])
  const toggle = (k: string) => setDef((d) => ({ ...d, columns: d.columns.includes(k) ? d.columns.filter((c) => c !== k) : [...d.columns, k] }))
  const setF = (patch: Partial<Def['filters']>) => setDef((d) => ({ ...d, filters: { ...d.filters, ...patch } }))

  const preview = useMutation({ mutationFn: async () => (await api.post('/reports/builder/preview', clean(def))).data.data as Report, onSuccess: setReport, onError: (e) => toast(errMsg(e), 'error') })
  const save = useMutation({
    mutationFn: async () => (id ? api.put(`/reports/builder/saved/${id}`, clean(def)) : api.post('/reports/builder/saved', clean(def))),
    onSuccess: (res) => { toast('Report saved'); qc.invalidateQueries({ queryKey: ['builder-saved'] }); if (!id) navigate(`/reports/builder/${res.data.data.id}`, { replace: true }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const archive = useMutation({ mutationFn: () => api.delete(`/reports/builder/saved/${id}`), onSuccess: () => { toast('Report removed'); qc.invalidateQueries({ queryKey: ['builder-saved'] }); navigate('/reports') } })
  const exportCsv = async () => {
    try {
      const res = await api.get(`/reports/builder/saved/${id}/export`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      Object.assign(document.createElement('a'), { href: url, download: `${def.name || 'report'}.csv` }).click()
      URL.revokeObjectURL(url)
    } catch { toast('Export failed', 'error') }
  }
  const label = (k: string) => fields.find((f) => f.key === k)?.label ?? k

  return (
    <div>
      <PageHeader title={id ? def.name || 'Report' : 'Build a report'} sub="Choose columns and filters for an employee report. Save it to run again or export."
        actions={<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Link to="/reports" className="btn btn-ghost btn-sm"><Icon name="chevronLeft" size={14} /> Reports</Link>
          {id && <button className="btn btn-ghost btn-sm" onClick={exportCsv}><Icon name="download" size={14} /> Export CSV</button>}
          {id && <button className="btn btn-ghost btn-sm" onClick={() => confirm('Remove this report?') && archive.mutate()}>Remove</button>}
        </div>} />
      <div className="dgrid">
        <section className="card span-4" style={{ padding: 18, display: 'grid', gap: 14, alignContent: 'start' }}>
          <h3 style={{ fontSize: 15 }}>Columns</h3>
          {groups.map((g) => (
            <div key={g} style={{ display: 'grid', gap: 6 }}>
              <span className="dim" style={{ fontSize: 12, fontWeight: 600 }}>{g}</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {fields.filter((f) => f.group === g).map((f) => {
                  const on = def.columns.includes(f.key)
                  return <button key={f.key} className="chip" aria-pressed={on} onClick={() => toggle(f.key)} style={on ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{f.label}</button>
                })}
              </div>
            </div>
          ))}
        </section>
        <section className="card span-8" style={{ padding: 18, display: 'grid', gap: 14, alignContent: 'start' }}>
          <label className="field"><span>Report name</span><input className="input" maxLength={80} placeholder="e.g. Probation ending this quarter" value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value })} /></label>
          <div>
            <span className="dim" style={{ fontSize: 12, fontWeight: 600 }}>Column order</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {def.columns.length ? def.columns.map((c, i) => (
                <span key={c} className="pill mute" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  {i > 0 && <button className="btn-icon" aria-label={`Move ${label(c)} left`} style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setDef((d) => { const cols = [...d.columns]; [cols[i - 1], cols[i]] = [cols[i], cols[i - 1]]; return { ...d, columns: cols } })}>‹</button>}
                  {label(c)}
                  <button aria-label={`Remove ${label(c)}`} style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => toggle(c)}>×</button>
                </span>
              )) : <span className="dim" style={{ fontSize: 13 }}>Pick at least one column.</span>}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
            <label className="field"><span>People</span><select className="input select" value={def.filters.status} onChange={(e) => setF({ status: e.target.value as Def['filters']['status'] })}><option value="active">Current employees</option><option value="exited">People who left</option><option value="all">Everyone</option></select></label>
            <label className="field"><span>Department</span><select className="input select" value={def.filters.departmentIds?.[0] ?? ''} onChange={(e) => setF({ departmentIds: e.target.value ? [e.target.value] : [] })}><option value="">All</option>{units.map((u) => <option key={u.id} value={u.id}>{' '.repeat(u.depth * 2)}{u.name}</option>)}</select></label>
            <label className="field"><span>Employment type</span><select className="input select" value={def.filters.employmentTypes?.[0] ?? ''} onChange={(e) => setF({ employmentTypes: e.target.value ? [e.target.value] : [] })}><option value="">All</option>{masters.values('employment_type').map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}</select></label>
            <label className="field"><span>Joined from</span><input className="input" type="date" value={def.filters.hiredFrom ?? ''} onChange={(e) => setF({ hiredFrom: e.target.value })} /></label>
            <label className="field"><span>Joined until</span><input className="input" type="date" value={def.filters.hiredTo ?? ''} onChange={(e) => setF({ hiredTo: e.target.value })} /></label>
            <label className="field"><span>Group by</span><select className="input select" value={def.groupBy ?? ''} onChange={(e) => setDef({ ...def, groupBy: e.target.value || null })}><option value="">No grouping (one row per person)</option>{fields.filter((f) => f.groupable).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select></label>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" disabled={!def.columns.length || preview.isPending} onClick={() => preview.mutate()}>{preview.isPending ? 'Running…' : 'Preview'}</button>
            <button className="btn btn-primary" disabled={!def.columns.length || def.name.trim().length < 2 || save.isPending} onClick={() => save.mutate()}>{id ? 'Save changes' : 'Save report'}</button>
          </div>
        </section>
      </div>
      {report && <div style={{ marginTop: 'var(--gap)' }}><ReportView r={report} /></div>}
    </div>
  )
}

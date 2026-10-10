import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import { useOrgTree } from '../../lib/hooks/useEmployees'
import PageHeader from '../../components/ui/PageHeader'
import Icon, { type IconName } from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { fmtHours } from '../../lib/format'
import { flattenUnits } from '../workplace/AnnouncementsPage'

type ColType = 'text' | 'number' | 'money' | 'hours' | 'date' | 'percent'
interface Report { title: string; subtitle: string; columns: { key: string; label: string; type?: ColType }[]; rows: Record<string, any>[]; summary: { label: string; value: number | string; type?: ColType }[]; chart: { label: string; bars: { label: string; value: number }[]; type?: ColType }; currency?: string }

const ICONS: Record<string, IconName> = { headcount: 'users', attendance: 'clock', leave: 'leaf', payroll: 'wallet', expenses: 'receipt', attrition: 'door' }
const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

export function formatValue(v: any, type: ColType | undefined, currency?: string) {
  if (v === null || v === undefined || v === '') return '—'
  switch (type) {
    case 'money': return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (currency ? ` ${currency}` : '')
    case 'hours': return fmtHours(Number(v))
    case 'percent': return `${Number(v).toLocaleString()}%`
    case 'number': return Number(v).toLocaleString()
    case 'date': return new Date(`${String(v).slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
    default: return String(v)
  }
}

export default function ReportsPage() {
  const { data = [], isLoading } = useQuery({ queryKey: ['reports'], queryFn: async () => (await api.get('/reports')).data.data as { key: string; title: string; description: string }[] })
  const root = useReveal<HTMLDivElement>(isLoading)
  return (
    <div ref={root}>
      <PageHeader title="Reports" sub="Ready-made reports with filters and CSV export" />
      {isLoading ? <div className="skeleton" style={{ height: 160, borderRadius: 22 }} /> : (
        <div className="dgrid">
          {data.map((r) => (
            <Link key={r.key} to={`/reports/${r.key}`} data-card className="card span-4 row-link" style={{ padding: 20, display: 'grid', gap: 10, alignContent: 'start' }}>
              <span style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--honey)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={ICONS[r.key] ?? 'chart'} size={18} /></span>
              <h2 style={{ fontSize: 22 }}>{r.title}</h2>
              <p className="dim" style={{ fontSize: 13 }}>{r.description}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export function ReportPage() {
  const { key = '' } = useParams()
  const toast = useToast()
  const { data: tree } = useOrgTree()
  const units = useMemo(() => flattenUnits(tree), [tree])
  const [f, setF] = useState<Record<string, string>>((): Record<string, string> => key === 'attendance' ? { month: today().slice(0, 7) } : key === 'expenses' ? { from: daysAgo(90), to: today() } : key === 'payroll' ? {} : { from: daysAgo(365), to: today() })
  const params = Object.fromEntries(Object.entries(f).filter(([, v]) => v))
  const { data: r, isLoading, error } = useQuery({ queryKey: ['report', key, params], queryFn: async () => (await api.get(`/reports/${key}`, { params })).data.data as Report })
  const { data: cycles = [] } = useQuery({ queryKey: ['report-cycles'], queryFn: async () => (await api.get('/reports/payroll/cycles')).data.data as { id: string; payPeriodStart: string; status: string }[], enabled: key === 'payroll' })
  const root = useReveal<HTMLDivElement>(key)
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
  const exportCsv = async () => {
    try {
      const res = await api.get(`/reports/${key}/export`, { params, responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      Object.assign(document.createElement('a'), { href: url, download: `${key}-report-${today()}.csv` }).click()
      URL.revokeObjectURL(url)
    } catch { toast('Export failed', 'error') }
  }
  const max = Math.max(1, ...(r?.chart.bars.map((b) => b.value) ?? [0]))
  return (
    <div ref={root}>
      <PageHeader title={r?.title ?? 'Report'} sub={r?.subtitle ?? (isLoading ? 'Loading…' : '')}
        actions={<div style={{ display: 'flex', gap: 6 }}><Link to="/reports" className="btn btn-ghost btn-sm"><Icon name="chevronLeft" size={14} /> Reports</Link><button className="btn btn-primary btn-sm" disabled={!r?.rows.length} onClick={exportCsv}><Icon name="download" size={14} /> Export CSV</button></div>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, marginTop: 14 }}>
          {key === 'attendance' && <label className="field"><span>Month</span><input className="input" type="month" value={f.month ?? ''} onChange={set('month')} /></label>}
          {key === 'payroll' && <label className="field"><span>Payroll</span><select className="input" value={f.cycleId ?? ''} onChange={set('cycleId')}><option value="">Latest</option>{cycles.map((c) => <option key={c.id} value={c.id}>{c.payPeriodStart.slice(0, 7)} · {c.status}</option>)}</select></label>}
          {!['attendance', 'payroll'].includes(key) && <>
            <label className="field"><span>From</span><input className="input" type="date" value={f.from ?? ''} onChange={set('from')} /></label>
            <label className="field"><span>To</span><input className="input" type="date" value={f.to ?? ''} onChange={set('to')} /></label>
          </>}
          {key === 'headcount' && <label className="field"><span>Group by</span><select className="input" value={f.groupBy ?? 'department'} onChange={set('groupBy')}><option value="department">Department</option><option value="location">Office</option><option value="type">Employment type</option></select></label>}
          <label className="field"><span>Department</span><select className="input" value={f.departmentId ?? ''} onChange={set('departmentId')}><option value="">All</option>{units.map((u) => <option key={u.id} value={u.id}>{' '.repeat(u.depth * 2)}{u.name}</option>)}</select></label>
        </div>
      </PageHeader>

      {error ? <section className="card" style={{ padding: 24 }}>{(error as any)?.response?.data?.message ?? 'This report could not be loaded.'}</section> : isLoading || !r ? <div className="skeleton" style={{ height: 240, borderRadius: 22 }} /> : (
        <div style={{ display: 'grid', gap: 'var(--gap)' }}>
          {r.summary.length > 0 && (
            <div className="dgrid">
              {r.summary.map((s) => (
                <section key={s.label} data-card className={`card span-${r.summary.length >= 4 ? 3 : 4}`} style={{ padding: 18 }}>
                  <div className="dim" style={{ fontSize: 13 }}>{s.label}</div>
                  <div className="display num" style={{ fontSize: 30, marginTop: 6 }}>{formatValue(s.value, s.type, r.currency)}</div>
                </section>
              ))}
            </div>
          )}
          {r.chart.bars.length > 0 && (
            <section data-card className="card" style={{ padding: 20 }}>
              <h2 style={{ fontSize: 16, marginBottom: 12 }}>{r.chart.label}</h2>
              <div style={{ display: 'grid', gap: 8 }}>
                {r.chart.bars.slice(0, 12).map((b) => (
                  <div key={b.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 180px) 1fr auto', gap: 10, alignItems: 'center', fontSize: 13 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.label}>{b.label}</span>
                    <span style={{ height: 12, borderRadius: 999, background: 'var(--well)', overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${(b.value / max) * 100}%`, background: 'var(--honey)', borderRadius: 999 }} /></span>
                    <span className="num" style={{ minWidth: 60, textAlign: 'right' }}>{formatValue(b.value, r.chart.type ?? 'number', r.currency)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
            {r.rows.length === 0 ? <p className="dim" style={{ padding: 16 }}>No data for these filters.</p> : (
              <table className="tbl" style={{ width: '100%', minWidth: Math.max(480, r.columns.length * 110) }}>
                <thead><tr>{r.columns.map((c) => <th key={c.key} style={{ textAlign: c.type && c.type !== 'text' && c.type !== 'date' ? 'right' : 'left' }}>{c.label}</th>)}</tr></thead>
                <tbody>{r.rows.map((row, i) => <tr key={i}>{r.columns.map((c) => <td key={c.key} className={c.type && c.type !== 'text' ? 'num' : undefined} style={{ textAlign: c.type && c.type !== 'text' && c.type !== 'date' ? 'right' : 'left' }}>{formatValue(row[c.key], c.type)}</td>)}</tr>)}</tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

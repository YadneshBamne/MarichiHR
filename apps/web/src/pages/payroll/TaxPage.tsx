import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { fmtDate } from '../../lib/format'
import { MyDeclaration, DeclarationReview } from './DeclarationsPanel'
import { NewVersionModal, OverridesPanel } from './TaxAdminPanels'
import { WindowAndCertificates, FilingsPanel } from './TaxNoticesPanels'

interface Table { id: string; country: string; code: string; name: string; effectiveFrom: string; params: any; sourceUrl: string; sourceNote: string; verified: boolean; inForce: boolean; upcoming: boolean; company?: boolean }
interface Col { code: string; name: string }
interface Filing { cycle: { id: string; payPeriodStart: string; status: string; final: boolean }; columns: Col[]; rows: Record<string, any>[]; totals: Record<string, number> }
interface Statement { employer: string; employee: { firstName: string; lastName: string; employeeCode: string; taxJurisdiction: string | null }; period: { from: string; to: string; basis: string }; columns: Col[]; months: Record<string, any>[]; totals: Record<string, number>; generatedAt: string }

const STAFF = ['payroll_admin', 'compliance_officer']
const n = (v: unknown) => (v == null || v === '' ? '—' : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const pct = (r: number) => `${+(r * 100).toFixed(2)}%`
const COUNTRY: Record<string, string> = { ZM: 'Zambia', IN: 'India', KE: 'Kenya', NG: 'Nigeria' }

export default function TaxPage() {
  const { hasRole } = useAuth()
  const staff = STAFF.some((r) => hasRole(r))
  const isPayroll = hasRole('payroll_admin')
  const [tab, setTab] = useState<'return' | 'tables' | 'overrides' | 'filings' | 'statement' | 'declarations' | 'declaration'>(['overrides', 'filings'].includes(new URLSearchParams(window.location.search).get('tab') ?? '') && staff ? (new URLSearchParams(window.location.search).get('tab') as 'overrides' | 'filings') : new URLSearchParams(window.location.search).get('tab') === 'declarations' && isPayroll ? 'declarations' : new URLSearchParams(window.location.search).get('tab') === 'declaration' ? 'declaration' : staff ? 'return' : 'statement')
  const tabs = [...(staff ? [['return', 'Statutory return'], ['tables', 'Rates & sources'], ['overrides', 'Tax overrides'], ['filings', 'Filings']] : []), ['statement', staff ? 'Annual statements' : 'Annual statement'], ...(isPayroll ? [['declarations', 'Declarations']] : []), ['declaration', 'My declaration']] as [typeof tab, string][]
  const root = useReveal<HTMLDivElement>(tab)
  return (
    <div ref={root}>
      <PageHeader title={staff ? 'Tax & compliance' : 'My tax statement'} sub={staff ? 'Statutory returns, the rates payroll uses and where each rate comes from' : 'Your pay, tax and contributions for the year'}>
        {(
          <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
            {tabs.map(([k, l]) => <button key={k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{l}</button>)}
          </div>
        )}
      </PageHeader>
      {tab === 'return' ? <Return /> : tab === 'tables' ? <Tables /> : tab === 'overrides' ? <OverridesPanel canDecide={hasRole('compliance_officer')} /> : tab === 'filings' ? <FilingsPanel /> : tab === 'declarations' ? <><WindowAndCertificates /><DeclarationReview /></> : tab === 'declaration' ? <MyDeclaration /> : <StatementView staff={staff} />}
    </div>
  )
}

function Return() {
  const toast = useToast()
  const { data: cycles = [] } = useQuery({ queryKey: ['payroll-cycles'], queryFn: async () => (await api.get('/payroll/cycles')).data.data as { id: string; payPeriodStart: string; status: string }[] })
  const [cycleId, setCycleId] = useState('')
  const id = cycleId || cycles.find((c) => c.status !== 'draft')?.id || ''
  const { data: f, isLoading } = useQuery({ queryKey: ['tax-filing', id], enabled: !!id, queryFn: async () => (await api.get('/tax/filing', { params: { cycleId: id } })).data.data as Filing })
  const download = async () => {
    try {
      const res = await api.get('/tax/filing/export', { params: { cycleId: id }, responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      Object.assign(document.createElement('a'), { href: url, download: `statutory-return-${f?.cycle.payPeriodStart.slice(0, 7)}.csv` }).click()
      URL.revokeObjectURL(url)
    } catch { toast('Export failed', 'error') }
  }
  return (
    <>
      <div data-rise style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 14, flexWrap: 'wrap' }}>
        <label className="field" style={{ minWidth: 220 }}><span>Payroll run</span><select className="input" value={id} onChange={(e) => setCycleId(e.target.value)}>{!cycles.length && <option value="">No payroll runs yet</option>}{cycles.map((c) => <option key={c.id} value={c.id}>{c.payPeriodStart.slice(0, 7)} · {c.status}</option>)}</select></label>
        <button className="btn btn-primary btn-sm" disabled={!f?.rows.length} onClick={download}><Icon name="download" size={14} /> Download CSV</button>
        {f && !f.cycle.final && <span className="pill warn">Not final yet: figures can still change</span>}
      </div>
      {f && f.rows.length > 0 && (
        <div className="dgrid" style={{ marginBottom: 14 }}>
          {f.columns.map((c) => (
            <section key={c.code} data-card className="card span-3" style={{ padding: 16 }}>
              <div className="dim" style={{ fontSize: 12 }}>{c.name}</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 24 }}>{n(f.totals[c.code])}</div>
            </section>
          ))}
        </div>
      )}
      <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
        {isLoading ? <div className="skeleton" style={{ height: 140, borderRadius: 14, margin: 8 }} /> : !f?.rows.length ? <p className="dim" style={{ padding: 16 }}>No payslips in this run yet.</p> : (
          <table className="tbl" style={{ width: '100%', minWidth: 640 }}>
            <thead><tr><th>Employee</th><th style={{ textAlign: 'right' }}>Gross</th>{f.columns.map((c) => <th key={c.code} style={{ textAlign: 'right' }}>{c.name}</th>)}</tr></thead>
            <tbody>
              {f.rows.map((r) => <tr key={r.code} data-row><td><strong style={{ fontWeight: 600 }}>{r.employee}</strong><div className="dim" style={{ fontSize: 12 }}>{r.code}{r.jurisdiction ? ` · ${r.jurisdiction}` : ''}</div></td><td style={{ textAlign: 'right' }}>{n(r.gross)}</td>{f.columns.map((c) => <td key={c.code} style={{ textAlign: 'right' }}>{n(r[c.code])}</td>)}</tr>)}
              <tr style={{ fontWeight: 600 }}><td>Total</td><td style={{ textAlign: 'right' }}>{n(f.totals.gross)}</td>{f.columns.map((c) => <td key={c.code} style={{ textAlign: 'right' }}>{n(f.totals[c.code])}</td>)}</tr>
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

function Tables() {
  const { hasRole } = useAuth()
  const officer = hasRole('compliance_officer')
  const [editing, setEditing] = useState<Table | null>(null)
  const { data = [], isLoading } = useQuery({ queryKey: ['tax-tables'], queryFn: async () => (await api.get('/tax/tables')).data.data as Table[] })
  if (isLoading) return <div className="skeleton" style={{ height: 200, borderRadius: 22 }} />
  return (
    <>
      <p className="dim" data-rise style={{ fontSize: 13, marginBottom: 14, maxWidth: 720 }}>Payroll picks the version in force on the last day of each pay period, and each payslip line records the version it used. Every figure links to where it comes from. Rates marked “confirm” come from a secondary source until the authority publishes them. {officer ? 'When a rate changes, use New figures to enter your company’s version.' : 'A Compliance officer can enter new figures when a rate changes.'}</p>
      {editing && <NewVersionModal table={editing} onClose={() => setEditing(null)} />}
      <div className="dgrid">
        {data.map((t) => (
          <section key={t.id} data-card className="card span-6" style={{ padding: 20, display: 'grid', gap: 10, alignContent: 'start', opacity: t.inForce || t.upcoming ? 1 : 0.65 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div><strong style={{ fontSize: 15 }}>{t.name}</strong><div className="dim" style={{ fontSize: 12 }}>{COUNTRY[t.country] ?? t.country} · from {fmtDate(t.effectiveFrom)}</div></div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'start' }}>
                {t.inForce ? <span className="pill ok">In force</span> : t.upcoming ? <span className="pill info">Upcoming</span> : <span className="pill mute">Earlier</span>}
                {t.company ? <span className="pill honey">Your company</span> : t.verified ? <span className="pill night">Official</span> : <span className="pill warn">Confirm</span>}
                {officer && t.inForce && <button className="btn btn-ghost btn-sm" style={{ height: 22, fontSize: 11 }} onClick={() => setEditing(t)}>New figures</button>}
              </div>
            </div>
            <Params t={t} />
            <p style={{ fontSize: 12, lineHeight: 1.5 }} className="dim">{t.sourceNote}</p>
            <a className="link" style={{ fontSize: 12, overflowWrap: 'anywhere' }} href={t.sourceUrl} target="_blank" rel="noopener noreferrer">Source ↗</a>
          </section>
        ))}
      </div>
    </>
  )
}

function Params({ t }: { t: Table }) {
  const p = t.params
  const bands = p.bands ?? p.slabs
  if (bands) {
    let lower = 0
    return (
      <table className="tbl" style={{ width: '100%', fontSize: 13 }}>
        <thead><tr><th>{p.slabs ? 'Yearly income' : 'Monthly income'}</th><th style={{ textAlign: 'right' }}>Rate</th></tr></thead>
        <tbody>{bands.map((b: any, i: number) => { const row = <tr key={i}><td>{b.upTo == null ? `Above ${lower.toLocaleString()}` : `${lower ? lower.toLocaleString() : '0'} – ${b.upTo.toLocaleString()}`}</td><td style={{ textAlign: 'right' }}>{pct(b.rate)}</td></tr>; lower = b.upTo ?? lower; return row })}</tbody>
        {p.slabs && <tfoot><tr><td colSpan={2} className="dim" style={{ fontSize: 12 }}>Standard deduction {p.standardDeduction.toLocaleString()} · rebate up to {p.rebateMax.toLocaleString()} when taxable income ≤ {p.rebateIncomeLimit.toLocaleString()} · cess {pct(p.cess)}</td></tr></tfoot>}
      </table>
    )
  }
  return (
    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
      <div><div className="dim" style={{ fontSize: 12 }}>Employee</div><strong>{pct(p.employeeRate)}</strong></div>
      <div><div className="dim" style={{ fontSize: 12 }}>Employer</div><strong>{pct(p.employerRate)}</strong></div>
      <div><div className="dim" style={{ fontSize: 12 }}>Of</div><strong>{String(p.basis).replace(/_/g, ' ')}</strong></div>
      {p.monthlyCeiling && <div><div className="dim" style={{ fontSize: 12 }}>Monthly ceiling</div><strong>{p.monthlyCeiling.toLocaleString()}</strong></div>}
    </div>
  )
}

function StatementView({ staff }: { staff: boolean }) {
  const [year, setYear] = useState(new Date().getFullYear())
  const [basis, setBasis] = useState<'calendar' | 'april'>('calendar')
  const [employeeId, setEmployeeId] = useState('')
  const { data: people = [] } = useQuery({ queryKey: ['tax-people'], enabled: staff, queryFn: async () => (await api.get('/employees', { params: { limit: 500 } })).data.data as any[] })
  const toast = useToast()
  const certificate = async () => {
    try {
      const r = await api.get('/tax/certificate', { params: { year, basis, ...(employeeId ? { employeeId } : {}) }, responseType: 'blob' })
      const url = URL.createObjectURL(r.data as Blob)
      const a = document.createElement('a'); a.href = url; a.download = `tax-certificate-${year}.pdf`; a.click(); URL.revokeObjectURL(url)
    } catch { toast('Could not create the certificate', 'error') }
  }
  const { data: s, isLoading, error } = useQuery({ queryKey: ['tax-statement', year, basis, employeeId], queryFn: async () => (await api.get('/tax/statement', { params: { year, basis, ...(employeeId ? { employeeId } : {}) } })).data.data as Statement, retry: false })
  return (
    <>
      <div data-rise className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 14, flexWrap: 'wrap' }}>
        {staff && <label className="field" style={{ minWidth: 220 }}><span>Employee</span><select className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}><option value="">Me</option>{people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName} ({p.employeeCode})</option>)}</select></label>}
        <label className="field"><span>Year</span><input className="input" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value) || year)} style={{ width: 110 }} /></label>
        <label className="field"><span>Year runs</span><select className="input" value={basis} onChange={(e) => setBasis(e.target.value as any)}><option value="calendar">January – December</option><option value="april">April – March (India)</option></select></label>
        <button className="btn btn-ghost btn-sm" disabled={!s?.months.length} onClick={() => window.print()}><Icon name="file" size={14} /> Print</button>
        <button className="btn btn-primary btn-sm" disabled={!s?.months.length} onClick={certificate}><Icon name="download" size={14} /> Tax certificate (PDF)</button>
      </div>
      <section data-card className="card print-area" style={{ padding: 24 }}>
        {isLoading ? <div className="skeleton" style={{ height: 160, borderRadius: 14 }} /> : error || !s ? <p className="dim">No statement available.</p> : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
              <div><h2 style={{ fontSize: 20 }}>Annual tax statement</h2><div className="dim" style={{ fontSize: 13 }}>{fmtDate(s.period.from)} – {fmtDate(s.period.to)}</div></div>
              <div style={{ textAlign: 'right', fontSize: 13 }}><strong>{s.employee.firstName} {s.employee.lastName}</strong> · {s.employee.employeeCode}<div className="dim">{s.employer}{s.employee.taxJurisdiction ? ` · ${s.employee.taxJurisdiction}` : ''}</div></div>
            </div>
            {!s.months.length ? <p className="dim">No finalised payroll in this period.</p> : (
              <div style={{ overflowX: 'auto' }}>
                <table className="tbl" style={{ width: '100%', minWidth: 560 }}>
                  <thead><tr><th>Month</th><th style={{ textAlign: 'right' }}>Gross</th>{s.columns.map((c) => <th key={c.code} style={{ textAlign: 'right' }}>{c.name}</th>)}<th style={{ textAlign: 'right' }}>Net pay</th></tr></thead>
                  <tbody>
                    {s.months.map((m) => <tr key={m.month}><td>{m.month}</td><td style={{ textAlign: 'right' }}>{n(m.gross)}</td>{s.columns.map((c) => <td key={c.code} style={{ textAlign: 'right' }}>{n(m[c.code])}</td>)}<td style={{ textAlign: 'right' }}>{n(m.net)}</td></tr>)}
                    <tr style={{ fontWeight: 600 }}><td>Total ({s.months[0].currency})</td><td style={{ textAlign: 'right' }}>{n(s.totals.gross)}</td>{s.columns.map((c) => <td key={c.code} style={{ textAlign: 'right' }}>{n(s.totals[c.code])}</td>)}<td style={{ textAlign: 'right' }}>{n(s.totals.net)}</td></tr>
                  </tbody>
                </table>
              </div>
            )}
            <p className="dim" style={{ fontSize: 11, marginTop: 14 }}>From finalised payroll runs. Generated {new Date(s.generatedAt).toLocaleString()}. This is a pay record, not a certificate issued by the tax authority.</p>
          </>
        )}
      </section>
    </>
  )
}

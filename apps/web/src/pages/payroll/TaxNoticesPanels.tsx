import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useToast } from '../../components/ui/Toast'
import { fmtDate } from '../../lib/format'

// Payroll: when people may declare, releasing annual certificates, and which statutory returns are filed
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const AUTHORITIES = ['ZRA', 'NAPSA', 'NHIMA', 'KRA', 'NSSF (KE)', 'SHIF', 'FIRS / State IRS', 'PenCom', 'Income Tax Dept', 'EPFO']

export function WindowAndCertificates() {
  const toast = useToast()
  const qc = useQueryClient()
  const y = new Date().getFullYear()
  const [year, setYear] = useState(y)
  const { data: w } = useQuery({ queryKey: ['decl-window', year], queryFn: async () => (await api.get('/tax/declarations/window', { params: { year } })).data.data })
  const { data: releases = [] } = useQuery({ queryKey: ['cert-releases'], queryFn: async () => (await api.get('/tax/certificates/releases')).data.data as any[] })
  const [f, setF] = useState({ opensOn: '', closesOn: '' })
  const [cert, setCert] = useState({ year: y - 1, basis: 'calendar' })
  const saveWindow = useMutation({
    mutationFn: () => api.put('/tax/declarations/window', { year, opensOn: f.opensOn || w?.opensOn, closesOn: f.closesOn || w?.closesOn }),
    onSuccess: () => { toast('Window saved. Everyone is told when it opens.'); setF({ opensOn: '', closesOn: '' }); qc.invalidateQueries({ queryKey: ['decl-window'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const release = useMutation({
    mutationFn: async () => (await api.post('/tax/certificates/release', cert)).data.data,
    onSuccess: (d) => { toast(`${d.notified} people told their certificate is ready`); qc.invalidateQueries({ queryKey: ['cert-releases'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <div className="dgrid" style={{ marginBottom: 'var(--gap)' }}>
      <section data-card className="card span-6" style={{ padding: 18, display: 'grid', gap: 10, alignContent: 'start' }}>
        <h3 style={{ fontSize: 16 }}>Declaration window</h3>
        <p className="dim" style={{ fontSize: 13 }}>People can submit declarations for the year only between these dates. Everyone is told when it opens, and those who haven’t submitted are reminded 3 days before it closes. With no window, they can submit any time.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: 8 }}>
          <input className="input" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year" />
          <input className="input" type="date" value={f.opensOn || w?.opensOn || ''} onChange={(e) => setF({ ...f, opensOn: e.target.value })} aria-label="Opens" />
          <input className="input" type="date" value={f.closesOn || w?.closesOn || ''} onChange={(e) => setF({ ...f, closesOn: e.target.value })} aria-label="Closes" />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><button className="btn btn-primary btn-sm" disabled={saveWindow.isPending || !(f.opensOn || w?.opensOn) || !(f.closesOn || w?.closesOn)} onClick={() => saveWindow.mutate()}>Save window</button>{w && <span className={`pill ${w.open ? 'ok' : 'mute'}`}>{w.open ? 'Open now' : 'Not open now'}</span>}</div>
      </section>
      <section data-card className="card span-6" style={{ padding: 18, display: 'grid', gap: 10, alignContent: 'start' }}>
        <h3 style={{ fontSize: 16 }}>Annual tax certificates</h3>
        <p className="dim" style={{ fontSize: 13 }}>After the year ends, release them: everyone paid that year is told their certificate is ready in My tax statement.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" type="number" value={cert.year} onChange={(e) => setCert({ ...cert, year: Number(e.target.value) })} style={{ width: 100 }} aria-label="Certificate year" />
          <select className="input" value={cert.basis} onChange={(e) => setCert({ ...cert, basis: e.target.value })} aria-label="Year runs"><option value="calendar">January – December</option><option value="april">April – March (India)</option></select>
          <button className="btn btn-primary btn-sm" disabled={release.isPending} onClick={() => { if (confirm(`Tell everyone paid in ${cert.year} that their certificate is ready?`)) release.mutate() }}>Release</button>
        </div>
        {releases.map((r) => <div key={r.id} className="dim" style={{ fontSize: 12 }}>{r.basis === 'april' ? `${r.year}-${String(r.year + 1).slice(2)}` : r.year}: released {fmtDate(r.releasedAt)} to {r.people} people</div>)}
      </section>
    </div>
  )
}

export function FilingsPanel() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data = [], isLoading } = useQuery({ queryKey: ['tax-filings'], queryFn: async () => (await api.get('/tax/filings')).data.data as any[] })
  const [f, setF] = useState<{ cycleId: string; authority: string; reference: string; filedOn: string } | null>(null)
  const save = useMutation({
    mutationFn: () => api.post('/tax/filings', { ...f, reference: f!.reference.trim() }),
    onSuccess: () => { toast('Recorded. Payroll and Compliance are told.'); setF(null); qc.invalidateQueries({ queryKey: ['tax-filings'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const month = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return (
    <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
      <p className="dim" style={{ fontSize: 13 }}>File each return with the authority (Statutory return gives the figures and CSV), then record the reference here so everyone can see what is filed and what is still to do.</p>
      {isLoading ? <div className="skeleton" style={{ height: 100 }} /> : !data.length ? <p className="dim" style={{ fontSize: 13 }}>No approved or paid payroll runs yet.</p> : (
        <table className="tbl"><thead><tr><th>Pay period</th><th>Filed</th><th /></tr></thead>
          <tbody>{data.map((c) => (
            <tr key={c.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{month(c.payPeriodStart)}{c.offCycle && <span className="pill mute" style={{ marginLeft: 6 }}>off-cycle</span>}</td>
              <td>{c.filings.length ? c.filings.map((x: any) => <div key={x.id} style={{ fontSize: 13 }}><span className="pill ok">{x.authority}</span> {x.reference} · {fmtDate(x.filedOn)} · {x.filedByName}</div>) : <span className="pill warn">Nothing recorded yet</span>}</td>
              <td style={{ textAlign: 'right' }}><button className="btn btn-ghost btn-sm" onClick={() => setF({ cycleId: c.id, authority: AUTHORITIES[0], reference: '', filedOn: new Date().toISOString().slice(0, 10) })}>Record filing</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {f && (
        <div className="well" style={{ padding: 14, borderRadius: 14, display: 'grid', gap: 8 }}>
          <strong style={{ fontSize: 14 }}>Record a filing</strong>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            <input className="input" list="authorities" value={f.authority} onChange={(e) => setF({ ...f, authority: e.target.value })} aria-label="Authority" /><datalist id="authorities">{AUTHORITIES.map((a) => <option key={a} value={a} />)}</datalist>
            <input className="input" placeholder="Reference / acknowledgement no." value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} maxLength={100} />
            <input className="input" type="date" value={f.filedOn} onChange={(e) => setF({ ...f, filedOn: e.target.value })} aria-label="Filed on" />
          </div>
          <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" disabled={save.isPending || f.reference.trim().length < 2 || f.authority.trim().length < 2} onClick={() => save.mutate()}>Save</button><button className="btn btn-ghost btn-sm" onClick={() => setF(null)}>Cancel</button></div>
        </div>
      )}
    </section>
  )
}

// Filing dashboard: each run's returns with their status; Submit sends one through its filing adapter (test mode
// until the provider keys are set; portals without an API are recorded by hand)
export function FilingDashboard() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['filing-dashboard'], queryFn: async () => (await api.get('/tax/filing-dashboard')).data.data as any })
  const submit = useMutation({
    mutationFn: async (v: { cycleId: string; authority: string }) => (await api.post('/tax/filings/submit', v)).data.data,
    onSuccess: (d) => { toast(`${d.authority}: ${d.status}, reference ${d.reference}`); qc.invalidateQueries({ queryKey: ['filing-dashboard'] }); qc.invalidateQueries({ queryKey: ['tax-filings'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  if (isLoading || !data) return <div className="skeleton" style={{ height: 140, borderRadius: 22 }} />
  const month = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><h3 style={{ fontSize: 16, flex: 1 }}>Statutory filing</h3><span className={`pill ${data.mode === 'live' ? 'ok' : 'warn'}`} style={{ textTransform: 'none' }}>{data.mode === 'live' ? 'Live filing' : 'Test mode: nothing is sent to the authorities'}</span></div>
        <p className="dim" style={{ fontSize: 13 }}>Each paid run owes these returns. Submit sends one through its filing service (WhiteBooks for India TDS). ZRA, KRA and NRS PAYE and the contribution returns have no filing API: file them on the authority’s portal and record the reference below.</p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{data.adapters.map((a: any) => <span key={a.authority} className={`pill ${a.provider ? (a.liveReady ? 'ok' : 'mute') : 'info'}`} style={{ textTransform: 'none' }}>{a.authority}: {a.provider ? `${a.provider}${a.liveReady ? ' ready' : ', keys needed'}` : 'portal'}</span>)}
          {data.digitax?.configured && <span className={`pill ${data.digitax.ok ? (data.digitax.test ? 'warn' : 'ok') : 'danger'}`} style={{ textTransform: 'none' }} title="DigiTax connects to ZRA Smart Invoice (sales invoices), not PAYE">DigiTax Smart Invoice: {data.digitax.ok ? (data.digitax.test ? 'test business connected' : 'live business connected') : data.digitax.error}</span>}</div>
      </section>
      {!data.cycles.length ? <section className="card" style={{ padding: 20 }}><p className="dim">No approved or paid payroll runs yet.</p></section> : data.cycles.map((c: any) => (
        <section key={c.id} data-card className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
          <strong>{month(c.payPeriodStart)}{c.offCycle && <span className="pill mute" style={{ marginLeft: 6 }}>off-cycle</span>}</strong>
          {!c.returns.length ? <span className="dim" style={{ fontSize: 13 }}>No statutory amounts in this run.</span> : c.returns.map((x: any) => (
            <div key={x.authority} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <span style={{ flex: 1, minWidth: 200 }}>{x.label}<div className="dim" style={{ fontSize: 12 }}>{x.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></span>
              {x.filing ? <span className={`pill ${x.filing.status === 'rejected' ? 'danger' : 'ok'}`} style={{ textTransform: 'none' }}>{x.filing.status}{x.filing.mode === 'sandbox' ? ' (test)' : ''} · {x.filing.reference}</span> : <span className="pill warn">to file</span>}
              {(!x.filing || x.filing.mode === 'sandbox' || x.filing.status === 'rejected') && <button className="btn btn-primary btn-sm" disabled={submit.isPending} onClick={() => submit.mutate({ cycleId: c.id, authority: x.authority })}>{x.provider ? 'Submit' : 'Test submit'}</button>}
            </div>
          ))}
        </section>
      ))}
      <FilingsPanel />
    </div>
  )
}

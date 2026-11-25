import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useExits, useMyClearances, useMyExit, useResign } from '../../lib/hooks/useExits'
import { downloadCsv } from '../../lib/hooks/usePayroll'
import PageHeader, { EmptyState } from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import InitiateExitModal, { localDay } from './InitiateExitModal'
import { money, fmtDate } from '../../lib/format'

type Tab = 'exits' | 'signoffs' | 'mine'
export const STATUS_PILL: Record<string, string> = { requested: 'warn', initiated: 'info', computed: 'honey', approved: 'honey', paid: 'ok', cancelled: 'mute', declined: 'danger' }
export const STATUS_TEXT: Record<string, string> = { requested: 'resignation request', initiated: 'in progress', computed: 'settlement computed', approved: 'settlement approved', paid: 'paid', cancelled: 'cancelled', declined: 'declined' }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export default function ExitsPage() {
  const { hasRole } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const isHR = hasRole('hr_admin')
  const isStaff = isHR || hasRole('payroll_admin')
  const { data: mine = [] } = useMyClearances()
  const [tab, setTab] = useState<Tab>(isStaff ? 'exits' : mine.length ? 'signoffs' : 'mine')
  const [params, setParams] = useSearchParams()
  const preselect = params.get('initiate') || undefined
  const [showInitiate, setShowInitiate] = useState(!!preselect && isHR)
  const { data: exits = [], isLoading } = useExits(isStaff)
  const requests = exits.filter((x: any) => x.status === 'requested').length
  const tabs: [Tab, string][] = [...(isStaff ? [['exits', `Exits & settlements${requests ? ` · ${requests} request${requests > 1 ? 's' : ''}` : ''}`] as [Tab, string]] : []), ['signoffs', `My sign-offs${mine.length ? ` (${mine.length})` : ''}`], ['mine', 'My exit']]

  return (
    <div>
      <PageHeader title={isStaff ? 'Offboarding' : 'My exit'} sub="Resignations, terminations and full & final settlements"
        actions={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {isStaff && tab === 'exits' && <button className="btn btn-ghost btn-sm" onClick={() => downloadCsv('/exits/export.csv').catch((e) => toast(errMsg(e), 'error'))}><Icon name="download" size={14} /> Export CSV</button>}
          {isHR && tab === 'exits' && <button className="btn btn-primary btn-sm" onClick={() => setShowInitiate(true)}><Icon name="plus" size={14} /> Initiate exit</button>}
        </div>}>
        <div role="tablist" className="chips" style={{ marginTop: 14 }}>
          {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`chip${tab === k ? ' is-on' : ''}`}>{label}</button>)}
        </div>
      </PageHeader>

      {tab === 'exits' && isStaff && (
        <section className="card" style={{ padding: 8, overflowX: 'auto' }}>
          {isLoading ? <div className="skeleton" style={{ height: 120, borderRadius: 14 }} /> : exits.length === 0 ? <EmptyState icon={<Icon name="door" size={26} />} title="No exits yet" body="Resignations and terminations show here." /> : (
            <table className="tbl" style={{ width: '100%', minWidth: 680 }}>
              <thead><tr><th>Employee</th><th>Type</th><th>Last working day</th><th>Sign-offs</th><th>Net payable</th><th>Status</th></tr></thead>
              <tbody>
                {exits.map((x: any) => {
                  const cleared = x.clearances.filter((c: any) => c.status === 'cleared').length
                  return (
                    <tr key={x.id} data-row onClick={() => navigate(`/exits/${x.id}`)} style={{ cursor: 'pointer' }}>
                      <td><strong>{x.employee.firstName} {x.employee.lastName}</strong><div className="dim" style={{ fontSize: 12 }}>{x.employee.employeeCode}</div></td>
                      <td style={{ textTransform: 'capitalize' }}>{x.exitType}</td>
                      <td>{fmtDate(x.lastWorkingDate)}</td>
                      <td>{x.status === 'requested' ? '—' : `${cleared}/${x.clearances.length}`}</td>
                      <td>{x.netPayable == null ? '—' : money(x.netPayable, x.currency)}</td>
                      <td><span className={`pill ${STATUS_PILL[x.status] ?? 'mute'}`} style={{ textTransform: 'none' }}>{STATUS_TEXT[x.status] ?? x.status}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'signoffs' && (
        <section className="card" style={{ padding: 8, overflowX: 'auto' }}>
          {mine.length === 0 ? <EmptyState icon={<Icon name="checkCircle" size={26} />} title="Nothing waiting for your sign-off" /> : (
            <table className="tbl" style={{ width: '100%', minWidth: 520 }}>
              <thead><tr><th>Employee</th><th>Your sign-off</th><th>Last working day</th><th /></tr></thead>
              <tbody>
                {mine.map((c: any) => (
                  <tr key={c.id} data-row onClick={() => navigate(`/exits/${c.exitId}`)} style={{ cursor: 'pointer' }}>
                    <td><strong>{c.exit.employee.firstName} {c.exit.employee.lastName}</strong></td>
                    <td>{c.department}</td>
                    <td>{fmtDate(c.exit.lastWorkingDate)}</td>
                    <td className="link" style={{ fontSize: 12 }}>Review &amp; sign →</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'mine' && <MyExit />}

      <InitiateExitModal open={showInitiate} employeeId={preselect} onClose={() => { setShowInitiate(false); if (preselect) setParams({}, { replace: true }) }} onCreated={(id) => navigate(`/exits/${id}`)} />
    </div>
  )
}

// What the person sees of their own exit: where it stands, the sign-offs, and the button to hand in a resignation
function MyExit() {
  const { data, isLoading } = useMyExit()
  const resign = useResign()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ reason: '', lastWorkingDate: '' })
  if (isLoading) return <div className="skeleton" style={{ height: 160, borderRadius: 22 }} />
  const x = data?.exit
  const steps = x ? x.clearances.filter((c: any) => c.status === 'cleared').length : 0
  const stage = !x ? null : x.status === 'requested' ? 'Waiting for HR to answer your resignation.'
    : x.status === 'initiated' ? `Sign-offs in progress: ${steps} of ${x.clearances.length} done.`
    : x.status === 'computed' || x.status === 'approved' ? 'Your final settlement is being prepared and checked.'
    : x.status === 'paid' ? 'Your exit is complete. Thank you for everything.' : x.status === 'declined' ? 'HR did not accept this request.' : null
  const submit = async () => {
    try { await resign.mutateAsync({ reason: f.reason.trim(), ...(f.lastWorkingDate && { lastWorkingDate: f.lastWorkingDate }) }); toast('Your resignation was sent to HR'); setOpen(false); setF({ reason: '', lastWorkingDate: '' }) } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {x ? (
        <section className="card" style={{ padding: 20, display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}><h2 style={{ fontSize: 18 }}>Your exit</h2><span className={`pill ${STATUS_PILL[x.status] ?? 'mute'}`} style={{ textTransform: 'none' }}>{STATUS_TEXT[x.status] ?? x.status}</span></div>
          {stage && <p style={{ margin: 0 }}>{stage}</p>}
          {x.declinedReason && <p className="pill warn" style={{ whiteSpace: 'normal', textTransform: 'none' }}>HR said: {x.declinedReason}</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            {[['Notice given', fmtDate(x.noticeDate)], ['Last working day', fmtDate(x.lastWorkingDate)], ['Notice period', `${x.noticePeriodDays} days`], ['Notice served', `${x.noticeServedDays} days`]].map(([k, v]) => <div key={k} className="well" style={{ padding: 12 }}><div className="dim" style={{ fontSize: 12 }}>{k}</div><strong>{v}</strong></div>)}
          </div>
          {x.clearances.length > 0 && (
            <div>
              <h3 style={{ fontSize: 14, marginBottom: 8 }}>Sign-offs</h3>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{x.clearances.map((c: any) => <span key={c.department} className={`pill ${c.status === 'cleared' ? 'ok' : 'mute'}`}>{c.department} {c.status === 'cleared' ? 'signed off' : 'waiting'}</span>)}</div>
            </div>
          )}
        </section>
      ) : <section className="card"><EmptyState icon={<Icon name="door" size={26} />} title="No exit in progress" body="Nothing to do here unless you plan to leave." /></section>}
      {data?.canResign && (
        <section className="card" style={{ padding: 20, display: 'grid', gap: 8 }}>
          <h2 style={{ fontSize: 16 }}>Hand in a resignation</h2>
          <p className="dim" style={{ margin: 0, fontSize: 13 }}>This sends your resignation to HR, who accept it or get back to you. Nothing changes on your record until they accept.</p>
          <div><button className="btn btn-ghost" onClick={() => setOpen(true)}>Hand in my resignation</button></div>
        </section>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Hand in my resignation" width={480}>
        <div style={{ display: 'grid', gap: 12 }}>
          <label className="field"><span>Your reason *</span><textarea className="input" style={{ minHeight: 90, height: 'auto', padding: 12 }} maxLength={1000} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
          <label className="field"><span>Last working day you propose (optional)</span><input className="input" type="date" min={localDay()} value={f.lastWorkingDate} onChange={(e) => setF({ ...f, lastWorkingDate: e.target.value })} /></label>
          <p className="dim" style={{ margin: 0, fontSize: 12 }}>If you leave this empty, your contract's notice period is counted from today. HR can change the date when they accept.</p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={f.reason.trim().length < 3 || resign.isPending} onClick={submit}>{resign.isPending ? 'Sending…' : 'Send to HR'}</button></div>
        </div>
      </Modal>
    </div>
  )
}

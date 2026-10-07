import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useCycle, useCyclePayslips, useCycleAction, downloadCsv } from '../../lib/hooks/usePayroll'
import { useAuth } from '../../contexts/AuthContext'
import Badge from '../../components/ui/Badge'
import Modal from '../../components/ui/Modal'
import VariancePanel from './VariancePanel'
import BankFileModal from './BankFileModal'
import InputsPanel from './InputsPanel'
import { money, fmtPeriod, fmtDate } from '../../lib/format'

type Tab = 'payslips' | 'variance' | 'inputs'

const STEPS = ['Draft', 'Attendance locked', 'In review', 'HR approved', 'Finance approved', 'Disbursed']

function stepIndex(c: any): number {
  if (c.status === 'disbursed' || c.status === 'locked') return 5
  if (c.financeApprovedBy) return 4
  if (c.status === 'approved') return 3
  if (c.status === 'review' || c.status === 'processing') return 2
  if (c.attendanceLockedAt) return 1
  return 0
}

export default function CycleDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, hasRole } = useAuth()
  const canAct = hasRole('hr_admin') || hasRole('payroll_admin')
  const currency = user?.tenant?.baseCurrency || 'ZMW'

  const { data: cycle, isLoading } = useCycle(id!)
  const { data: payslips = [] } = useCyclePayslips(id!)
  const action = useCycleAction(id!)
  const [tab, setTab] = useState<Tab>('payslips')
  const [error, setError] = useState('')
  const [runResult, setRunResult] = useState<any>(null)
  const [showBank, setShowBank] = useState(false)
  const [glBusy, setGlBusy] = useState(false)
  const [confirm, setConfirm] = useState<null | { action: string; title: string; body: string }>(null)

  if (isLoading) return <div style={{ color: 'var(--faint)', fontSize: 13 }}>Loading cycle...</div>
  if (!cycle) return <div style={{ color: 'var(--danger)', fontSize: 13 }}>Cycle not found.</div>

  const step = stepIndex(cycle)
  const isMakerOfApproval = cycle.approvedBy === user?.id
  const inputsEditable = ['draft', 'review'].includes(cycle.status)

  const exec = async (act: string) => {
    setError('')
    setConfirm(null)
    try {
      const res = await action.mutateAsync(act)
      if (act === 'run') { setRunResult(res); setTab('payslips') }
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Action failed')
    }
  }

  const btn = (label: string, act: string, opts: { primary?: boolean; danger?: boolean; confirm?: { title: string; body: string }; disabled?: boolean; title?: string } = {}) => (
    <button
      key={act}
      disabled={action.isPending || opts.disabled}
      title={opts.title}
      onClick={() => (opts.confirm ? setConfirm({ action: act, ...opts.confirm }) : exec(act))}
      style={{
        padding: '9px 18px', borderRadius: 12, fontSize: 13, fontWeight: 500, cursor: opts.disabled ? 'not-allowed' : 'pointer',
        opacity: action.isPending || opts.disabled ? 0.5 : 1,
        ...(opts.primary ? { backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none' } : opts.danger ? { backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-line)' } : { backgroundColor: 'var(--well)', color: 'var(--ink)', border: '1px solid var(--line)' }),
      }}
    >{label}</button>
  )

  const actions: React.ReactNode[] = []
  if (canAct) {
    if (cycle.status === 'draft' && !cycle.attendanceLockedAt) actions.push(btn('Lock attendance', 'lock-attendance', { primary: true, confirm: { title: 'Lock attendance?', body: 'All attendance records in this pay period become read-only.' } }))
    if (cycle.status === 'draft' && cycle.attendanceLockedAt) actions.push(btn('Run payroll', 'run', { primary: true }))
    if (cycle.status === 'review') {
      actions.push(btn('Re-run payroll', 'run'))
      actions.push(btn('Approve (HR)', 'approve', { primary: true, confirm: { title: 'Approve payroll?', body: 'You are approving all payslips in this cycle. A different user must give finance approval.' } }))
    }
    if (cycle.status === 'approved') {
      actions.push(btn('Reopen', 'reopen', { danger: true, confirm: { title: 'Reopen cycle?', body: 'This clears all approvals and returns the cycle to review.' } }))
      if (!cycle.financeApprovedBy) {
        actions.push(btn('Finance approve', 'finance-approve', {
          primary: true,
          disabled: isMakerOfApproval,
          title: isMakerOfApproval ? 'Finance approval must come from a different user than the HR approver' : '',
          confirm: { title: 'Finance approve?', body: 'Confirm the totals are correct. Next step is disbursement.' },
        }))
      } else {
        actions.push(btn('Disburse', 'disburse', { primary: true, confirm: { title: 'Disburse payroll?', body: 'Payslips are released to employees and the cycle becomes immutable. This cannot be undone.' } }))
      }
    }
  }

  const downloadGl = async () => {
    setError('')
    setGlBusy(true)
    try {
      await downloadCsv(`/payroll/cycles/${id}/gl-export`)
    } catch (err: any) {
      setError(err?.response?.data?.message || 'GL export failed')
    } finally {
      setGlBusy(false)
    }
  }

  if (canAct && ['approved', 'disbursed', 'locked'].includes(cycle.status)) {
    const ghost = { padding: '9px 18px', borderRadius: 12, fontSize: 13, fontWeight: 500, cursor: 'pointer', backgroundColor: 'var(--well)', color: 'var(--ink)', border: '1px solid var(--line)' } as const
    actions.push(<button key="bank-file" onClick={() => setShowBank(true)} style={ghost}>Bank file</button>)
    actions.push(<button key="gl-export" onClick={downloadGl} disabled={glBusy} style={{ ...ghost, opacity: glBusy ? 0.6 : 1 }}>{glBusy ? 'Preparing...' : 'GL export'}</button>)
  }

  return (
    <div>
      <button onClick={() => navigate('/payroll')} style={{ background: 'none', border: 'none', color: 'var(--dim)', fontSize: 13, cursor: 'pointer', padding: '0 0 16px' }}>← Payroll</button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 16 }}>
        <div>
          <h2 style={{ fontSize: 'clamp(32px, 4vw, 46px)', fontFamily: 'var(--font-display)', fontWeight: 400, letterSpacing: '-0.02em', margin: 0 }}>{fmtPeriod(cycle.payPeriodStart, cycle.payPeriodEnd)}</h2>
          <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge label={cycle.status} />
            <span style={{ fontSize: 12, color: 'var(--faint)' }}>{cycle.cycleType}{cycle.disbursedAt ? ` · disbursed ${fmtDate(cycle.disbursedAt)}` : ''}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>{actions}</div>
      </div>

      {/* Stepper */}
      <div style={{ display: 'flex', backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', padding: '14px 18px', marginBottom: 16, gap: 8 }}>
        {STEPS.map((s, i) => (
          <div key={s} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 22, height: 22, borderRadius: '50%', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: i <= step ? 'var(--brand)' : 'var(--well)', color: i <= step ? 'var(--card-2)' : 'var(--faint)', flexShrink: 0 }}>{i < step || step === STEPS.length - 1 ? '✓' : i + 1}</div>
            <span style={{ fontSize: 12, color: i <= step ? 'var(--ink)' : 'var(--faint)', fontWeight: i === step ? 500 : 400 }}>{s}</span>
          </div>
        ))}
      </div>

      {error && <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '10px 12px', fontSize: 13, marginBottom: 12, border: '1px solid var(--danger-line)' }}>{error}</div>}

      {/* Totals */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'Payslips', value: String(cycle.totals?.payslips ?? 0) },
          { label: 'Gross', value: money(cycle.totals?.gross, currency) },
          { label: 'Deductions', value: money(cycle.totals?.deductions, currency) },
          { label: 'Net pay', value: money(cycle.totals?.net, currency) },
        ].map((c) => (
          <div key={c.label} style={{ backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', padding: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 6 }}>{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 500 }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Last run result */}
      {runResult && (
        <div style={{ backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Last run: {runResult.processed} processed, {runResult.skipped.length} skipped</div>
          {runResult.skipped.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {runResult.skipped.map((s: any) => <div key={s.employeeId} style={{ fontSize: 12, color: 'var(--danger)' }}>⚠ {s.employeeCode} {s.name} — {s.reason}</div>)}
            </div>
          )}
          {Object.entries(runResult.warnings || {}).map(([who, list]: any) => (
            <div key={who} style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 4 }}><strong>{who}</strong>: {list.join(' · ')}</div>
          ))}
          <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 6 }}>Run warnings are only shown here, right after a run. Re-run to see them again.</div>
        </div>
      )}

      {/* Tabs */}
      <div className="chips" style={{ marginBottom: 16 }}>
        {([['payslips', 'Payslips'], ['variance', 'Variance report'], ['inputs', 'Manual inputs']] as [Tab, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`chip${tab === k ? ' is-on' : ''}`}>{label}</button>
        ))}
      </div>

      {tab === 'payslips' && (
        <div style={{ backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
          {payslips.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--faint)', fontSize: 13 }}>No payslips yet. Lock attendance, then run payroll.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Employee', 'Paid / working days', 'LWP', 'Gross', 'Deductions', 'Net pay', 'Status', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {payslips.map((p: any) => (
                  <tr key={p.id} onClick={() => navigate(`/payroll/payslips/${p.id}`)} style={{ borderBottom: '1px solid var(--well)', cursor: 'pointer' }}>
                    <td style={td}><strong>{p.employee.firstName} {p.employee.lastName}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>{p.employee.employeeCode}</span></td>
                    <td style={td}>{p.paidDays} / {p.workingDays}</td>
                    <td style={td}>{p.lwpDays}</td>
                    <td style={td}>{money(p.grossEarnings, p.currency)}</td>
                    <td style={td}>{money(p.totalDeductions, p.currency)}</td>
                    <td style={{ ...td, fontWeight: 500 }}>{money(p.netPay, p.currency)}</td>
                    <td style={td}><Badge label={p.status} /></td>
                    <td style={{ ...td, color: 'var(--brand)', fontSize: 12 }}>View →</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {tab === 'variance' && <VariancePanel cycleId={id!} currency={currency} />}
      {tab === 'inputs' && <InputsPanel cycleId={id!} editable={inputsEditable} currency={currency} />}

      {showBank && <BankFileModal cycleId={id!} open={showBank} onClose={() => setShowBank(false)} />}

      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.title || ''} width={420}>
        <p style={{ fontSize: 13, color: 'var(--dim)', marginTop: 0 }}>{confirm?.body}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={() => setConfirm(null)} style={{ padding: '9px 18px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => confirm && exec(confirm.action)} style={{ padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Confirm</button>
        </div>
      </Modal>
    </div>
  )
}
const th: React.CSSProperties = { padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, color: 'var(--faint)', borderBottom: '1px solid var(--line)', backgroundColor: 'var(--solid)' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: 13, color: 'var(--ink)' }

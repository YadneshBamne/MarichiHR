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

  if (isLoading) return <div style={{ color: '#8c8c88', fontSize: 13 }}>Loading cycle...</div>
  if (!cycle) return <div style={{ color: '#993C1D', fontSize: 13 }}>Cycle not found.</div>

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
        padding: '9px 18px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: opts.disabled ? 'not-allowed' : 'pointer',
        opacity: action.isPending || opts.disabled ? 0.5 : 1,
        ...(opts.primary ? { backgroundColor: '#534AB7', color: '#fff', border: 'none' } : opts.danger ? { backgroundColor: '#faece7', color: '#993C1D', border: '0.5px solid #f5c6b8' } : { backgroundColor: '#f5f4f0', color: '#1a1a18', border: '0.5px solid #e2e0da' }),
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
    const ghost = { padding: '9px 18px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', backgroundColor: '#f5f4f0', color: '#1a1a18', border: '0.5px solid #e2e0da' } as const
    actions.push(<button key="bank-file" onClick={() => setShowBank(true)} style={ghost}>Bank file</button>)
    actions.push(<button key="gl-export" onClick={downloadGl} disabled={glBusy} style={{ ...ghost, opacity: glBusy ? 0.6 : 1 }}>{glBusy ? 'Preparing...' : 'GL export'}</button>)
  }

  return (
    <div style={{ maxWidth: 1100 }}>
      <button onClick={() => navigate('/payroll')} style={{ background: 'none', border: 'none', color: '#5c5c58', fontSize: 13, cursor: 'pointer', padding: '0 0 16px' }}>← Payroll</button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 16 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 500, margin: 0 }}>{fmtPeriod(cycle.payPeriodStart, cycle.payPeriodEnd)}</h2>
          <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge label={cycle.status} />
            <span style={{ fontSize: 12, color: '#8c8c88' }}>{cycle.cycleType}{cycle.disbursedAt ? ` · disbursed ${fmtDate(cycle.disbursedAt)}` : ''}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>{actions}</div>
      </div>

      {/* Stepper */}
      <div style={{ display: 'flex', backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: 10, padding: '14px 18px', marginBottom: 16, gap: 8 }}>
        {STEPS.map((s, i) => (
          <div key={s} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 22, height: 22, borderRadius: '50%', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: i <= step ? '#534AB7' : '#f5f4f0', color: i <= step ? '#fff' : '#8c8c88', flexShrink: 0 }}>{i < step || step === STEPS.length - 1 ? '✓' : i + 1}</div>
            <span style={{ fontSize: 12, color: i <= step ? '#1a1a18' : '#8c8c88', fontWeight: i === step ? 500 : 400 }}>{s}</span>
          </div>
        ))}
      </div>

      {error && <div style={{ backgroundColor: '#faece7', color: '#993C1D', borderRadius: 6, padding: '10px 12px', fontSize: 13, marginBottom: 12, border: '0.5px solid #f5c6b8' }}>{error}</div>}

      {/* Totals */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'Payslips', value: String(cycle.totals?.payslips ?? 0) },
          { label: 'Gross', value: money(cycle.totals?.gross, currency) },
          { label: 'Deductions', value: money(cycle.totals?.deductions, currency) },
          { label: 'Net pay', value: money(cycle.totals?.net, currency) },
        ].map((c) => (
          <div key={c.label} style={{ backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 11, color: '#8c8c88', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 500 }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Last run result */}
      {runResult && (
        <div style={{ backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Last run: {runResult.processed} processed, {runResult.skipped.length} skipped</div>
          {runResult.skipped.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {runResult.skipped.map((s: any) => <div key={s.employeeId} style={{ fontSize: 12, color: '#993C1D' }}>⚠ {s.employeeCode} {s.name} — {s.reason}</div>)}
            </div>
          )}
          {Object.entries(runResult.warnings || {}).map(([who, list]: any) => (
            <div key={who} style={{ fontSize: 12, color: '#BA7517', marginBottom: 4 }}><strong>{who}</strong>: {list.join(' · ')}</div>
          ))}
          <div style={{ fontSize: 11, color: '#8c8c88', marginTop: 6 }}>Run warnings are only shown here, right after a run. Re-run to see them again.</div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '0.5px solid #e2e0da', marginBottom: 16 }}>
        {([['payslips', 'Payslips'], ['variance', 'Variance report'], ['inputs', 'Manual inputs']] as [Tab, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: '10px 18px', background: 'none', border: 'none', fontSize: 13, cursor: 'pointer', color: tab === k ? '#534AB7' : '#5c5c58', fontWeight: tab === k ? 500 : 400, borderBottom: `2px solid ${tab === k ? '#534AB7' : 'transparent'}`, marginBottom: -0.5 }}>{label}</button>
        ))}
      </div>

      {tab === 'payslips' && (
        <div style={{ backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: 10, overflow: 'hidden' }}>
          {payslips.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: '#8c8c88', fontSize: 13 }}>No payslips yet. Lock attendance, then run payroll.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Employee', 'Paid / working days', 'LWP', 'Gross', 'Deductions', 'Net pay', 'Status', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {payslips.map((p: any) => (
                  <tr key={p.id} onClick={() => navigate(`/payroll/payslips/${p.id}`)} style={{ borderBottom: '0.5px solid #f5f4f0', cursor: 'pointer' }}>
                    <td style={td}><strong>{p.employee.firstName} {p.employee.lastName}</strong> <span style={{ color: '#8c8c88', fontSize: 11 }}>{p.employee.employeeCode}</span></td>
                    <td style={td}>{p.paidDays} / {p.workingDays}</td>
                    <td style={td}>{p.lwpDays}</td>
                    <td style={td}>{money(p.grossEarnings, p.currency)}</td>
                    <td style={td}>{money(p.totalDeductions, p.currency)}</td>
                    <td style={{ ...td, fontWeight: 500 }}>{money(p.netPay, p.currency)}</td>
                    <td style={td}><Badge label={p.status} /></td>
                    <td style={{ ...td, color: '#534AB7', fontSize: 12 }}>View →</td>
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
        <p style={{ fontSize: 13, color: '#5c5c58', marginTop: 0 }}>{confirm?.body}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={() => setConfirm(null)} style={{ padding: '9px 18px', backgroundColor: '#f5f4f0', border: '0.5px solid #e2e0da', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => confirm && exec(confirm.action)} style={{ padding: '9px 18px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Confirm</button>
        </div>
      </Modal>
    </div>
  )
}
const th: React.CSSProperties = { padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, color: '#8c8c88', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '0.5px solid #e2e0da', backgroundColor: '#f9f8f6' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: 13, color: '#1a1a18' }

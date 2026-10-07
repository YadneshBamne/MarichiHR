import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useExit, useExitAction } from '../../lib/hooks/useExits'
import { downloadCsv } from '../../lib/hooks/usePayroll'
import Badge from '../../components/ui/Badge'
import Modal from '../../components/ui/Modal'
import { inputStyle } from '../../components/ui/FormField'
import { money, fmtDate } from '../../lib/format'
import { primaryBtn } from './ExitsPage'

const STEPS = ['Initiated', 'Cleared', 'Computed (HR)', 'Approved (finance)', 'Paid']
const SECTIONS: [string, string][] = [
  ['salary', 'Final month salary (prorated)'],
  ['encashment', 'Leave encashment'],
  ['notice', 'Notice period'],
  ['reimbursement', 'Approved reimbursements'],
  ['recovery', 'Recoveries'],
  ['gratuity', 'Gratuity'],
]

export default function ExitDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, hasRole } = useAuth()
  const { data: x, isLoading } = useExit(id!)
  const action = useExitAction(id!)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<null | { path: string; title: string; body: string }>(null)
  const [recoveries, setRecoveries] = useState<{ description: string; amount: string }[]>([])
  const [cancelReason, setCancelReason] = useState('')
  const [showCancel, setShowCancel] = useState(false)

  if (isLoading) return <div style={{ color: 'var(--faint)', fontSize: 13 }}>Loading...</div>
  if (!x) return <div style={{ color: 'var(--danger)', fontSize: 13 }}>Exit not found.</div>

  const isHR = hasRole('hr_admin')
  const canFinance = hasRole('payroll_admin') || hasRole('hr_admin')
  const allCleared = x.clearances.every((c: any) => c.status === 'cleared')
  const step = x.status === 'paid' ? 4 : x.status === 'approved' ? 3 : x.status === 'computed' ? 2 : allCleared ? 1 : 0
  const cur = x.currency || user?.tenant?.baseCurrency || 'ZMW'

  const run = async (path: string, body?: Record<string, unknown>) => {
    setError('')
    setConfirm(null)
    try {
      await action.mutateAsync({ path, body })
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Action failed')
    }
  }

  const compute = () => run('compute', {
    recoveries: recoveries.filter((r) => r.description.trim() && Number(r.amount) > 0).map((r) => ({ description: r.description.trim(), amount: Number(r.amount) })),
  })

  const pdf = async () => {
    setError('')
    try { await downloadCsv(`/exits/${id}/settlement.pdf`) } catch (err: any) { setError(err?.response?.data?.message || 'Could not generate the PDF') }
  }

  const ghost: React.CSSProperties = { padding: '9px 18px', borderRadius: 12, fontSize: 13, fontWeight: 500, cursor: 'pointer', backgroundColor: 'var(--well)', color: 'var(--ink)', border: '1px solid var(--line)' }
  const madeIt = x.computedBy === user?.id
  const lines: any[] = x.lines || []

  return (
    <div>
      <button onClick={() => navigate('/exits')} style={{ background: 'none', border: 'none', color: 'var(--dim)', fontSize: 13, cursor: 'pointer', padding: '0 0 16px' }}>← Exits</button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 16 }}>
        <div>
          <h2 style={{ fontSize: 'clamp(32px, 4vw, 46px)', fontFamily: 'var(--font-display)', fontWeight: 400, letterSpacing: '-0.02em', margin: 0 }}>{x.employee.firstName} {x.employee.lastName} <span style={{ fontSize: 13, color: 'var(--faint)', fontWeight: 400 }}>{x.employee.employeeCode}</span></h2>
          <p style={{ fontSize: 13, color: 'var(--faint)', marginTop: 4, textTransform: 'capitalize' }}>{x.exitType} · last working day {fmtDate(x.lastWorkingDate)} · <Badge label={x.status} /></p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {x.lines && (hasRole('hr_admin') || hasRole('payroll_admin')) && <button onClick={pdf} style={ghost}>Settlement PDF</button>}
          {isHR && ['initiated', 'computed'].includes(x.status) && <button onClick={() => setShowCancel(true)} style={{ ...ghost, backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-line)' }}>Cancel exit</button>}
          {canFinance && x.status === 'computed' && (
            <button disabled={madeIt || action.isPending} title={madeIt ? 'A different user than the one who computed must approve' : ''} onClick={() => setConfirm({ path: 'approve', title: 'Approve settlement?', body: `Net ${money(x.netPayable, cur)}. Next step is payment.` })} style={{ ...primaryBtn, opacity: madeIt ? 0.5 : 1, cursor: madeIt ? 'not-allowed' : 'pointer' }}>Approve (finance)</button>
          )}
          {canFinance && x.status === 'approved' && (
            <button onClick={() => setConfirm({ path: 'pay', title: 'Pay settlement?', body: 'Marks the settlement paid, closes the contract and archives the employee and their login. This cannot be undone.' })} style={primaryBtn}>Mark paid</button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {STEPS.map((label, i) => (
          <div key={label} style={{ flex: 1, padding: '8px 10px', borderRadius: 12, fontSize: 12, textAlign: 'center', backgroundColor: i <= step ? 'var(--honey-soft)' : 'var(--card-2)', color: i <= step ? 'var(--brand)' : 'var(--faint)', border: `1px solid ${i <= step ? 'var(--honey-2)' : 'var(--line)'}`, fontWeight: i === step ? 600 : 400 }}>{label}</div>
        ))}
      </div>

      {error && <div style={{ marginBottom: 16, backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '10px 12px', fontSize: 13 }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div style={card}>
          <div style={cardTitle}>Notice period</div>
          {[['Notice given', fmtDate(x.noticeDate)], ['Contract notice', `${x.noticePeriodDays} days`], ['Served', `${x.noticeServedDays} days`], ['Shortfall', `${x.shortfallDays} days${x.shortfallDays ? ` — ${x.shortfallAction === 'recover' ? 'recovered from employee' : x.shortfallAction === 'buyout' ? 'paid in lieu' : 'waived'}` : ''}`], ['Reason', x.reason]].map(([k, v]) => (
            <div key={k} style={row}><span style={{ color: 'var(--faint)' }}>{k}</span><span>{v}</span></div>
          ))}
        </div>
        <div style={card}>
          <div style={cardTitle}>Clearance</div>
          {x.clearances.map((c: any) => (
            <div key={c.id} style={{ ...row, alignItems: 'center' }}>
              <span>{c.department}{c.note ? <span style={{ color: 'var(--faint)' }}> — {c.note}</span> : null}</span>
              {c.status === 'cleared' ? <Badge label="cleared" variant="approved" /> : c.responsibleUserId === user?.id && x.status === 'initiated' ? (
                <button disabled={action.isPending} onClick={() => run(`clearances/${c.department}/sign`)} style={{ padding: '4px 12px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>Sign off</button>
              ) : <Badge label="pending" />}
            </div>
          ))}
        </div>
      </div>

      {isHR && ['initiated', 'computed'].includes(x.status) && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={cardTitle}>{x.status === 'computed' ? 'Recompute settlement' : 'Compute settlement'}</div>
          <p style={{ fontSize: 12, color: 'var(--faint)', margin: '0 0 10px' }}>Prorated final salary via the payroll engine, leave encashment at basic/day, notice shortfall, approved reimbursements, gratuity placeholder. Add any recoveries below.</p>
          {recoveries.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input placeholder="Recovery (e.g. unreturned laptop)" style={inputStyle} value={r.description} onChange={(e) => setRecoveries((p) => p.map((q, j) => (j === i ? { ...q, description: e.target.value } : q)))} />
              <input placeholder="Amount" type="number" min="0" style={{ ...inputStyle, width: 140 }} value={r.amount} onChange={(e) => setRecoveries((p) => p.map((q, j) => (j === i ? { ...q, amount: e.target.value } : q)))} />
              <button onClick={() => setRecoveries((p) => p.filter((_, j) => j !== i))} style={{ ...ghost, padding: '0 12px' }}>✕</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setRecoveries((p) => [...p, { description: '', amount: '' }])} style={ghost}>+ Recovery</button>
            <button disabled={!allCleared || action.isPending} title={allCleared ? '' : 'All clearances must be signed off first'} onClick={compute} style={{ ...primaryBtn, opacity: !allCleared || action.isPending ? 0.5 : 1 }}>{action.isPending ? 'Working...' : 'Compute'}</button>
          </div>
        </div>
      )}

      {x.lines && (
        <div style={card}>
          <div style={cardTitle}>Settlement</div>
          {SECTIONS.map(([key, title]) => {
            const rows = lines.filter((l) => l.section === key)
            if (!rows.length) return null
            return (
              <div key={key} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '8px 0 4px' }}>{title}</div>
                {rows.map((l, i) => (
                  <div key={i} style={row}>
                    <span>{l.name}{l.formula && <div style={{ fontSize: 11, color: 'var(--faint)' }}>{l.formula}</div>}</span>
                    <span style={{ whiteSpace: 'nowrap', color: l.kind === 'deduction' ? 'var(--danger)' : 'var(--ink)' }}>{l.kind === 'deduction' ? '−' : ''}{money(l.amount, cur)}</span>
                  </div>
                ))}
              </div>
            )
          })}
          <div style={row}><span>Total earnings</span><strong>{money(x.totalEarnings, cur)}</strong></div>
          <div style={row}><span>Total deductions &amp; recoveries</span><strong>−{money(x.totalDeductions, cur)}</strong></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'var(--honey-soft)', borderRadius: 12, padding: '12px 14px', marginTop: 8 }}>
            <strong style={{ fontSize: 13 }}>{x.netPayable < 0 ? 'Recoverable from employee' : 'Net payable'}</strong>
            <span style={{ fontSize: 20, fontWeight: 600, color: 'var(--brand)' }}>{money(Math.abs(x.netPayable), cur)}</span>
          </div>
          {(x.warnings || []).length > 0 && (
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--warn)' }}>{x.warnings.map((w: string) => <div key={w}>• {w}</div>)}</div>
          )}
        </div>
      )}

      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.title || ''} width={440}>
        <p style={{ fontSize: 13, color: 'var(--dim)', marginTop: 0 }}>{confirm?.body}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={() => setConfirm(null)} style={ghost}>Back</button>
          <button onClick={() => confirm && run(confirm.path)} style={primaryBtn}>Confirm</button>
        </div>
      </Modal>

      <Modal open={showCancel} onClose={() => setShowCancel(false)} title="Cancel exit" width={440}>
        <textarea placeholder="Reason" style={{ ...inputStyle, minHeight: 70 }} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button onClick={() => setShowCancel(false)} style={ghost}>Back</button>
          <button disabled={!cancelReason.trim()} onClick={() => { setShowCancel(false); run('cancel', { reason: cancelReason.trim() }) }} style={{ ...primaryBtn, backgroundColor: 'var(--danger)', opacity: cancelReason.trim() ? 1 : 0.5 }}>Cancel exit</button>
        </div>
      </Modal>
    </div>
  )
}

const card: React.CSSProperties = { backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', padding: '16px 18px' }
const cardTitle: React.CSSProperties = { fontSize: 12, fontWeight: 500, color: 'var(--brand)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 10 }
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--well)', fontSize: 13 }

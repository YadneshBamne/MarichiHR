import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useExit, useExitAction, useAssignableUsers } from '../../lib/hooks/useExits'
import { downloadCsv } from '../../lib/hooks/usePayroll'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { money, fmtDate } from '../../lib/format'
import { STATUS_PILL, STATUS_TEXT } from './ExitsPage'
import { ClearanceFields, clearancesReady, pickedClearances, duplicateClearance, localDay } from './InitiateExitModal'

const STEPS = ['Initiated', 'Cleared', 'Computed (payroll)', 'Approved (second payroll admin)', 'Paid']
const SECTIONS: [string, string][] = [
  ['salary', 'Final month salary (prorated)'],
  ['encashment', 'Leave encashment'],
  ['notice', 'Notice period'],
  ['reimbursement', 'Approved reimbursements'],
  ['recovery', 'Recoveries'],
  ['gratuity', 'Gratuity'],
]
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--well)', fontSize: 13 }
const twoUp: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 16 }

export default function ExitDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, hasRole } = useAuth()
  const { data: x, isLoading } = useExit(id!)
  const action = useExitAction(id!)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<null | { path: string; title: string; body: string }>(null)
  const [recoveries, setRecoveries] = useState<{ description: string; amount: string }[]>([])
  const [reasonFor, setReasonFor] = useState<null | 'cancel' | 'decline'>(null)
  const [reason, setReason] = useState('')
  const [accepting, setAccepting] = useState(false)
  const [recovering, setRecovering] = useState(false)

  if (isLoading) return <div className="skeleton" style={{ height: 240, borderRadius: 22 }} />
  if (!x) return <section className="card" style={{ padding: 28 }}><h2>Exit not found</h2><button className="btn btn-ghost btn-sm" onClick={() => navigate('/exits')}>Back to offboarding</button></section>

  const isHR = hasRole('hr_admin')
  const canFinance = hasRole('payroll_admin')
  const allCleared = x.clearances.length > 0 && x.clearances.every((c: any) => c.status === 'cleared')
  const step = x.status === 'paid' ? 4 : x.status === 'approved' ? 3 : x.status === 'computed' ? 2 : allCleared ? 1 : 0
  const cur = x.currency || user?.tenant?.baseCurrency || 'ZMW'
  const open = ['initiated', 'computed', 'approved'].includes(x.status)
  const lastDayPassed = open && String(x.lastWorkingDate).slice(0, 10) < localDay()

  const run = async (path: string, body?: Record<string, unknown>) => {
    setError('')
    setConfirm(null)
    try { await action.mutateAsync({ path, body }); return true } catch (err: any) { setError(err?.response?.data?.message || 'Action failed'); return false }
  }
  const compute = () => run('compute', { recoveries: recoveries.filter((r) => r.description.trim() && Number(r.amount) > 0).map((r) => ({ description: r.description.trim(), amount: Number(r.amount) })) })
  const pdf = async () => { setError(''); try { await downloadCsv(`/exits/${id}/settlement.pdf`) } catch (err: any) { setError(err?.response?.data?.message || 'Could not generate the PDF') } }
  const madeIt = x.computedBy === user?.id
  const lines: any[] = x.lines || []

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 14 }} onClick={() => navigate('/exits')}><Icon name="chevronLeft" size={14} /> Exits</button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 'clamp(30px, 4vw, 42px)', lineHeight: 1.1 }}>{x.employee.firstName} {x.employee.lastName} <span className="dim" style={{ fontSize: 14, fontWeight: 400 }}>{x.employee.employeeCode}</span></h1>
          <p className="dim" style={{ marginTop: 6, textTransform: 'capitalize', fontSize: 13 }}>{x.exitType} · last working day {fmtDate(x.lastWorkingDate)} <span className={`pill ${STATUS_PILL[x.status] ?? 'mute'}`} style={{ textTransform: 'none', marginLeft: 6 }}>{STATUS_TEXT[x.status] ?? x.status}</span></p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {x.lines && canFinance && <button className="btn btn-ghost btn-sm" onClick={pdf}><Icon name="download" size={14} /> Settlement PDF</button>}
          {isHR && lastDayPassed && <button className="btn btn-ghost btn-sm" title="The last-day job ended their sign-in; this gives it back" disabled={action.isPending} onClick={() => run('restore-login')}>Restore sign-in</button>}
          {isHR && ['initiated', 'computed'].includes(x.status) && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => { setReason(''); setReasonFor('cancel') }}>Cancel exit</button>}
          {canFinance && x.status === 'computed' && (
            <button className="btn btn-primary btn-sm" disabled={madeIt || x.needsRecovery || action.isPending} title={madeIt ? 'A different user than the one who computed must approve' : x.needsRecovery ? 'Record how the negative amount is recovered first' : ''} onClick={() => setConfirm({ path: 'approve', title: 'Approve settlement?', body: `Net ${money(x.netPayable, cur)}. Next step is payment.` })}>Approve</button>
          )}
          {canFinance && x.status === 'approved' && (
            <button className="btn btn-primary btn-sm" disabled={x.needsRecovery} title={x.needsRecovery ? 'Record how the negative amount is recovered first' : ''} onClick={() => setConfirm({ path: 'pay', title: 'Pay settlement?', body: 'Marks the settlement paid, closes the contract, archives the employee and their login, ends their sign-in, and moves their reports to their manager. This cannot be undone.' })}>Mark paid</button>
          )}
        </div>
      </div>

      {x.status === 'requested' && (
        <section className="card" style={{ padding: 18, marginBottom: 16, display: 'grid', gap: 8 }}>
          <strong>{x.employee.firstName} handed in a resignation</strong>
          <span style={{ fontSize: 14 }}>“{x.reason}”</span>
          <span className="dim" style={{ fontSize: 13 }}>Proposed last working day {fmtDate(x.lastWorkingDate)} · contract notice {x.noticePeriodDays} days · notice served {x.noticeServedDays} days{x.shortfallDays ? ` · ${x.shortfallDays} days short` : ''}</span>
          {isHR ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="btn btn-primary btn-sm" onClick={() => setAccepting(true)}>Accept and set sign-offs</button><button className="btn btn-ghost btn-sm" onClick={() => { setReason(''); setReasonFor('decline') }}>Decline</button></div> : <span className="dim" style={{ fontSize: 13 }}>Waiting for HR.</span>}
        </section>
      )}
      {x.status === 'declined' && x.cancelReason && <p className="pill warn" style={{ whiteSpace: 'normal', textTransform: 'none', marginBottom: 14 }}>Declined: {x.cancelReason}</p>}

      {x.status !== 'requested' && x.status !== 'declined' && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
          {STEPS.map((label, i) => (
            <div key={label} style={{ flex: '1 1 130px', padding: '8px 10px', borderRadius: 12, fontSize: 12, textAlign: 'center', background: i <= step ? 'var(--honey-soft)' : 'var(--card-2)', color: i <= step ? 'var(--brand)' : 'var(--faint)', border: `1px solid ${i <= step ? 'var(--honey-2)' : 'var(--line)'}`, fontWeight: i === step ? 600 : 400 }}>{label}</div>
          ))}
        </div>
      )}

      {error && <div role="alert" className="pill danger" style={{ marginBottom: 16, whiteSpace: 'normal', textTransform: 'none', display: 'block' }}>{error}</div>}

      <div style={twoUp}>
        <section className="card" style={{ padding: '16px 18px' }}>
          <h3 style={{ fontSize: 13, color: 'var(--brand)', marginBottom: 10 }}>Notice period</h3>
          {[['Notice given', fmtDate(x.noticeDate)], ['Contract notice', `${x.noticePeriodDays} days`], ['Served', `${x.noticeServedDays} days`], ['Shortfall', `${x.shortfallDays} days${x.shortfallDays ? ` — ${x.shortfallAction === 'recover' ? 'recovered from employee' : x.shortfallAction === 'buyout' ? 'paid in lieu' : 'waived'}` : ''}`], ['Reason', x.reason]].map(([k, v]) => (
            <div key={k} style={row}><span className="dim">{k}</span><span style={{ textAlign: 'right' }}>{v}</span></div>
          ))}
        </section>
        <section className="card" style={{ padding: '16px 18px' }}>
          <h3 style={{ fontSize: 13, color: 'var(--brand)', marginBottom: 10 }}>Clearance</h3>
          {x.clearances.length === 0 && <p className="dim" style={{ fontSize: 13, margin: 0 }}>The sign-offs are set when HR accepts the resignation.</p>}
          {x.clearances.map((c: any) => (
            <div key={c.id} style={{ ...row, alignItems: 'center' }}>
              <span>{c.department}{c.note ? <span className="dim"> — {c.note}</span> : null}</span>
              {c.status === 'cleared' ? <span className="pill ok">cleared</span> : c.responsibleUserId === user?.id && x.status === 'initiated' ? (
                <button className="btn btn-primary btn-sm" disabled={action.isPending} onClick={() => run(`clearances/${c.department}/sign`)}>Sign off</button>
              ) : <span className="pill mute">pending</span>}
            </div>
          ))}
        </section>
      </div>

      {(x.needsRecovery || x.recovery) && (hasRole('hr_admin') || canFinance) && (
        <section className="card" style={{ padding: '16px 18px', marginBottom: 16, display: 'grid', gap: 8 }}>
          <h3 style={{ fontSize: 13, color: x.needsRecovery ? 'var(--danger)' : 'var(--brand)' }}>{x.needsRecovery ? 'The employee owes money: record the recovery' : 'Recovery recorded'}</h3>
          {x.needsRecovery
            ? <p className="dim" style={{ fontSize: 13, margin: 0 }}>This settlement is negative. It cannot be approved or paid until someone records how the amount is recovered, or that it is waived.</p>
            : <p style={{ fontSize: 13, margin: 0 }}>{x.recovery.waived ? 'Waived. ' : ''}{x.recovery.note}{x.recovery.recoveredAmount != null ? ` · recovered ${money(x.recovery.recoveredAmount, cur)}` : ''}</p>}
          {['computed', 'approved'].includes(x.status) && <div><button className="btn btn-ghost btn-sm" onClick={() => setRecovering(true)}>{x.needsRecovery ? 'Record the recovery' : 'Record another note'}</button></div>}
        </section>
      )}

      {canFinance && ['initiated', 'computed'].includes(x.status) && (
        <section className="card" style={{ padding: '16px 18px', marginBottom: 16 }}>
          <h3 style={{ fontSize: 13, color: 'var(--brand)', marginBottom: 10 }}>{x.status === 'computed' ? 'Recompute settlement' : 'Compute settlement'}</h3>
          <p className="dim" style={{ fontSize: 12, margin: '0 0 10px' }}>Prorated final salary via the payroll engine, leave encashment at basic/day, notice shortfall, approved reimbursements and gratuity. Add any recoveries below.</p>
          {recoveries.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <input className="input" style={{ flex: '1 1 220px' }} placeholder="Recovery (e.g. unreturned laptop)" value={r.description} onChange={(e) => setRecoveries((p) => p.map((q, j) => (j === i ? { ...q, description: e.target.value } : q)))} />
              <input className="input" style={{ width: 140 }} placeholder="Amount" type="number" min="0" value={r.amount} onChange={(e) => setRecoveries((p) => p.map((q, j) => (j === i ? { ...q, amount: e.target.value } : q)))} />
              <button className="btn btn-ghost btn-icon btn-sm" aria-label="Remove recovery" onClick={() => setRecoveries((p) => p.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setRecoveries((p) => [...p, { description: '', amount: '' }])}>+ Recovery</button>
            <button className="btn btn-primary btn-sm" disabled={!allCleared || action.isPending} title={allCleared ? '' : 'All clearances must be signed off first'} onClick={compute}>{action.isPending ? 'Working…' : 'Compute'}</button>
          </div>
        </section>
      )}

      {x.lines && (
        <section className="card" style={{ padding: '16px 18px' }}>
          <h3 style={{ fontSize: 13, color: 'var(--brand)', marginBottom: 10 }}>Settlement</h3>
          {SECTIONS.map(([key, title]) => {
            const rows = lines.filter((l) => l.section === key)
            if (!rows.length) return null
            return (
              <div key={key} style={{ marginBottom: 12 }}>
                <div className="dim" style={{ fontSize: 11, margin: '8px 0 4px' }}>{title}</div>
                {rows.map((l, i) => (
                  <div key={i} style={row}>
                    <span>{l.name}{l.formula && <div className="dim" style={{ fontSize: 11 }}>{l.formula}</div>}</span>
                    <span style={{ whiteSpace: 'nowrap', color: l.kind === 'deduction' ? 'var(--danger)' : 'var(--ink)' }}>{l.kind === 'deduction' ? '−' : ''}{money(l.amount, cur)}</span>
                  </div>
                ))}
              </div>
            )
          })}
          <div style={row}><span>Total earnings</span><strong>{money(x.totalEarnings, cur)}</strong></div>
          <div style={row}><span>Total deductions &amp; recoveries</span><strong>−{money(x.totalDeductions, cur)}</strong></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--honey-soft)', borderRadius: 12, padding: '12px 14px', marginTop: 8 }}>
            <strong style={{ fontSize: 13 }}>{x.netPayable < 0 ? 'Recoverable from employee' : 'Net payable'}</strong>
            <span style={{ fontSize: 20, fontWeight: 600, color: 'var(--brand)' }}>{money(Math.abs(x.netPayable), cur)}</span>
          </div>
          {(x.warnings || []).length > 0 && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--warn)' }}>{x.warnings.map((w: string) => <div key={w}>• {w}</div>)}</div>}
        </section>
      )}

      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.title || ''} width={440}>
        <p className="dim" style={{ fontSize: 13, marginTop: 0 }}>{confirm?.body}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-ghost" onClick={() => setConfirm(null)}>Back</button>
          <button className="btn btn-primary" onClick={() => confirm && run(confirm.path)}>Confirm</button>
        </div>
      </Modal>

      <Modal open={!!reasonFor} onClose={() => setReasonFor(null)} title={reasonFor === 'decline' ? 'Decline the resignation' : 'Cancel exit'} width={440}>
        <label className="field"><span>{reasonFor === 'decline' ? 'Reason (the employee sees it)' : 'Reason'}</span><textarea className="input" style={{ minHeight: 80, height: 'auto', padding: 12 }} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={() => setReasonFor(null)}>Back</button>
          <button className="btn btn-primary" disabled={reason.trim().length < 3} onClick={async () => { const p = reasonFor === 'decline' ? 'decline' : 'cancel'; setReasonFor(null); await run(p, { reason: reason.trim() }) }}>{reasonFor === 'decline' ? 'Decline' : 'Cancel exit'}</button>
        </div>
      </Modal>

      {accepting && <AcceptModal x={x} onClose={() => setAccepting(false)} onAccept={async (body) => { if (await run('accept', body)) setAccepting(false) }} />}
      {recovering && <RecoveryModal canAmount={canFinance} currency={cur} onClose={() => setRecovering(false)} onSave={async (body) => { if (await run('recovery', body)) setRecovering(false) }} />}
    </div>
  )
}

function AcceptModal({ x, onClose, onAccept }: { x: any; onClose: () => void; onAccept: (b: Record<string, unknown>) => void }) {
  const { data: users = [] } = useAssignableUsers(true)
  const [f, setF] = useState({ noticeDate: String(x.noticeDate).slice(0, 10), lastWorkingDate: String(x.lastWorkingDate).slice(0, 10), shortfallAction: '' })
  const [clearance, setClearance] = useState<Record<string, string>>({ IT: '', FINANCE: '', ADMIN: '', MANAGER: '' })
  const [left, setLeft] = useState(false)
  const past = f.lastWorkingDate < localDay()
  const ok = clearancesReady(clearance) && !duplicateClearance(clearance) && (!past || left)
  return (
    <Modal open onClose={onClose} title="Accept the resignation" width={640}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14 }}>
        <label className="field"><span>Notice date</span><input className="input" type="date" value={f.noticeDate} onChange={(e) => setF({ ...f, noticeDate: e.target.value })} /></label>
        <label className="field"><span>Last working day</span><input className="input" type="date" value={f.lastWorkingDate} min={f.noticeDate} onChange={(e) => setF({ ...f, lastWorkingDate: e.target.value })} /></label>
        <label className="field"><span>Notice shortfall</span>
          <select className="input" value={f.shortfallAction} onChange={(e) => setF({ ...f, shortfallAction: e.target.value })}>
            <option value="">Default (recover from employee)</option><option value="recover">Recover from employee</option><option value="buyout">Pay in lieu (buyout)</option><option value="waive">Waive</option>
          </select>
        </label>
      </div>
      {past && <label className="well" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 12, marginTop: 14, fontSize: 13 }}><input type="checkbox" checked={left} onChange={(e) => setLeft(e.target.checked)} style={{ marginTop: 3 }} /><span><strong>The person has already left.</strong> Tick to confirm the exit is backdated.</span></label>}
      <ClearanceFields users={users} exitingUserId={x.employee.userId} value={clearance} onChange={setClearance} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!ok} onClick={() => onAccept({ noticeDate: f.noticeDate, lastWorkingDate: f.lastWorkingDate, ...(f.shortfallAction && { shortfallAction: f.shortfallAction }), ...(past && left && { backdated: true }), clearance: pickedClearances(clearance) })}>Accept</button>
      </div>
    </Modal>
  )
}

function RecoveryModal({ canAmount, currency, onClose, onSave }: { canAmount: boolean; currency: string; onClose: () => void; onSave: (b: Record<string, unknown>) => void }) {
  const [f, setF] = useState({ note: '', amount: '', waived: false })
  return (
    <Modal open onClose={onClose} title="Record the recovery" width={480}>
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>How is it recovered, or why is it waived? *</span><textarea className="input" style={{ minHeight: 80, height: 'auto', padding: 12 }} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="For example: deducted from the final salary advance; or agreed with the employee to repay in two instalments" /></label>
        {canAmount && <label className="field"><span>Amount recovered so far ({currency}, optional)</span><input className="input" type="number" min={0} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}><input type="checkbox" checked={f.waived} onChange={(e) => setF({ ...f, waived: e.target.checked })} /> The company waives the amount</label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={f.note.trim().length < 5} onClick={() => onSave({ note: f.note.trim(), waived: f.waived, ...(canAmount && f.amount !== '' && { recoveredAmount: Number(f.amount) }) })}>Save</button>
        </div>
      </div>
    </Modal>
  )
}

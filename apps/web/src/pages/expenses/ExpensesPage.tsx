import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import Badge from '../../components/ui/Badge'
import Modal from '../../components/ui/Modal'
import NewClaimModal from './NewClaimModal'
import { useMyClaims, usePendingClaims, useAwaitingFinance, useWithdrawClaim, useClaimAction } from '../../lib/hooks/useExpenses'
import { money, fmtDate } from '../../lib/format'

type Tab = 'mine' | 'approvals' | 'finance'

const statusBadge = (status: string) => <Badge label={status.replace(/_/g, ' ')} variant={status} />

export default function ExpensesPage() {
  const { user, hasRole } = useAuth()
  const canApprove = hasRole('manager') || hasRole('hr_admin')
  const canFinance = hasRole('payroll_admin') || hasRole('hr_admin')

  const [tab, setTab] = useState<Tab>('mine')
  const [showNew, setShowNew] = useState(false)

  const tabs: [Tab, string][] = [['mine', 'My claims'], ...(canApprove ? [['approvals', 'Approvals'] as [Tab, string]] : []), ...(canFinance ? [['finance', 'Finance'] as [Tab, string]] : [])]
  const { data: pending = [] } = usePendingClaims(canApprove)
  const { data: awaiting = [] } = useAwaitingFinance(canFinance)
  const count = (t: Tab) => (t === 'approvals' ? pending.length : t === 'finance' ? awaiting.length : 0)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 'clamp(32px, 4vw, 46px)', fontFamily: 'var(--font-display)', fontWeight: 400, letterSpacing: '-0.02em', margin: 0 }}>Expenses</h2>
          <p style={{ fontSize: 13, color: 'var(--faint)', marginTop: 2 }}>Claim reimbursements and per diem — paid with your salary, untaxed</p>
        </div>
        <button onClick={() => setShowNew(true)} style={{ padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>+ New claim</button>
      </div>

      <div className="chips" style={{ marginBottom: 20 }}>
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`chip${tab === k ? ' is-on' : ''}`}>
            {label}
            {count(k) > 0 && <span style={{ backgroundColor: 'var(--danger)', color: 'var(--night-ink)', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 'var(--r-card)' }}>{count(k)}</span>}
          </button>
        ))}
      </div>

      {tab === 'mine' && <MyClaims />}
      {tab === 'approvals' && canApprove && <Queue claims={pending} mode="manager" userId={user?.id} employeeId={user?.employee?.id} />}
      {tab === 'finance' && canFinance && <Queue claims={awaiting} mode="finance" userId={user?.id} employeeId={user?.employee?.id} />}

      <NewClaimModal open={showNew} onClose={() => setShowNew(false)} />
    </div>
  )
}

function MyClaims() {
  const { data: claims = [], isLoading } = useMyClaims()
  const withdraw = useWithdrawClaim()
  const [error, setError] = useState('')

  const doWithdraw = async (id: string) => {
    setError('')
    try { await withdraw.mutateAsync(id) } catch (err: any) { setError(err?.response?.data?.message || 'Could not withdraw the claim') }
  }

  return (
    <div>
      {error && <div style={errBox}>{error}</div>}
      <div style={card}>
        {isLoading ? <div style={empty}>Loading...</div> : claims.length === 0 ? <div style={empty}>No claims yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Date', 'Category', 'Type', 'Amount', 'In home currency', 'Status', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {claims.map((c: any) => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--well)' }}>
                  <td style={td}>{fmtDate(c.expenseDate)}</td>
                  <td style={td}>{c.category?.name}</td>
                  <td style={td}>{c.claimType === 'per_diem' ? `Per diem (${c.perDiemDays} d)` : 'Actual'}</td>
                  <td style={td}>{money(c.expenseAmount, c.expenseCurrency)}</td>
                  <td style={td}>{money(c.homeAmount, c.homeCurrency)}{c.overLimit && <span title="Over the category limit" style={{ marginLeft: 6, color: 'var(--warn)', fontSize: 12 }}>⚠ over limit</span>}</td>
                  <td style={td}>{statusBadge(c.status)}{c.status === 'rejected' && c.rejectionReason && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>{c.rejectionReason}</div>}</td>
                  <td style={td}>{c.status === 'submitted' && <button onClick={() => doWithdraw(c.id)} disabled={withdraw.isPending} style={ghostBtn}>Withdraw</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Queue({ claims, mode, userId, employeeId }: { claims: any[]; mode: 'manager' | 'finance'; userId?: string; employeeId?: string }) {
  const act = useClaimAction()
  const [error, setError] = useState('')
  const [rejecting, setRejecting] = useState<any>(null)
  const [reason, setReason] = useState('')

  const run = async (id: string, action: string, why?: string) => {
    setError('')
    try { await act.mutateAsync({ id, action, reason: why }); setRejecting(null); setReason('') } catch (err: any) { setError(err?.response?.data?.message || 'Action failed') }
  }
  const approveAction = mode === 'finance' ? 'finance-approve' : 'approve'
  const rejectAction = mode === 'finance' ? 'finance-reject' : 'reject'

  const blockReason = (c: any) => {
    if (mode !== 'finance') return ''
    if (employeeId && c.employeeId === employeeId) return 'You cannot finance-approve your own claim'
    if (userId && c.managerApprovedByUserId === userId) return 'Finance approval must come from a different user than the manager approver'
    return ''
  }

  return (
    <div>
      {error && <div style={errBox}>{error}</div>}
      <div style={card}>
        {claims.length === 0 ? <div style={empty}>{mode === 'manager' ? 'No claims waiting for your approval.' : 'No claims waiting for finance.'}</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Employee', 'Date', 'Category', 'Amount', 'In home currency', 'Details', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {claims.map((c: any) => {
                const blocked = blockReason(c)
                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--well)' }}>
                    <td style={td}><strong>{c.employee?.firstName} {c.employee?.lastName}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>{c.employee?.employeeCode}</span></td>
                    <td style={td}>{fmtDate(c.expenseDate)}</td>
                    <td style={td}>{c.category?.name}</td>
                    <td style={td}>{money(c.expenseAmount, c.expenseCurrency)}</td>
                    <td style={td}>{money(c.homeAmount, c.homeCurrency)}{c.overLimit && <span style={{ marginLeft: 6, color: 'var(--warn)', fontSize: 12 }}>⚠ over limit</span>}</td>
                    <td style={{ ...td, color: 'var(--dim)', maxWidth: 220 }}>{c.description}{c.receiptNumber && <div style={{ fontSize: 11, color: 'var(--faint)' }}>Receipt {c.receiptNumber}</div>}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <button
                        disabled={!!blocked || act.isPending}
                        title={blocked}
                        onClick={() => run(c.id, approveAction)}
                        style={{ padding: '5px 12px', backgroundColor: 'var(--ok-bg)', color: 'var(--ok)', border: '1px solid var(--ok-line)', borderRadius: 4, fontSize: 12, cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.4 : 1, marginRight: 6 }}
                      >Approve</button>
                      <button onClick={() => { setRejecting(c); setReason('') }} disabled={act.isPending} style={{ padding: '5px 12px', backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-line)', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>Reject</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title="Reject claim" width={420}>
        <p style={{ fontSize: 13, color: 'var(--dim)', marginTop: 0 }}>Rejecting {rejecting?.employee?.firstName}'s {rejecting?.category?.name} claim of {rejecting && money(rejecting.homeAmount, rejecting.homeCurrency)}.</p>
        <textarea style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 12, border: '1px solid var(--line-2)', fontSize: 13, fontFamily: 'inherit' }} rows={3} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={() => setRejecting(null)} style={ghostBtn}>Cancel</button>
          <button disabled={!reason.trim() || act.isPending} onClick={() => rejecting && run(rejecting.id, rejectAction, reason.trim())} style={{ padding: '8px 18px', backgroundColor: 'var(--danger)', color: 'var(--night-ink)', border: 'none', borderRadius: 12, fontSize: 13, cursor: 'pointer', opacity: !reason.trim() ? 0.5 : 1 }}>Reject</button>
        </div>
      </Modal>
    </div>
  )
}

const card: React.CSSProperties = { backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', overflow: 'hidden' }
const empty: React.CSSProperties = { padding: 40, textAlign: 'center', color: 'var(--faint)', fontSize: 13 }
const errBox: React.CSSProperties = { backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '10px 12px', fontSize: 13, marginBottom: 12 }
const ghostBtn: React.CSSProperties = { padding: '5px 12px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 12, cursor: 'pointer' }
const th: React.CSSProperties = { padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '1px solid var(--line)', backgroundColor: 'var(--solid)' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: 13, color: 'var(--ink)' }

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useExits, useMyClearances } from '../../lib/hooks/useExits'
import Badge from '../../components/ui/Badge'
import InitiateExitModal from './InitiateExitModal'
import { money, fmtDate } from '../../lib/format'

type Tab = 'exits' | 'signoffs'

export default function ExitsPage() {
  const { hasRole } = useAuth()
  const navigate = useNavigate()
  const isStaff = hasRole('hr_admin') || hasRole('payroll_admin')
  const [tab, setTab] = useState<Tab>(isStaff ? 'exits' : 'signoffs')
  const [showInitiate, setShowInitiate] = useState(false)

  const { data: exits = [], isLoading } = useExits(isStaff)
  const { data: mine = [] } = useMyClearances()

  const tabs: [Tab, string][] = [...(isStaff ? [['exits', 'Exits & settlements'] as [Tab, string]] : []), ['signoffs', `My sign-offs${mine.length ? ` (${mine.length})` : ''}`]]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 'clamp(32px, 4vw, 46px)', fontFamily: 'var(--font-display)', fontWeight: 400, letterSpacing: '-0.02em', margin: 0 }}>Exits</h2>
          <p style={{ fontSize: 13, color: 'var(--faint)', marginTop: 2 }}>Resignations, terminations and full &amp; final settlements</p>
        </div>
        {hasRole('hr_admin') && tab === 'exits' && (
          <button onClick={() => setShowInitiate(true)} style={primaryBtn}>+ Initiate exit</button>
        )}
      </div>

      <div className="chips" style={{ marginBottom: 20 }}>
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`chip${tab === k ? ' is-on' : ''}`}>{label}</button>
        ))}
      </div>

      {tab === 'exits' && isStaff && (
        <div style={card}>
          {isLoading ? <div style={empty}>Loading...</div> : exits.length === 0 ? <div style={empty}>No exits yet.</div> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Employee', 'Type', 'Last working day', 'Clearance', 'Net payable', 'Status', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {exits.map((x: any) => {
                  const cleared = x.clearances.filter((c: any) => c.status === 'cleared').length
                  return (
                    <tr key={x.id} onClick={() => navigate(`/exits/${x.id}`)} style={{ borderBottom: '1px solid var(--well)', cursor: 'pointer' }}>
                      <td style={td}><strong>{x.employee.firstName} {x.employee.lastName}</strong><div style={{ fontSize: 11, color: 'var(--faint)' }}>{x.employee.employeeCode}</div></td>
                      <td style={{ ...td, textTransform: 'capitalize' }}>{x.exitType}</td>
                      <td style={td}>{fmtDate(x.lastWorkingDate)}</td>
                      <td style={td}>{cleared}/{x.clearances.length}</td>
                      <td style={td}>{x.netPayable == null ? '—' : money(x.netPayable, x.currency)}</td>
                      <td style={td}><Badge label={x.status} /></td>
                      <td style={{ ...td, color: 'var(--brand)', fontSize: 12 }}>Open →</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'signoffs' && (
        <div style={card}>
          {mine.length === 0 ? <div style={empty}>Nothing waiting for your sign-off.</div> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Employee', 'Your clearance', 'Last working day', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {mine.map((c: any) => (
                  <tr key={c.id} onClick={() => navigate(`/exits/${c.exitId}`)} style={{ borderBottom: '1px solid var(--well)', cursor: 'pointer' }}>
                    <td style={td}><strong>{c.exit.employee.firstName} {c.exit.employee.lastName}</strong></td>
                    <td style={td}>{c.department}</td>
                    <td style={td}>{fmtDate(c.exit.lastWorkingDate)}</td>
                    <td style={{ ...td, color: 'var(--brand)', fontSize: 12 }}>Review &amp; sign →</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <InitiateExitModal open={showInitiate} onClose={() => setShowInitiate(false)} onCreated={(id) => navigate(`/exits/${id}`)} />
    </div>
  )
}

export const primaryBtn: React.CSSProperties = { padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 500, cursor: 'pointer' }
const card: React.CSSProperties = { backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', overflow: 'hidden' }
const empty: React.CSSProperties = { padding: 40, textAlign: 'center', color: 'var(--faint)', fontSize: 13 }
export const th: React.CSSProperties = { padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '1px solid var(--line)', backgroundColor: 'var(--solid)' }
export const td: React.CSSProperties = { padding: '12px 16px', fontSize: 13, color: 'var(--ink)' }

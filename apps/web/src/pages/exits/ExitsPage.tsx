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
    <div style={{ maxWidth: 1100 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 500, margin: 0 }}>Exits</h2>
          <p style={{ fontSize: 13, color: '#8c8c88', marginTop: 2 }}>Resignations, terminations and full &amp; final settlements</p>
        </div>
        {hasRole('hr_admin') && tab === 'exits' && (
          <button onClick={() => setShowInitiate(true)} style={primaryBtn}>+ Initiate exit</button>
        )}
      </div>

      <div style={{ display: 'flex', borderBottom: '0.5px solid #e2e0da', marginBottom: 20 }}>
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: '10px 18px', background: 'none', border: 'none', fontSize: 13, cursor: 'pointer', color: tab === k ? '#534AB7' : '#5c5c58', fontWeight: tab === k ? 500 : 400, borderBottom: `2px solid ${tab === k ? '#534AB7' : 'transparent'}`, marginBottom: -0.5 }}>{label}</button>
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
                    <tr key={x.id} onClick={() => navigate(`/exits/${x.id}`)} style={{ borderBottom: '0.5px solid #f5f4f0', cursor: 'pointer' }}>
                      <td style={td}><strong>{x.employee.firstName} {x.employee.lastName}</strong><div style={{ fontSize: 11, color: '#8c8c88' }}>{x.employee.employeeCode}</div></td>
                      <td style={{ ...td, textTransform: 'capitalize' }}>{x.exitType}</td>
                      <td style={td}>{fmtDate(x.lastWorkingDate)}</td>
                      <td style={td}>{cleared}/{x.clearances.length}</td>
                      <td style={td}>{x.netPayable == null ? '—' : money(x.netPayable, x.currency)}</td>
                      <td style={td}><Badge label={x.status} /></td>
                      <td style={{ ...td, color: '#534AB7', fontSize: 12 }}>Open →</td>
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
                  <tr key={c.id} onClick={() => navigate(`/exits/${c.exitId}`)} style={{ borderBottom: '0.5px solid #f5f4f0', cursor: 'pointer' }}>
                    <td style={td}><strong>{c.exit.employee.firstName} {c.exit.employee.lastName}</strong></td>
                    <td style={td}>{c.department}</td>
                    <td style={td}>{fmtDate(c.exit.lastWorkingDate)}</td>
                    <td style={{ ...td, color: '#534AB7', fontSize: 12 }}>Review &amp; sign →</td>
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

export const primaryBtn: React.CSSProperties = { padding: '9px 18px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' }
const card: React.CSSProperties = { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: 10, overflow: 'hidden' }
const empty: React.CSSProperties = { padding: 40, textAlign: 'center', color: '#8c8c88', fontSize: 13 }
export const th: React.CSSProperties = { padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, color: '#8c8c88', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '0.5px solid #e2e0da', backgroundColor: '#f9f8f6' }
export const td: React.CSSProperties = { padding: '12px 16px', fontSize: 13, color: '#1a1a18' }

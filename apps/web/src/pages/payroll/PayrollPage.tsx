import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useCycles, useMyPayslips, downloadPayslipPdf } from '../../lib/hooks/usePayroll'
import Badge from '../../components/ui/Badge'
import CreateCycleModal from './CreateCycleModal'
import { money, fmtPeriod } from '../../lib/format'

type Tab = 'cycles' | 'mine'

export default function PayrollPage() {
  const { hasRole } = useAuth()
  const navigate = useNavigate()
  const isStaff = hasRole('hr_admin') || hasRole('payroll_admin') || hasRole('compliance_officer')
  const canCreate = hasRole('hr_admin') || hasRole('payroll_admin')
  const [tab, setTab] = useState<Tab>(isStaff ? 'cycles' : 'mine')
  const [showCreate, setShowCreate] = useState(false)
  const [pdfError, setPdfError] = useState('')

  const { data: cycles = [], isLoading } = useCycles(isStaff)
  const { data: mine = [] } = useMyPayslips()

  const tabs: [Tab, string][] = [...(isStaff ? [['cycles', 'Payroll cycles'] as [Tab, string]] : []), ['mine', 'My payslips']]

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 500, margin: 0 }}>Payroll</h2>
          <p style={{ fontSize: 13, color: '#8c8c88', marginTop: 2 }}>{isStaff ? 'Run and review payroll cycles' : 'Your payslips'}</p>
        </div>
        {isStaff && canCreate && tab === 'cycles' && (
          <button onClick={() => setShowCreate(true)} style={{ padding: '9px 18px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>+ New cycle</button>
        )}
      </div>

      <div style={{ display: 'flex', borderBottom: '0.5px solid #e2e0da', marginBottom: 20 }}>
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: '10px 18px', background: 'none', border: 'none', fontSize: 13, cursor: 'pointer', color: tab === k ? '#534AB7' : '#5c5c58', fontWeight: tab === k ? 500 : 400, borderBottom: `2px solid ${tab === k ? '#534AB7' : 'transparent'}`, marginBottom: -0.5 }}>{label}</button>
        ))}
      </div>

      {tab === 'cycles' && isStaff && (
        <div style={{ backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: 10, overflow: 'hidden' }}>
          {isLoading ? <div style={{ padding: 30, color: '#8c8c88', fontSize: 13 }}>Loading...</div> : cycles.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#8c8c88', fontSize: 13 }}>No payroll cycles yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Pay period', 'Type', 'Payslips', 'Status', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {cycles.map((c: any) => (
                  <tr key={c.id} onClick={() => navigate(`/payroll/cycles/${c.id}`)} style={{ borderBottom: '0.5px solid #f5f4f0', cursor: 'pointer' }}>
                    <td style={td}><strong>{fmtPeriod(c.payPeriodStart, c.payPeriodEnd)}</strong></td>
                    <td style={td}>{c.cycleType}</td>
                    <td style={td}>{c._count?.payslips ?? 0}</td>
                    <td style={td}><Badge label={c.status} /></td>
                    <td style={{ ...td, color: '#534AB7', fontSize: 12 }}>Open →</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'mine' && (
        <div style={{ backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: 10, overflow: 'hidden' }}>
          {mine.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#8c8c88', fontSize: 13 }}>No payslips released yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Pay period', 'Gross', 'Deductions', 'Net pay', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {mine.map((p: any) => (
                  <tr key={p.id} onClick={() => navigate(`/payroll/payslips/${p.id}`)} style={{ borderBottom: '0.5px solid #f5f4f0', cursor: 'pointer' }}>
                    <td style={td}><strong>{fmtPeriod(p.payrollCycle.payPeriodStart, p.payrollCycle.payPeriodEnd)}</strong></td>
                    <td style={td}>{money(p.grossEarnings, p.currency)}</td>
                    <td style={td}>{money(p.totalDeductions, p.currency)}</td>
                    <td style={{ ...td, fontWeight: 500 }}>{money(p.netPay, p.currency)}</td>
                    <td style={{ ...td, color: '#534AB7', fontSize: 12, whiteSpace: 'nowrap' }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); downloadPayslipPdf(p.id).catch(() => setPdfError('Could not generate the PDF. Please try again.')) }}
                        style={{ padding: '4px 10px', backgroundColor: '#f0effe', color: '#534AB7', border: '0.5px solid #d9d6f5', borderRadius: 4, fontSize: 12, cursor: 'pointer', marginRight: 10 }}
                      >PDF</button>
                      View →
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {pdfError && tab === 'mine' && <div style={{ marginTop: 12, backgroundColor: '#faece7', color: '#993C1D', borderRadius: 6, padding: '10px 12px', fontSize: 13 }}>{pdfError}</div>}

      <CreateCycleModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={(id) => navigate(`/payroll/cycles/${id}`)} />
    </div>
  )
}
const th: React.CSSProperties = { padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, color: '#8c8c88', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '0.5px solid #e2e0da', backgroundColor: '#f9f8f6' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: 13, color: '#1a1a18' }

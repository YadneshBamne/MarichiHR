import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePayslip, downloadPayslipPdf } from '../../lib/hooks/usePayroll'
import Badge from '../../components/ui/Badge'
import { money, fmtPeriod } from '../../lib/format'

const GROUPS: { title: string; cats: string[]; sign: string; muted?: boolean }[] = [
  { title: 'Earnings', cats: ['BASIC', 'ALW'], sign: '' },
  { title: 'Deductions', cats: ['DED'], sign: '−' },
  { title: 'Tax', cats: ['TAX'], sign: '−' },
  { title: 'Reimbursements (not taxed)', cats: ['REIMB'], sign: '+' },
  { title: 'Employer contributions (not deducted from your pay)', cats: ['EMP_CONTRIB'], sign: '', muted: true },
]

export default function PayslipPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: p, isLoading, isError } = usePayslip(id!)
  const [downloading, setDownloading] = useState(false)
  const [dlError, setDlError] = useState('')

  const onDownload = async () => {
    setDlError('')
    setDownloading(true)
    try {
      await downloadPayslipPdf(id!)
    } catch {
      setDlError('Could not generate the PDF. Please try again.')
    } finally {
      setDownloading(false)
    }
  }

  if (isLoading) return <div style={{ color: '#8c8c88', fontSize: 13 }}>Loading payslip...</div>
  if (isError || !p) return <div style={{ color: '#993C1D', fontSize: 13 }}>Payslip not found.</div>

  const cur = p.currency
  const lines = p.lines || []
  const reimbursements = lines.filter((l: any) => l.category === 'REIMB').reduce((s: number, l: any) => s + l.amount, 0)

  return (
    <div style={{ maxWidth: 780 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: '#5c5c58', fontSize: 13, cursor: 'pointer', padding: 0 }}>← Back</button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => window.print()} style={{ padding: '7px 16px', backgroundColor: '#f5f4f0', border: '0.5px solid #e2e0da', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}>Print</button>
          <button onClick={onDownload} disabled={downloading} style={{ padding: '7px 16px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: downloading ? 0.7 : 1 }}>{downloading ? 'Preparing...' : 'Download PDF'}</button>
        </div>
      </div>
      {dlError && <div style={{ backgroundColor: '#faece7', color: '#993C1D', borderRadius: 6, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>{dlError}</div>}

      <div style={{ backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: 12, padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 11, color: '#8c8c88', textTransform: 'uppercase', letterSpacing: '.04em' }}>Payslip</div>
            <div style={{ fontSize: 20, fontWeight: 500, marginTop: 2 }}>{p.employee.firstName} {p.employee.lastName}</div>
            <div style={{ fontSize: 12, color: '#5c5c58', marginTop: 2 }}>{p.employee.employeeCode}{p.employee.bankName ? ` · ${p.employee.bankName}` : ''}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{fmtPeriod(p.payrollCycle.payPeriodStart, p.payrollCycle.payPeriodEnd)}</div>
            <div style={{ marginTop: 6 }}><Badge label={p.status} /></div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: '14px 0', borderTop: '0.5px solid #e2e0da', borderBottom: '0.5px solid #e2e0da', marginBottom: 20 }}>
          {[['Working days', p.workingDays], ['Paid days', p.paidDays], ['LWP days', p.lwpDays], ['Currency', cur]].map(([l, v]) => (
            <div key={String(l)}><div style={{ fontSize: 11, color: '#8c8c88' }}>{l}</div><div style={{ fontSize: 15, fontWeight: 500 }}>{v as any}</div></div>
          ))}
        </div>

        {GROUPS.map((g) => {
          const rows = lines.filter((l: any) => g.cats.includes(l.category))
          if (rows.length === 0) return null
          const total = rows.reduce((s: number, l: any) => s + l.amount, 0)
          return (
            <div key={g.title} style={{ marginBottom: 18, opacity: g.muted ? 0.65 : 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#534AB7', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{g.title}</div>
              {rows.map((l: any) => (
                <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, borderBottom: '0.5px solid #f5f4f0' }}>
                  <span>{l.name} {l.sourceRefType === 'payroll_input' && <span style={{ fontSize: 10, color: '#BA7517' }}>(manual)</span>}{l.sourceRefType === 'overtime_request' && <span style={{ fontSize: 10, color: '#185FA5' }}>(overtime)</span>}</span>
                  <span>{g.sign}{money(l.amount, cur)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: 13, fontWeight: 500 }}>
                <span>Total</span><span>{g.sign}{money(total, cur)}</span>
              </div>
            </div>
          )
        })}

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '10px 0', borderTop: '0.5px solid #e2e0da' }}>
          <span>Gross earnings</span><strong>{money(p.grossEarnings, cur)}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '10px 0' }}>
          <span>Total deductions (incl. tax)</span><strong>−{money(p.totalDeductions, cur)}</strong>
        </div>
        {reimbursements > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '10px 0' }}>
            <span>Reimbursements (not taxed)</span><strong>+{money(reimbursements, cur)}</strong>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#f0effe', borderRadius: 8, padding: '14px 16px', marginTop: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>Net pay</span>
          <span style={{ fontSize: 22, fontWeight: 600, color: '#534AB7' }}>{money(p.netPay, cur)}</span>
        </div>

        {p.workedDays?.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#8c8c88', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Worked days breakdown</div>
            {p.workedDays.map((w: any) => (
              <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#5c5c58', padding: '3px 0' }}>
                <span style={{ textTransform: 'capitalize' }}>{w.dayType.replace(/_/g, ' ')}</span>
                <span>{w.numberOfDays} days · {w.numberOfHours} h</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

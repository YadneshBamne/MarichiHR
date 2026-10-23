import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePayslip, downloadPayslipPdf } from '../../lib/hooks/usePayroll'
import Badge from '../../components/ui/Badge'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import { useToast } from '../../components/ui/Toast'
import { useQueryClient } from '@tanstack/react-query'
import { money, fmtPeriod, fmtHours } from '../../lib/format'

const GROUPS: { title: string; cats: string[]; sign: string; muted?: boolean }[] = [
  { title: 'Earnings', cats: ['BASIC', 'ALW'], sign: '' },
  { title: 'Deductions', cats: ['DED'], sign: '−' },
  { title: 'Tax', cats: ['TAX'], sign: '−' },
  { title: 'Reimbursements (not taxed)', cats: ['REIMB'], sign: '+' },
  { title: 'Employer contributions (not deducted from your pay)', cats: ['EMP_CONTRIB'], sign: '', muted: true },
]

// Salary-rule formulas in words for the payslip ("why this amount")
const WORDS: [RegExp, string][] = [
  [/^\s*result\s*=\s*/, ''], [/contract\.wageMonthly/g, 'monthly wage'], [/contract\.fullWageMonthly/g, 'full monthly wage'], [/contract\.ctcAnnual/g, 'annual CTC'],
  [/categories\.GROSS/g, 'gross pay'], [/categories\.BASIC/g, 'basic pay'], [/categories\.ALW/g, 'allowances'], [/categories\.(\w+)/g, '$1 total'],
  [/rules\.(\w+)/g, '$1'], [/inputs\.(\w+)/g, '$1 (input)'], [/payslip\.paidDays/g, 'paid days'], [/payslip\.workingDays/g, 'working days'], [/payslip\.factor/g, 'share of the month worked'],
  [/compute_zra_paye/g, 'ZRA PAYE bands on'], [/compute_india_tds/g, 'India TDS on'], [/napsa_(employee|employer)/g, 'NAPSA $1 share of'], [/nhima_(employee|employer)/g, 'NHIMA $1 share of'],
  [/\s\*\s/g, ' × '], [/ (of|on)\(([^()]*)\)/g, ' $1 $2'],
]
const inWords = (f: string) => WORDS.reduce((t, [re, w]) => t.replace(re, w), f)

export default function PayslipPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: p, isLoading, isError } = usePayslip(id!)
  const [downloading, setDownloading] = useState(false)
  const [dlError, setDlError] = useState('')
  const { hasRole } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  // Payroll asks for a tax override while the run is in review; a Compliance officer signs it off
  const askOverride = async (l: any) => {
    const v = window.prompt(`New amount for ${l.name} (now ${l.amount})`)
    if (v == null || v.trim() === '' || !(Number(v) >= 0)) return
    const reason = window.prompt('Why? (at least 10 characters; the Compliance officer sees this)')
    if (!reason || reason.trim().length < 10) { if (reason != null) toast('Give a reason of at least 10 characters', 'error'); return }
    try {
      const r = await api.post('/tax/overrides', { cycleId: p.payrollCycleId, employeeId: p.employeeId, lineCode: l.code, amount: Number(v), reason: reason.trim() })
      toast(r.data.data.complianceOfficers ? 'Sent to Compliance for sign-off' : 'Saved, but nobody has the Compliance officer role yet: give it to someone (Login & access) so they can sign off', r.data.data.complianceOfficers ? undefined : 'error')
      qc.invalidateQueries()
    } catch (e: any) { toast(e?.response?.data?.message || 'Could not send', 'error') }
  }

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

  if (isLoading) return <div style={{ color: 'var(--faint)', fontSize: 13 }}>Loading payslip...</div>
  if (isError || !p) return <div style={{ color: 'var(--danger)', fontSize: 13 }}>Payslip not found.</div>

  const cur = p.currency
  const lines = p.lines || []
  const reimbursements = lines.filter((l: any) => l.category === 'REIMB').reduce((s: number, l: any) => s + l.amount, 0)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: 'var(--dim)', fontSize: 13, cursor: 'pointer', padding: 0 }}>← Back</button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => window.print()} style={{ padding: '7px 16px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 13, cursor: 'pointer' }}>Print</button>
          <button onClick={onDownload} disabled={downloading} style={{ padding: '7px 16px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: downloading ? 0.7 : 1 }}>{downloading ? 'Preparing...' : 'Download PDF'}</button>
        </div>
      </div>
      {dlError && <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>{dlError}</div>}

      <div style={{ backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--faint)' }}>Payslip</div>
            <div style={{ fontSize: 20, fontWeight: 500, marginTop: 2 }}>{p.employee.firstName} {p.employee.lastName}</div>
            <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 2 }}>{p.employee.employeeCode}{p.employee.bankName ? ` · ${p.employee.bankName}` : ''}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{fmtPeriod(p.payrollCycle.payPeriodStart, p.payrollCycle.payPeriodEnd)}</div>
            <div style={{ marginTop: 6 }}><Badge label={p.status} /></div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: '14px 0', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', marginBottom: 20 }}>
          {[['Working days', p.workingDays], ['Paid days', p.paidDays], ['LWP days', p.lwpDays], ['Currency', cur]].map(([l, v]) => (
            <div key={String(l)}><div style={{ fontSize: 11, color: 'var(--faint)' }}>{l}</div><div style={{ fontSize: 15, fontWeight: 500 }}>{v as any}</div></div>
          ))}
        </div>

        {GROUPS.map((g) => {
          const rows = lines.filter((l: any) => g.cats.includes(l.category))
          if (rows.length === 0) return null
          const total = rows.reduce((s: number, l: any) => s + l.amount, 0)
          return (
            <div key={g.title} style={{ marginBottom: 18, opacity: g.muted ? 0.65 : 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--brand)', marginBottom: 6 }}>{g.title}</div>
              {rows.map((l: any) => (
                <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, borderBottom: '1px solid var(--well)' }}>
                  <span>{l.name} {l.sourceRefType === 'payroll_input' && <span style={{ fontSize: 10, color: 'var(--warn)' }}>(manual)</span>}{l.sourceRefType === 'overtime_request' && <span style={{ fontSize: 10, color: 'var(--info)' }}>(overtime)</span>}
                    {(l.formulaUsed || l.statutoryRef) && <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)', overflowWrap: 'anywhere' }}>How: {[l.formulaUsed && inWords(l.formulaUsed), l.statutoryRef && `rates: ${l.statutoryRef}`].filter(Boolean).join(' · ')}</span>}</span>
                  <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>{l.category === 'TAX' && p.status === 'draft' && hasRole('payroll_admin') && <button className="btn btn-ghost btn-sm" style={{ height: 24, fontSize: 11 }} onClick={() => askOverride(l)}>Override</button>}{g.sign}{money(l.amount, cur)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: 13, fontWeight: 500 }}>
                <span>Total</span><span>{g.sign}{money(total, cur)}</span>
              </div>
            </div>
          )
        })}

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '10px 0', borderTop: '1px solid var(--line)' }}>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'var(--honey-soft)', borderRadius: 14, padding: '14px 16px', marginTop: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>Net pay</span>
          <span style={{ fontSize: 22, fontWeight: 600, color: 'var(--brand)' }}>{money(p.netPay, cur)}</span>
        </div>

        {p.workedDays?.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--faint)', marginBottom: 6 }}>Worked days breakdown</div>
            {p.workedDays.map((w: any) => (
              <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--dim)', padding: '3px 0' }}>
                <span style={{ textTransform: 'capitalize' }}>{w.dayType.replace(/_/g, ' ')}</span>
                <span>{w.numberOfDays} days · {fmtHours(Number(w.numberOfHours))}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

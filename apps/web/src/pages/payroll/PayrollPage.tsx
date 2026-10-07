import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useCycles, useMyPayslips, downloadPayslipPdf } from '../../lib/hooks/usePayroll'
import { useReveal, useRowsIn, useCountUp } from '../../lib/motion'
import { useToast } from '../../components/ui/Toast'
import PageHeader, { EmptyState } from '../../components/ui/PageHeader'
import Badge from '../../components/ui/Badge'
import Icon from '../../components/ui/Icon'
import CreateCycleModal from './CreateCycleModal'
import { usePageLabel } from '../../lib/hooks/usePageLabel'
import { money, fmtPeriod } from '../../lib/format'

type Tab = 'cycles' | 'mine'
// The maker-checker path every cycle walks
const STAGES = ['draft', 'processing', 'review', 'approved', 'finance_approved', 'disbursed'] as const
const STAGE_LABEL: Record<string, string> = { draft: 'Draft', processing: 'Calculating', review: 'HR review', approved: 'HR approved', finance_approved: 'Finance approved', disbursed: 'Disbursed' }

export default function PayrollPage() {
  const pageTitle = usePageLabel('/payroll')
  const { hasRole } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const isStaff = hasRole('hr_admin') || hasRole('payroll_admin') || hasRole('compliance_officer')
  const canCreate = hasRole('hr_admin') || hasRole('payroll_admin')
  const [tab, setTab] = useState<Tab>(isStaff ? 'cycles' : 'mine')
  const [showCreate, setShowCreate] = useState(false)
  const { data: cycles = [], isLoading } = useCycles(isStaff)
  const { data: mine = [], isLoading: mineLoading } = useMyPayslips()
  const ref = useReveal<HTMLDivElement>(tab)
  const rows = useRowsIn<HTMLTableSectionElement>(`${tab}|${cycles.length}|${mine.length}`)

  const open = cycles.filter((c: any) => c.status !== 'disbursed')
  const focus = open[open.length - 1] ?? cycles[0] // the oldest cycle still in flight, else the latest
  const stageIdx = focus ? STAGES.indexOf(focus.status) : -1
  const awaiting = cycles.filter((c: any) => ['review', 'approved', 'finance_approved'].includes(c.status)).length
  const disbursed = cycles.filter((c: any) => c.status === 'disbursed').length
  const latestMine = mine[0]

  const tabs: [Tab, string][] = [...(isStaff ? [['cycles', 'Payroll cycles'] as [Tab, string]] : []), ['mine', 'My payslips']]
  const pdf = (id: string) => downloadPayslipPdf(id).catch(() => toast('Could not generate the PDF. Please try again.', 'error'))

  return (
    <div ref={ref}>
      <PageHeader
        title={pageTitle}
        sub={isStaff ? 'Calculate, approve and pay, with HR and finance sign-off on every cycle.' : 'Your payslips and pay history.'}
        actions={isStaff && canCreate ? <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Icon name="plus" size={16} /> New cycle</button> : undefined}
      >
        <div className="chips">
          {tabs.map(([k, label]) => <button key={k} onClick={() => setTab(k)} className={`chip${tab === k ? ' is-on' : ''}`}>{label}</button>)}
        </div>
      </PageHeader>

      {tab === 'cycles' && isStaff && focus && (
        <div className="pay-top">
          <section data-card className="card" style={{ padding: 22, cursor: 'pointer' }} onClick={() => navigate(`/payroll/cycles/${focus.id}`)}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span className="display" style={{ fontSize: 30 }}>{fmtPeriod(focus.payPeriodStart, focus.payPeriodEnd)}</span>
              <Badge label={focus.status} />
              <span className="dim" style={{ marginLeft: 'auto', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>{focus._count?.payslips ?? 0} payslips <Icon name="arrowUpRight" size={15} /></span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${STAGES.length}, minmax(0, 1fr))`, gap: 6, marginTop: 18 }} role="img" aria-label={`Stage ${stageIdx + 1} of ${STAGES.length}: ${STAGE_LABEL[focus.status] ?? focus.status}`}>
              {STAGES.map((st, i) => (
                <div key={st}>
                  <div className={`seg ${i < stageIdx ? 'night' : i === stageIdx ? 'honey' : 'outline'}`} style={{ height: 30, padding: '0 10px', fontSize: 11 }}>{i < stageIdx ? <Icon name="check" size={13} stroke={2.2} /> : i + 1}</div>
                  <div className={i <= stageIdx ? '' : 'muted'} style={{ fontSize: 11, marginTop: 6 }}>{STAGE_LABEL[st]}</div>
                </div>
              ))}
            </div>
          </section>
          <section data-card className="card pay-nums" style={{ padding: 22 }}>
            <Num value={cycles.length} label="Cycles" />
            <Num value={awaiting} label="Awaiting sign-off" />
            <Num value={disbursed} label="Disbursed" />
          </section>
        </div>
      )}

      {tab === 'cycles' && isStaff && (
        <section data-card className="card" style={{ padding: '6px 10px', marginTop: 'var(--gap)', overflowX: 'auto' }}>
          {isLoading ? <div style={{ padding: 14 }}>{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 38, marginBottom: 10 }} />)}</div> : cycles.length === 0 ? (
            <EmptyState icon={<Icon name="wallet" size={24} />} title="No payroll cycles yet" body="Create a cycle for a pay period, lock attendance, then run the calculation." action={canCreate ? <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Icon name="plus" size={16} /> New cycle</button> : undefined} />
          ) : (
            <table className="tbl" style={{ minWidth: 640 }}>
              <thead><tr><th>Pay period</th><th>Type</th><th>Payslips</th><th>Status</th><th /></tr></thead>
              <tbody ref={rows}>
                {cycles.map((c: any) => (
                  <tr key={c.id} data-row onClick={() => navigate(`/payroll/cycles/${c.id}`)} style={{ cursor: 'pointer' }}>
                    <td style={{ fontWeight: 500 }}>{fmtPeriod(c.payPeriodStart, c.payPeriodEnd)}</td>
                    <td style={{ textTransform: 'capitalize' }}>{c.cycleType}</td>
                    <td className="num">{c._count?.payslips ?? 0}</td>
                    <td><Badge label={c.status} /></td>
                    <td style={{ textAlign: 'right' }}><Icon name="chevronRight" size={16} className="muted" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'mine' && (
        <>
          {latestMine && (
            <section data-card className="card" style={{ padding: 22, marginBottom: 'var(--gap)', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', background: 'linear-gradient(120deg, var(--honey-2), var(--app-3))' }}>
              <div>
                <div className="dim" style={{ fontSize: 12 }}>Latest net pay · {fmtPeriod(latestMine.payrollCycle.payPeriodStart, latestMine.payrollCycle.payPeriodEnd)}</div>
                <div className="display num" style={{ fontSize: 46, lineHeight: 1.1 }}>{money(latestMine.netPay, latestMine.currency)}</div>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" onClick={() => pdf(latestMine.id)}><Icon name="download" size={15} /> PDF</button>
                <button className="btn btn-primary" onClick={() => navigate(`/payroll/payslips/${latestMine.id}`)}>View payslip <Icon name="arrowRight" size={15} /></button>
              </div>
            </section>
          )}
          <section data-card className="card" style={{ padding: '6px 10px', overflowX: 'auto' }}>
            {mineLoading ? <div style={{ padding: 14 }}>{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 38, marginBottom: 10 }} />)}</div> : mine.length === 0 ? (
              <EmptyState icon={<Icon name="file" size={24} />} title="No payslips yet" body="Your payslips appear here once a payroll cycle that includes you has been paid." />
            ) : (
              <table className="tbl" style={{ minWidth: 640 }}>
                <thead><tr><th>Pay period</th><th>Gross</th><th>Deductions</th><th>Net pay</th><th /></tr></thead>
                <tbody ref={rows}>
                  {mine.map((p: any) => (
                    <tr key={p.id} data-row onClick={() => navigate(`/payroll/payslips/${p.id}`)} style={{ cursor: 'pointer' }}>
                      <td style={{ fontWeight: 500 }}>{fmtPeriod(p.payrollCycle.payPeriodStart, p.payrollCycle.payPeriodEnd)}</td>
                      <td className="num">{money(p.grossEarnings, p.currency)}</td>
                      <td className="num">{money(p.totalDeductions, p.currency)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{money(p.netPay, p.currency)}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); pdf(p.id) }}><Icon name="download" size={13} /> PDF</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      <CreateCycleModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={(id) => navigate(`/payroll/cycles/${id}`)} />
    </div>
  )
}

function Num({ value, label }: { value: number; label: string }) {
  const n = useCountUp(value)
  return (
    <div>
      <div className="display num" style={{ fontSize: 44, lineHeight: 1 }}><span ref={n}>0</span></div>
      <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{label}</div>
    </div>
  )
}

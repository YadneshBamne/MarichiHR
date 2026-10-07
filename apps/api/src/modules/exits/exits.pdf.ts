import { escapeHtml as e, money, fmtDate } from '../payroll/payslip.pdf'

const SECTIONS: { key: string; title: string }[] = [
  { key: 'salary', title: 'Final month salary (prorated to last working day)' },
  { key: 'encashment', title: 'Leave encashment' },
  { key: 'notice', title: 'Notice period' },
  { key: 'reimbursement', title: 'Approved reimbursements (not taxed)' },
  { key: 'recovery', title: 'Recoveries' },
  { key: 'gratuity', title: 'Gratuity' },
]

export function renderSettlementHtml(exit: any, tenantName: string): string {
  const cur: string = exit.currency || 'USD'
  const lines: any[] = exit.lines || []
  const emp = exit.employee || {}

  const sectionsHtml = SECTIONS.map((s) => {
    const rows = lines.filter((l) => l.section === s.key)
    if (!rows.length) return ''
    const body = rows.map((l) => `<tr><td>${e(l.name)}${l.formula ? `<div class="f">${e(l.formula)}</div>` : ''}</td><td class="amt">${l.kind === 'deduction' ? '−' : ''}${e(money(l.amount, cur))}</td></tr>`).join('')
    return `<div class="group"><h3>${e(s.title)}</h3><table>${body}</table></div>`
  }).join('')

  const net = Number(exit.netPayable ?? 0)
  const warnings: string[] = exit.warnings || []

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Final settlement</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a18; font-size: 12px; margin: 0; }
  .head { display: flex; justify-content: space-between; border-bottom: 2px solid #534AB7; padding-bottom: 12px; margin-bottom: 14px; }
  .tenant { font-size: 18px; font-weight: bold; color: #534AB7; }
  .label { font-size: 10px; color: #8c8c88; text-transform: uppercase; letter-spacing: .04em; }
  .big { font-size: 15px; font-weight: bold; margin-top: 2px; }
  .right { text-align: right; }
  .summary { display: flex; gap: 12px; padding: 10px 0; border-top: 1px solid #e2e0da; border-bottom: 1px solid #e2e0da; margin-bottom: 16px; }
  .summary div { flex: 1; }
  .group { margin-bottom: 14px; }
  .group h3 { font-size: 11px; color: #534AB7; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 4px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 0; border-bottom: 1px solid #f0efea; vertical-align: top; }
  td.amt { text-align: right; white-space: nowrap; }
  .f { font-size: 10px; color: #8c8c88; }
  .line { display: flex; justify-content: space-between; padding: 7px 0; font-size: 13px; }
  .net { display: flex; justify-content: space-between; align-items: center; background: #f0effe; border-radius: 6px; padding: 12px 14px; margin-top: 6px; }
  .net .v { font-size: 20px; font-weight: bold; color: #534AB7; }
  .notes { margin-top: 16px; font-size: 10px; color: #8c8c88; }
  .foot { margin-top: 28px; font-size: 10px; color: #8c8c88; border-top: 1px solid #e2e0da; padding-top: 8px; }
</style></head><body>
  <div class="head">
    <div>
      <div class="tenant">${e(tenantName)}</div>
      <div class="label" style="margin-top:6px">Full &amp; final settlement</div>
      <div class="big">${e(emp.firstName)} ${e(emp.lastName)}</div>
      <div>${e(emp.employeeCode)}</div>
    </div>
    <div class="right">
      <div class="label">Last working day</div>
      <div class="big">${e(fmtDate(exit.lastWorkingDate))}</div>
      <div style="text-transform:capitalize">${e(exit.exitType)}</div>
    </div>
  </div>
  <div class="summary">
    <div><div class="label">Notice given</div><div class="big">${e(fmtDate(exit.noticeDate))}</div></div>
    <div><div class="label">Notice period</div><div class="big">${e(exit.noticePeriodDays)} days</div></div>
    <div><div class="label">Served</div><div class="big">${e(exit.noticeServedDays)} days</div></div>
    <div><div class="label">Shortfall</div><div class="big">${e(exit.shortfallDays)} days</div></div>
  </div>
  ${sectionsHtml}
  <div class="line"><span>Total earnings</span><strong>${e(money(exit.totalEarnings, cur))}</strong></div>
  <div class="line"><span>Total deductions and recoveries</span><strong>−${e(money(exit.totalDeductions, cur))}</strong></div>
  <div class="net"><span><strong>${net < 0 ? 'RECOVERABLE FROM EMPLOYEE' : 'NET PAYABLE'}</strong></span><span class="v">${e(money(Math.abs(net), cur))}</span></div>
  ${warnings.length ? `<div class="notes">${warnings.map((w) => `<div>• ${e(w)}</div>`).join('')}</div>` : ''}
  <div class="foot">Generated on ${e(fmtDate(new Date()))}. Status: ${e(exit.status)}.</div>
</body></html>`
}

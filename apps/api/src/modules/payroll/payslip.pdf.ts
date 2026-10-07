import puppeteer, { Browser } from 'puppeteer'

export function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function money(amount: unknown, currency: string): string {
  const n = Number(amount ?? 0)
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

export function fmtDate(d: unknown): string {
  return new Date(d as any).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

const GROUPS: { title: string; cats: string[]; sign: string; muted?: boolean }[] = [
  { title: 'Earnings', cats: ['BASIC', 'ALW'], sign: '' },
  { title: 'Deductions', cats: ['DED'], sign: '−' },
  { title: 'Tax', cats: ['TAX'], sign: '−' },
  { title: 'Reimbursements (not taxed)', cats: ['REIMB'], sign: '+' },
  { title: 'Employer contributions (not deducted from your pay)', cats: ['EMP_CONTRIB'], sign: '', muted: true },
]

export function renderPayslipHtml(payslip: any, tenantName: string): string {
  const cur: string = payslip.currency || 'USD'
  const lines: any[] = payslip.lines || []
  const emp = payslip.employee || {}
  const cycle = payslip.payrollCycle || {}

  const reimbursements = lines.filter((l) => l.category === 'REIMB').reduce((s, l) => s + Number(l.amount || 0), 0)

  const groupsHtml = GROUPS.map((g) => {
    const rows = lines.filter((l) => g.cats.includes(l.category))
    if (rows.length === 0) return ''
    const total = rows.reduce((s, l) => s + Number(l.amount || 0), 0)
    const rowsHtml = rows
      .map((l) => {
        const tag = l.sourceRefType === 'payroll_input' ? ' (manual)' : l.sourceRefType === 'overtime_request' ? ' (overtime)' : ''
        return `<tr><td>${escapeHtml(l.name)}${escapeHtml(tag)}</td><td class="amt">${escapeHtml(g.sign)}${escapeHtml(money(l.amount, cur))}</td></tr>`
      })
      .join('')
    return `<div class="group${g.muted ? ' muted' : ''}">
      <h3>${escapeHtml(g.title)}</h3>
      <table>${rowsHtml}<tr class="total"><td>Total</td><td class="amt">${escapeHtml(g.sign)}${escapeHtml(money(total, cur))}</td></tr></table>
    </div>`
  }).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Payslip</title>
<style>
  * { box-sizing: border-box; }
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
  .group.muted, .group.muted h3 { color: #8c8c88; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 0; border-bottom: 1px solid #f0efea; }
  td.amt { text-align: right; white-space: nowrap; }
  tr.total td { font-weight: bold; border-bottom: none; padding-top: 7px; }
  .line { display: flex; justify-content: space-between; padding: 7px 0; font-size: 13px; }
  .net { display: flex; justify-content: space-between; align-items: center; background: #f0effe; border-radius: 6px; padding: 12px 14px; margin-top: 6px; }
  .net .v { font-size: 20px; font-weight: bold; color: #534AB7; }
  .foot { margin-top: 28px; font-size: 10px; color: #8c8c88; border-top: 1px solid #e2e0da; padding-top: 8px; }
</style></head><body>
  <div class="head">
    <div>
      <div class="tenant">${escapeHtml(tenantName)}</div>
      <div class="label" style="margin-top:6px">Payslip</div>
      <div class="big">${escapeHtml(emp.firstName)} ${escapeHtml(emp.lastName)}</div>
      <div>${escapeHtml(emp.employeeCode)}</div>
    </div>
    <div class="right">
      <div class="label">Pay period</div>
      <div class="big">${escapeHtml(fmtDate(cycle.payPeriodStart))} – ${escapeHtml(fmtDate(cycle.payPeriodEnd))}</div>
    </div>
  </div>
  <div class="summary">
    <div><div class="label">Working days</div><div class="big">${escapeHtml(payslip.workingDays)}</div></div>
    <div><div class="label">Paid days</div><div class="big">${escapeHtml(payslip.paidDays)}</div></div>
    <div><div class="label">LWP days</div><div class="big">${escapeHtml(payslip.lwpDays)}</div></div>
    <div><div class="label">Currency</div><div class="big">${escapeHtml(cur)}</div></div>
  </div>
  ${groupsHtml}
  <div class="line"><span>Gross earnings</span><strong>${escapeHtml(money(payslip.grossEarnings, cur))}</strong></div>
  <div class="line"><span>Total deductions (incl. tax)</span><strong>−${escapeHtml(money(payslip.totalDeductions, cur))}</strong></div>
  ${reimbursements > 0 ? `<div class="line"><span>Reimbursements (not taxed)</span><strong>+${escapeHtml(money(reimbursements, cur))}</strong></div>` : ''}
  <div class="net"><span><strong>NET PAY</strong></span><span class="v">${escapeHtml(money(payslip.netPay, cur))}</span></div>
  <div class="foot">Generated on ${escapeHtml(fmtDate(new Date()))}. This is a system-generated payslip. Status: ${escapeHtml(payslip.status)}</div>
</body></html>`
}

let browserPromise: Promise<Browser> | null = null

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    console.log('[pdf] launching shared Chrome browser')
    browserPromise = puppeteer
      .launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
      .then((b) => {
        b.on('disconnected', () => { browserPromise = null })
        return b
      })
      .catch((err) => {
        browserPromise = null
        throw err
      })
  }
  return browserPromise
}

export async function generatePayslipPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      const url = req.url()
      if (url.startsWith('data:') || url.startsWith('about:')) req.continue()
      else req.abort()
    })
    await page.setContent(html, { waitUntil: 'load' })
    const result = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    })
    return Buffer.from(result)
  } finally {
    await page.close().catch(() => undefined)
  }
}

export async function closePdfBrowser(): Promise<void> {
  if (!browserPromise) return
  const p = browserPromise
  browserPromise = null
  try {
    await (await p).close()
  } catch {
    // already closed
  }
}

import { escapeHtml as e, money, fmtDate } from '../payroll/payslip.pdf'

// Annual tax certificate (Form 16 style summary): employer, employee, period, month-by-month pay and tax, totals and
// the verified declarations. Printed from finalised payroll only.
export function certificateHtml(d: any, decl: any | null): string {
  const cur = d.months[0]?.currency ?? 'ZMW'
  const cols = d.columns as { code: string; name: string }[]
  const row = (m: any) => `<tr><td>${e(m.month)}</td><td class="n">${money(m.gross, cur)}</td>${cols.map((c) => `<td class="n">${money(m[c.code] ?? 0, cur)}</td>`).join('')}<td class="n">${money(m.net, cur)}</td></tr>`
  const decls = decl?.items?.filter((i: any) => i.status === 'accepted') ?? []
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font-family:Inter,Arial,sans-serif;color:#252523;font-size:11px;margin:32px}
  h1{font-size:20px;margin:0 0 4px} .dim{color:#77746c} table{width:100%;border-collapse:collapse;margin-top:12px}
  th,td{border-bottom:1px solid #e7e3da;padding:6px 4px;text-align:left} th{font-size:10px;text-transform:uppercase;color:#77746c}
  .n{text-align:right;font-variant-numeric:tabular-nums} .tot td{font-weight:700;border-top:2px solid #252523}
  .grid{display:flex;gap:24px;margin-top:12px} .box{flex:1;border:1px solid #e7e3da;border-radius:8px;padding:10px}
  .sign{margin-top:40px;display:flex;justify-content:space-between} .line{border-top:1px solid #252523;width:220px;padding-top:4px}
  </style></head><body>
  <h1>Annual tax deduction certificate</h1>
  <div class="dim">Period ${fmtDate(d.period.from)} to ${fmtDate(d.period.to)} · issued ${fmtDate(d.generatedAt)}</div>
  <div class="grid">
    <div class="box"><div class="dim">Employer</div><strong>${e(d.employer)}</strong></div>
    <div class="box"><div class="dim">Employee</div><strong>${e(d.employee?.firstName)} ${e(d.employee?.lastName)}</strong><div>${e(d.employee?.employeeCode)}${d.employee?.taxJurisdiction ? ` · ${e(d.employee.taxJurisdiction)}` : ''}</div></div>
  </div>
  <table><thead><tr><th>Month</th><th class="n">Gross pay</th>${cols.map((c) => `<th class="n">${e(c.name)}</th>`).join('')}<th class="n">Net pay</th></tr></thead>
  <tbody>${d.months.map(row).join('')}
  <tr class="tot"><td>Total</td><td class="n">${money(d.totals.gross, cur)}</td>${cols.map((c) => `<td class="n">${money(d.totals[c.code] ?? 0, cur)}</td>`).join('')}<td class="n">${money(d.totals.net, cur)}</td></tr></tbody></table>
  ${decls.length ? `<h3 style="margin-top:18px">Verified declarations</h3><table><thead><tr><th>Section</th><th>Details</th><th class="n">Verified</th><th>Used in tax</th></tr></thead><tbody>${decls.map((i: any) => `<tr><td>${e(i.sectionLabel)}</td><td>${e(i.description)}</td><td class="n">${money(i.verifiedAmount, cur)}</td><td>${i.appliesToTax ? 'Yes' : 'No (not allowed under the regime computed)'}</td></tr>`).join('')}</tbody></table>` : ''}
  <p class="dim" style="margin-top:16px">Amounts come from finalised payroll runs. Tax was deducted and paid over by the employer as shown.</p>
  <div class="sign"><div class="line">For the employer</div><div class="line">Date</div></div>
  </body></html>`
}

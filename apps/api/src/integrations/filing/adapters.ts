// Statutory filing adapters. One interface for every authority; each adapter checks and packages a return, then
// either answers in sandbox mode (no network, a sample acknowledgement) or sends it through the provider in live
// mode. Live mode needs the provider's keys in the environment; nothing else changes when they arrive.
//
//   FILING_MODE=sandbox (default) | live
//   WhiteBooks (India TDS / GST):         WHITEBOOKS_BASE_URL, WHITEBOOKS_CLIENT_ID, WHITEBOOKS_CLIENT_SECRET
//   ZRA, KRA and NRS PAYE, NAPSA, NHIMA, NSSF, SHIF, PenCom and EPFO are filed on the authority's portal and the
//   reference is recorded by hand. DigiTax (integrations/digitax.ts) is ZRA Smart Invoice only: its documented API
//   (zm.docs.digitax.tech) has no PAYE or payroll return endpoint.

export interface ReturnRow { employeeCode: string; name: string; taxId?: string | null; gross: number; amount: number }
export interface FilingReturn {
  authority: string
  period: { from: string; to: string }
  employer: { name: string; taxId?: string | null; country: string | null }
  currency: string
  rows: ReturnRow[]
  total: number
}
export interface SubmitResult { reference: string; status: 'submitted' | 'accepted' | 'rejected'; raw: unknown }
export interface FilingAdapter {
  authority: string
  label: string
  provider: 'WhiteBooks' | null // null = filed by hand on the authority's portal
  codes: string[] // payslip line codes this return carries
  keys: string[] // environment variables live mode needs
  validate(r: FilingReturn): string[]
  submit(r: FilingReturn, mode: 'sandbox' | 'live'): Promise<SubmitResult>
}

const basicChecks = (r: FilingReturn) => [
  ...(!r.rows.length ? ['There is nothing to file for this period'] : []),
  ...(r.rows.some((x) => !(x.amount >= 0)) ? ['Some amounts are negative'] : []),
]
const sandboxRef = (authority: string) => `SANDBOX-${authority.replace(/\W+/g, '').toUpperCase()}-${Date.now().toString(36).toUpperCase()}`

// ponytail: the live request body follows our packaged return; map it to the provider's exact schema when their API
// documentation arrives (one function per provider below), the rest of the flow stays as it is.
async function post(url: string, headers: Record<string, string>, body: unknown): Promise<SubmitResult> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const raw = await res.json().catch(() => ({}))
  if (!res.ok) return { reference: '', status: 'rejected', raw }
  return { reference: String((raw as any).reference ?? (raw as any).acknowledgementNumber ?? (raw as any).id ?? ''), status: 'submitted', raw }
}

function provider(name: 'WhiteBooks', authority: string, label: string, codes: string[], extraChecks: (r: FilingReturn) => string[] = () => []): FilingAdapter {
  const keys = ['WHITEBOOKS_BASE_URL', 'WHITEBOOKS_CLIENT_ID', 'WHITEBOOKS_CLIENT_SECRET']
  return {
    authority, label, provider: name, codes, keys,
    validate: (r) => [...basicChecks(r), ...extraChecks(r)],
    async submit(r, mode) {
      if (mode === 'sandbox') return { reference: sandboxRef(authority), status: 'accepted', raw: { sandbox: true, rows: r.rows.length, total: r.total } }
      const missing = keys.filter((k) => !process.env[k])
      if (missing.length) throw new Error(`Live filing needs ${missing.join(', ')}`)
      return post(`${process.env.WHITEBOOKS_BASE_URL}/tds/returns`, { 'client-id': process.env.WHITEBOOKS_CLIENT_ID!, 'client-secret': process.env.WHITEBOOKS_CLIENT_SECRET! }, r)
    },
  }
}
function manual(authority: string, label: string, codes: string[], extraChecks: (r: FilingReturn) => string[] = () => []): FilingAdapter {
  return {
    authority, label, provider: null, codes, keys: [],
    validate: (r) => [...basicChecks(r), ...extraChecks(r)],
    async submit(_r, mode) {
      if (mode === 'sandbox') return { reference: sandboxRef(authority), status: 'accepted', raw: { sandbox: true } }
      throw new Error(`${authority} is filed on its own portal: record the reference by hand`)
    },
  }
}

const needTaxId = (r: FilingReturn) => (r.employer.taxId ? [] : ['Add the employer tax number (Company profile › Legal entities, or the company profile)'])
export const ADAPTERS: FilingAdapter[] = [
  manual('ZRA', 'Zambia PAYE (ZRA)', ['PAYE_ZM', 'WHT_ZM'], needTaxId),
  manual('NAPSA', 'Zambia NAPSA', ['NAPSA_EMP', 'NAPSA_EMPLOYER']),
  manual('NHIMA', 'Zambia NHIMA', ['NHIMA_EMP', 'NHIMA_EMPLOYER']),
  manual('KRA', 'Kenya PAYE and housing levy (KRA)', ['PAYE_KE', 'AHL_EMP', 'AHL_EMPLOYER'], needTaxId),
  manual('NSSF (KE)', 'Kenya NSSF', ['NSSF_EMP', 'NSSF_EMPLOYER']),
  manual('SHIF', 'Kenya SHIF', ['SHIF']),
  manual('NRS', 'Nigeria PAYE (NRS / State IRS)', ['PAYE_NG'], needTaxId),
  manual('PenCom', 'Nigeria pension (PenCom)', ['PENSION_EMP', 'PENSION_EMPLOYER']),
  provider('WhiteBooks', 'Income Tax Dept', 'India TDS on salary (Form 24Q)', ['TDS'], needTaxId),
  manual('EPFO', 'India provident fund (EPFO)', ['EPF_EMP', 'EPF_EMPLOYER']),
]
export const filingMode = (): 'sandbox' | 'live' => (process.env.FILING_MODE === 'live' ? 'live' : 'sandbox')
export const adapterFor = (authority: string) => ADAPTERS.find((a) => a.authority === authority)

if (require.main === module) {
  const r: FilingReturn = { authority: 'ZRA', period: { from: '2026-01-01', to: '2026-01-31' }, employer: { name: 'X', taxId: null, country: 'ZM' }, currency: 'ZMW', rows: [{ employeeCode: 'E1', name: 'A', gross: 10, amount: 1 }], total: 1 }
  console.assert(adapterFor('ZRA')!.validate(r).some((e) => /tax number/.test(e)), 'ZRA needs the employer tax number')
  console.assert(adapterFor('NAPSA')!.validate(r).length === 0, 'NAPSA has no tax-number check')
  adapterFor('ZRA')!.submit(r, 'sandbox').then((x) => { console.assert(x.reference.startsWith('SANDBOX-ZRA-') && x.status === 'accepted'); console.log('adapters ok') })
}

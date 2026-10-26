// DigiTax (Namiri Technologies), certified ZRA Smart Invoice middleware. Docs: https://zm.docs.digitax.tech
// One server for both modes; the API key decides: a key from a TEST business reaches ZRA's sandbox, a LIVE business
// key reaches production. Auth is the X-API-Key header. The API covers Smart Invoice only (businesses, items,
// customers, suppliers, imports, purchases, sales/credit/debit notes, stock, notices); it has no PAYE or payroll
// return endpoint, so PAYE is filed on ZRA's portal (see integrations/filing/adapters.ts).
//
//   DIGITAX_API_KEY   key from DigiTax › Integrations › Add API key
//   DIGITAX_BASE_URL  optional, default https://api.digitax.tech/zm/v1
//   DIGITAX_LIVE=true needed before a key that is not a ZMB_TEST_ key is used at all

const base = () => process.env.DIGITAX_BASE_URL || 'https://api.digitax.tech/zm/v1'

export function digitaxKey(): string | null {
  const k = process.env.DIGITAX_API_KEY
  if (!k) return null
  if (!k.startsWith('ZMB_TEST_') && process.env.DIGITAX_LIVE !== 'true') throw new Error('A live DigiTax key is set but DIGITAX_LIVE is not true; it stays unused')
  return k
}

export interface DigitaxStatus { configured: boolean; ok: boolean; test: boolean | null; branchOfficeId: string | null; error: string | null; checkedAt: string }
let cache: { at: number; v: DigitaxStatus } | null = null

// GET /info (Businesses › Get ZRA information on the business): read-only, proves the key and shows test or live
export async function digitaxStatus(fresh = false): Promise<DigitaxStatus> {
  if (!fresh && cache && Date.now() - cache.at < 10 * 60_000) return cache.v
  const v: DigitaxStatus = { configured: false, ok: false, test: null, branchOfficeId: null, error: null, checkedAt: new Date().toISOString() }
  try {
    const key = digitaxKey()
    if (key) {
      v.configured = true
      const res = await fetch(`${base()}/info`, { headers: { 'X-API-Key': key, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      const j: any = await res.json().catch(() => ({}))
      if (res.ok) Object.assign(v, { ok: true, test: !!j.is_test, branchOfficeId: j.branch_office_id ?? null })
      else v.error = `DigiTax answered ${res.status}${j.message ? `: ${String(j.message).slice(0, 120)}` : ''}`
    }
  } catch (e: any) { v.error = String(e?.message || e).slice(0, 160) }
  cache = { at: Date.now(), v }
  return v
}

if (require.main === module) {
  const keep = { ...process.env }
  process.env.DIGITAX_API_KEY = 'ZMB_LIVE_x'; delete process.env.DIGITAX_LIVE
  let threw = false; try { digitaxKey() } catch { threw = true }
  console.assert(threw, 'a live key stays unused without DIGITAX_LIVE=true')
  process.env.DIGITAX_API_KEY = 'ZMB_TEST_x'
  console.assert(digitaxKey() === 'ZMB_TEST_x', 'test keys are allowed')
  process.env = keep
  console.log('digitax ok')
}

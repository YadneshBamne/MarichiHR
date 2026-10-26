// DigiTax (Namiri Technologies), certified ZRA Smart Invoice middleware. Docs: https://zm.docs.digitax.tech
// One server for both modes; the API key decides: a key from a TEST business reaches ZRA's sandbox, a LIVE business
// key reaches production. Auth is the X-API-Key header. The API covers Smart Invoice only (businesses, items,
// customers, suppliers, imports, purchases, sales/credit/debit notes, stock, notices); it has no PAYE or payroll
// return endpoint, so PAYE is filed on ZRA's portal (see integrations/filing/adapters.ts).
//
//   DIGITAX_API_KEY   key from DigiTax › Integrations › Add API key
//   DIGITAX_BASE_URL  optional, default https://api.digitax.tech/zm/v1
//   DIGITAX_LIVE=true needed before a key that is not a ZMB_TEST_ key is used at all
//   DIGITAX_TENANT    slug of the one company this key belongs to (one key = one DigiTax business = one TPIN);
//                     other companies never send through it

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

export class DigitaxError extends Error { constructor(message: string, public status: number, public body: unknown) { super(message) } }

// The documented calls MarichiHR uses; the request and response shapes are DigiTax's (see the reference pages)
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const key = digitaxKey()
  if (!key) throw new DigitaxError('DigiTax is not set up (DIGITAX_API_KEY)', 0, null)
  const res = await fetch(`${base()}${path}`, { method, headers: { 'X-API-Key': key, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) })
  const j: any = await res.json().catch(() => null)
  if (!res.ok) {
    // Errors come as [{ type, errors: { issues: [{ path, message }] } }] (schema) or { message, metadata: { violations:
    // '{"fields":{"items.x":["value is required"]}}' } }
    let issue = Array.isArray(j) ? j.flatMap((x: any) => x?.errors?.issues ?? []).map((i: any) => `${(i.path ?? []).join('.')}: ${i.message ?? i.code}`).join('; ') : null
    try { const v = JSON.parse(j?.metadata?.violations ?? 'null')?.fields; if (v) issue = Object.entries(v).map(([f, m]) => `${f}: ${([] as string[]).concat(m as any).join(', ')}`).join('; ') } catch { /* plain message */ }
    throw new DigitaxError(`DigiTax answered ${res.status}: ${(issue || j?.message || 'error').slice(0, 300)}`, res.status, j)
  }
  return j as T
}

export interface DigitaxItem { id: string; item_name: string; item_code?: string; item_class_code?: string; default_unit_price?: number; status: 'PENDING' | 'FAILED' | 'COMPLETED' } // status against ZRA VSDC
export interface DigitaxPurchase { id: string; status: 'PENDING' | 'FAILED' | 'COMPLETED'; purchase_number?: string; invoice_number?: number }
export interface DigitaxNotice { notice_number: string; notice_date: string; title: string; content: string; by: string; detail_url?: string }
export interface PurchaseBody {
  purchase_date: string // YYYY-MM-DD
  supplier_tin?: string; supplier_name?: string; supplier_invoice_number?: number
  // package_unit_quantity is listed as optional in the schema but the API answers "value is required" without it
  items: { item_id: string; quantity: number; package_unit_quantity: number; unit_price: number; discount_rate: number; discount_amount: number; total_amount: number }[]
}

export const digitax = {
  items: () => call<{ data: DigitaxItem[] }>('GET', '/items').then((r) => r.data ?? []), // Items › Get list of items
  notices: () => call<DigitaxNotice[]>('GET', '/notices'), // Notices › Get list of ZRA notices for business
  addPurchase: (b: PurchaseBody) => call<DigitaxPurchase>('POST', '/purchases', b), // Purchases › Add manual purchase
  purchase: (id: string) => call<DigitaxPurchase>('GET', `/purchases/${encodeURIComponent(id)}`), // Purchases › Get specific purchase
}

// Is this company the one the key belongs to?
let tenantCache: { slug: string; id: string | null } | null = null
export async function digitaxForTenant(tenantId: string, findSlug: (slug: string) => Promise<string | null>) {
  const slug = process.env.DIGITAX_TENANT
  if (!slug || !process.env.DIGITAX_API_KEY) return false
  if (tenantCache?.slug !== slug) tenantCache = { slug, id: await findSlug(slug) }
  return tenantCache.id === tenantId
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

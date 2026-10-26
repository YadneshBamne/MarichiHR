import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useToast } from '../../components/ui/Toast'
import { money } from '../../lib/format'

// ZRA Smart Invoice purchases (DigiTax) for finance-approved claims. Shown only to the company DigiTax is set up for.
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const tone: Record<string, string> = { COMPLETED: 'ok', PENDING: 'warn', FAILED: 'danger', ERROR: 'danger' }

export default function SmartInvoicePanel() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: ov } = useQuery({ queryKey: ['smart-invoice'], queryFn: async () => (await api.get('/expenses/smart-invoice')).data.data as { connected: boolean; test?: boolean } })
  const on = !!ov?.connected
  const { data } = useQuery({ queryKey: ['smart-invoice-claims'], enabled: on, queryFn: async () => (await api.get('/expenses/smart-invoice/claims')).data.data as { claims: any[]; categories: any[] } })
  const { data: items = [] } = useQuery({ queryKey: ['smart-invoice-items'], enabled: on, queryFn: async () => (await api.get('/expenses/smart-invoice/items')).data.data as { id: string; name: string; status: string }[] })
  const done = (msg: string) => { toast(msg); qc.invalidateQueries({ queryKey: ['smart-invoice-claims'] }) }

  const map = useMutation({ mutationFn: async (v: { id: string; itemId: string | null }) => (await api.put(`/expenses/smart-invoice/categories/${v.id}`, { itemId: v.itemId })).data.data, onSuccess: () => done('Category mapped'), onError: (e) => toast(errMsg(e), 'error') })
  const send = useMutation({
    mutationFn: async (id: string) => {
      const tin = window.prompt('Supplier TPIN (10 digits, from the Smart Invoice; leave empty if none)', '')
      if (tin === null) return null
      const name = window.prompt('Supplier name', '')
      if (name === null) return null
      const inv = window.prompt('Smart Invoice number on the receipt (leave empty if none)', '')
      if (inv === null) return null
      return (await api.post(`/expenses/claims/${id}/smart-invoice`, { ...(tin.trim() && { supplierTin: tin.trim() }), ...(name.trim() && { supplierName: name.trim() }), ...(inv.trim() && { supplierInvoiceNumber: Number(inv.trim()) }) })).data.data
    },
    onSuccess: (r) => r && done(`Sent to ZRA via DigiTax: ${r.status.toLowerCase()}`),
    onError: (e) => { toast(errMsg(e), 'error'); qc.invalidateQueries({ queryKey: ['smart-invoice-claims'] }) },
  })
  const refresh = useMutation({ mutationFn: async (id: string) => (await api.post(`/expenses/claims/${id}/smart-invoice/refresh`)).data.data, onSuccess: (r) => done(`ZRA status: ${r.status.toLowerCase()}`), onError: (e) => toast(errMsg(e), 'error') })

  if (!on || !data) return null
  return (
    <section className="card" style={{ padding: 18, marginTop: 20, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 16, flex: 1 }}>ZRA Smart Invoice purchases</h3>
        {ov?.test && <span className="pill warn" style={{ textTransform: 'none' }}>DigiTax test business</span>}
      </div>
      <p className="dim" style={{ fontSize: 13 }}>Record approved claims backed by a supplier’s Smart Invoice as purchases, so the input VAT is on record with ZRA. Map each category to a DigiTax item first.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {data.categories.map((c) => (
          <label key={c.id} className="field" style={{ minWidth: 200 }}><span>{c.name}</span>
            <select className="input" value={c.digitaxItemId ?? ''} disabled={map.isPending} onChange={(e) => map.mutate({ id: c.id, itemId: e.target.value || null })}>
              <option value="">Not mapped</option>
              {items.map((i) => <option key={i.id} value={i.id} disabled={i.status !== 'COMPLETED'}>{i.name}{i.status !== 'COMPLETED' ? ` (${i.status.toLowerCase()} with ZRA)` : ''}</option>)}
            </select>
          </label>
        ))}
      </div>
      {!data.claims.length ? <span className="dim" style={{ fontSize: 13 }}>No finance-approved claims in ZMW yet.</span> : (
        <table className="tbl">
          <thead><tr><th>Date</th><th>Employee</th><th>Category</th><th>Amount</th><th>ZRA</th><th /></tr></thead>
          <tbody>
            {data.claims.map((c) => {
              const d = c.digitax as { status?: string; error?: string } | null
              return (
                <tr key={c.id}>
                  <td>{c.expenseDate}</td>
                  <td>{c.employee.firstName} {c.employee.lastName}</td>
                  <td>{c.category.name}</td>
                  <td>{money(c.homeAmount, 'ZMW')}</td>
                  <td>{d?.status ? <span className={`pill ${tone[d.status] ?? 'mute'}`} title={d.error ?? ''} style={{ textTransform: 'none' }}>{d.status.toLowerCase()}</span> : <span className="dim">not sent</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    {(!d?.status || d.status === 'FAILED' || d.status === 'ERROR') && <button className="btn btn-ghost btn-sm" disabled={send.isPending || !c.category.digitaxItemId} title={c.category.digitaxItemId ? '' : 'Map the category first'} onClick={() => send.mutate(c.id)}>Send to ZRA</button>}
                    {d?.status === 'PENDING' && <button className="btn btn-ghost btn-sm" disabled={refresh.isPending} onClick={() => refresh.mutate(c.id)}>Check status</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

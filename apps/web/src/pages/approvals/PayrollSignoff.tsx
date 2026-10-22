import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useToast } from '../../components/ui/Toast'

// System admins: the amount above which a payroll needs their sign-off, and the payrolls waiting for it (totals only)
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export default function PayrollSignoff() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['payroll-signoffs'], queryFn: async () => (await api.get('/payroll/signoffs')).data.data as { threshold: number | null; cycles: { id: string; period: string; people: number; gross: number; net: number; currency: string }[] } })
  const [amount, setAmount] = useState('')
  useEffect(() => { setAmount(data?.threshold == null ? '' : String(data.threshold)) }, [data?.threshold])
  const refresh = () => qc.invalidateQueries({ queryKey: ['payroll-signoffs'] })
  const save = useMutation({ mutationFn: () => api.put('/payroll/signoff-threshold', { amount: amount === '' ? null : Number(amount) }), onSuccess: () => { toast('Saved'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const sign = useMutation({ mutationFn: (id: string) => api.post(`/payroll/cycles/${id}/signoff`), onSuccess: () => { toast('Signed off; Payroll can now pay it'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="card" style={{ padding: 18, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '1 1 260px' }}><span>Payrolls with a net total above this need your sign-off (empty = never)</span><input className="input" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <button className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>Save</button>
      </section>
      <section className="card" style={{ padding: 8 }}>
        {!data?.cycles.length ? <p className="dim" style={{ padding: 14 }}>No payroll is waiting for your sign-off.</p> : (
          <table className="tbl" style={{ width: '100%' }}>
            <thead><tr><th>Month</th><th className="num">People</th><th className="num">Gross</th><th className="num">Net</th><th /></tr></thead>
            <tbody>{data.cycles.map((c) => (
              <tr key={c.id}><td>{c.period}</td><td className="num">{c.people}</td><td className="num">{c.currency} {c.gross.toLocaleString()}</td><td className="num">{c.currency} {c.net.toLocaleString()}</td>
                <td><button className="btn btn-primary btn-sm" disabled={sign.isPending} onClick={() => sign.mutate(c.id)}>Sign off</button></td></tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  )
}

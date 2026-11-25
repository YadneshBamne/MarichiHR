import { useState } from 'react'
import YearEndPanel from './YearEndPanel'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useReveal } from '../../lib/motion'
import BlackoutsCard from './BlackoutsCard'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const CATEGORIES = ['annual', 'sick', 'casual', 'maternity', 'paternity', 'bereavement', 'compensatory', 'unpaid', 'other']
const ACCRUALS: [string, string][] = [['manual', 'Manual allocation'], ['monthly_prorate', 'Monthly accrual'], ['annual_lumpsum', 'Annual lump sum']]
// What happens when someone asks for more days than they have. It is one choice over the two settings the API keeps:
//   none     -> allowNegative false, allowOverBalance false: the request is refused ("Insufficient leave balance")
//   approver -> allowNegative false, allowOverBalance true:  the request goes through, the extra days are flagged and the approver
//               decides paid (the balance goes negative and HR is told) or unpaid (the extra days are deducted in payroll)
//   negative -> allowNegative true:                          no balance check at all; everything is paid and the balance goes negative
const OVER: [string, string, string][] = [
  ['none', 'Not allowed', 'The request is refused when there are not enough days.'],
  ['approver', 'Allowed, the approver decides paid or unpaid', 'The extra days are flagged; the approver treats them as paid (balance goes negative) or unpaid (deducted in payroll).'],
  ['negative', 'Allowed, the balance goes negative', 'No check against the balance; the days are paid and the balance goes below zero.'],
]
const overOf = (t: { allowNegative?: boolean; allowOverBalance?: boolean }) => (t.allowNegative ? 'negative' : t.allowOverBalance ? 'approver' : 'none')

type Form = Record<string, any>
const BLANK: Form = {
  name: '', code: '', category: 'annual', isPaid: true, accrualType: 'manual', accrualAmount: '', carryForward: false, carryForwardMax: '',
  carryForwardExpiryMonths: '', over: 'approver', hourlyAllowed: false, tenureSlabs: [], encashable: false, encashMaxDays: '', halfDayAllowed: true, approvalLevels: 1, attachmentRequiredAfterDays: '',
  sandwichRule: false, isStatutory: false, statutoryCountry: '',
}
const num = (v: any) => (v === '' || v == null ? null : Number(v))

export default function LeaveTypesPage() {
  const qc = useQueryClient()
  const root = useReveal<HTMLDivElement>('leave-types')
  const { data: types = [], isLoading } = useQuery({ queryKey: ['leave-types-all'], queryFn: async () => (await api.get('/leave/types/all')).data.data })
  const write = useMutation({
    mutationFn: async ({ id, body }: { id?: string; body: Form }) => (id ? api.patch(`/leave/types/${id}`, body) : api.post('/leave/types', body)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave-types-all'] })
      qc.invalidateQueries({ queryKey: ['leave-types'] })
    },
  })
  const [form, setForm] = useState<Form | null>(null)
  const [error, setError] = useState('')
  const set = (k: string, v: any) => setForm((f) => ({ ...f!, [k]: v }))

  const save = async () => {
    setError('')
    const f = form!
    const body: Form = {
      name: f.name.trim(), category: f.category, isPaid: f.isPaid, accrualType: f.accrualType, accrualAmount: num(f.accrualAmount),
      carryForward: f.carryForward, carryForwardMax: f.carryForward ? num(f.carryForwardMax) : null,
      carryForwardExpiryMonths: f.carryForward ? num(f.carryForwardExpiryMonths) : null,
      allowNegative: f.over === 'negative', allowOverBalance: f.over === 'approver',
      hourlyAllowed: f.hourlyAllowed, tenureSlabs: (f.tenureSlabs ?? []).filter((x: any) => x.fromYears !== '' && x.amount !== '').map((x: any) => ({ fromYears: Number(x.fromYears), amount: Number(x.amount) })), encashable: f.encashable, encashMaxDays: f.encashable ? num(f.encashMaxDays) : null,
      halfDayAllowed: f.halfDayAllowed, approvalLevels: Number(f.approvalLevels), attachmentRequiredAfterDays: num(f.attachmentRequiredAfterDays),
      sandwichRule: f.sandwichRule, isStatutory: f.isStatutory, statutoryCountry: f.isStatutory && f.statutoryCountry ? f.statutoryCountry.toUpperCase() : null,
    }
    if (!f.id) body.code = f.code.trim().toUpperCase()
    try {
      await write.mutateAsync({ id: f.id, body })
      setForm(null)
    } catch (err) { setError(errMsg(err)) }
  }
  const toggleActive = async (t: any) => {
    setError('')
    try { await write.mutateAsync({ id: t.id, body: { active: !t.active } }) } catch (err) { setError(errMsg(err)) }
  }
  const edit = (t: any) => setForm({ ...Object.fromEntries(Object.keys(BLANK).concat('id').map((k) => [k, t[k] ?? (typeof BLANK[k] === 'boolean' ? false : Array.isArray(BLANK[k]) ? [] : '')])), over: overOf(t), statutoryMinimum: t.statutoryMinimum ?? null })

  const check = (k: string, label: string) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <input type="checkbox" checked={!!form![k]} onChange={(e) => set(k, e.target.checked)} /> {label}
    </label>
  )
  const grid2 = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 } as const

  return (
    <div ref={root}>
      <PageHeader title="Leave policies" sub="Accrual, carry-forward and approval rules. Archived types can no longer be applied for."
        actions={<button className="btn btn-primary btn-sm" onClick={() => { setError(''); setForm({ ...BLANK }) }}><Icon name="plus" size={14} /> New leave type</button>} />
      <section data-card className="card" style={{ padding: 6, overflowX: 'auto' }}>
        {isLoading ? <div className="skeleton" style={{ height: 160, borderRadius: 14 }} /> : types.length === 0 ? <p className="dim" style={{ padding: 20, fontSize: 13 }}>No leave types yet.</p> : (
          <table className="tbl">
            <thead><tr>{['Leave type', 'Category', 'Paid', 'Accrual', 'Carry forward', 'Approval', ''].map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {types.map((t: any) => (
                <tr key={t.id} style={{ opacity: t.active ? 1 : 0.55 }}>
                  <td><strong style={{ fontWeight: 600 }}>{t.name}</strong> <span className="dim" style={{ fontSize: 12 }}>{t.code}</span>{!t.active && <span className="pill mute" style={{ marginLeft: 8 }}>Archived</span>}</td>
                  <td style={{ textTransform: 'capitalize' }}>{t.category}</td>
                  <td><span className={`pill ${t.isPaid ? 'ok' : 'mute'}`}>{t.isPaid ? 'Paid' : 'Unpaid'}</span></td>
                  <td>{t.accrualType === 'monthly_prorate' ? `${t.accrualAmount}/month` : t.accrualType === 'annual_lumpsum' ? `${t.accrualAmount}/year` : 'Manual'}</td>
                  <td>{t.carryForward ? `Up to ${t.carryForwardMax ?? '∞'} days` : 'No'}</td>
                  <td>{t.approvalLevels} level{t.approvalLevels > 1 ? 's' : ''}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setError(''); edit(t) }}>Edit</button>
                    <button className="btn btn-ghost btn-sm" style={t.active ? { color: 'var(--danger)' } : undefined} disabled={write.isPending} onClick={() => toggleActive(t)}>{t.active ? 'Archive' : 'Restore'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {error && !form && <div role="alert" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 14, padding: '10px 14px', fontSize: 13, marginTop: 12 }}>{error}</div>}

      <YearEndPanel />

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit leave type' : 'New leave type'} width={620}>
        {form && (
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={grid2}>
              <label className="field"><span>Name *</span><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
              <label className="field"><span>Code *</span><input className="input" style={form.id ? { background: 'var(--well)', color: 'var(--faint)' } : undefined} value={form.code} disabled={!!form.id} placeholder="e.g. STUDY" onChange={(e) => set('code', e.target.value.toUpperCase())} /></label>
              <label className="field"><span>Category</span><select className="input select" value={form.category} onChange={(e) => set('category', e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
              <label className="field"><span>Approval levels</span><select className="input select" value={form.approvalLevels} onChange={(e) => set('approvalLevels', e.target.value)}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
              <label className="field"><span>Accrual</span><select className="input select" value={form.accrualType ?? 'manual'} onChange={(e) => set('accrualType', e.target.value)}>{ACCRUALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label className="field"><span>{form.accrualType === 'monthly_prorate' ? 'Days per month' : form.accrualType === 'annual_lumpsum' ? 'Days per year' : 'Default days (reference)'}{form.accrualType !== 'manual' ? ' *' : ''}</span><input className="input" type="number" min={0} step={0.01} value={form.accrualAmount} onChange={(e) => set('accrualAmount', e.target.value)} /></label>
              <label className="field"><span>Attachment required after (days)</span><input className="input" type="number" min={1} value={form.attachmentRequiredAfterDays} onChange={(e) => set('attachmentRequiredAfterDays', e.target.value)} /></label>
            </div>
            <label className="field"><span>When a request is more than the balance</span>
              <select className="input select" value={form.over} onChange={(e) => set('over', e.target.value)}>{OVER.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              <span className="muted" style={{ fontSize: 12 }}>{OVER.find(([v]) => v === form.over)?.[2]}{!form.isPaid ? ' (Unpaid leave is never checked against a balance.)' : ''}</span>
            </label>
            <div style={{ ...grid2, gap: 10 }}>
              {check('isPaid', 'Paid leave')}
              {check('halfDayAllowed', 'Half days allowed')}
              {check('hourlyAllowed', 'Can be taken by the hour (8 hours = 1 day)')}
              {check('encashable', 'Encashable (exit and year end)')}
              {check('sandwichRule', 'Sandwich rule (count weekends between)')}
              {check('carryForward', 'Carry forward unused days')}
              {check('isStatutory', 'Statutory leave')}
            </div>
            {form.accrualType && form.accrualType !== 'manual' && (
              <div style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>More leave with longer service (optional)</span>
                {(form.tenureSlabs ?? []).map((sl: any, i: number) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, flexWrap: 'wrap' }}>
                    From <input className="input" style={{ width: 80 }} type="number" min={0} value={sl.fromYears} onChange={(e) => set('tenureSlabs', form.tenureSlabs.map((x: any, j: number) => (j === i ? { ...x, fromYears: e.target.value } : x)))} aria-label="From years of service" /> years:
                    <input className="input" style={{ width: 90 }} type="number" min={0} step={0.01} value={sl.amount} onChange={(e) => set('tenureSlabs', form.tenureSlabs.map((x: any, j: number) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label="Days" /> {form.accrualType === 'monthly_prorate' ? 'days a month' : 'days a year'}
                    <button className="btn btn-ghost btn-sm" onClick={() => set('tenureSlabs', form.tenureSlabs.filter((_: any, j: number) => j !== i))}>Remove</button>
                  </div>
                ))}
                <div><button className="btn btn-ghost btn-sm" onClick={() => set('tenureSlabs', [...(form.tenureSlabs ?? []), { fromYears: '', amount: '' }])}>+ Add a service step</button></div>
              </div>
            )}
            {form.statutoryMinimum && <div className="dim" style={{ fontSize: 12.5 }}>Legal minimum for this leave: {form.statutoryMinimum.days} days ({form.statutoryMinimum.source}). It cannot be set lower.</div>}
            {form.carryForward && (
              <div style={grid2}>
                <label className="field"><span>Carry forward max (days)</span><input className="input" type="number" min={0} value={form.carryForwardMax} onChange={(e) => set('carryForwardMax', e.target.value)} /></label>
                <label className="field"><span>Carried days expire after (months)</span><input className="input" type="number" min={1} value={form.carryForwardExpiryMonths} onChange={(e) => set('carryForwardExpiryMonths', e.target.value)} /></label>
              </div>
            )}
            {form.encashable && (
              <label className="field" style={{ maxWidth: 280 }}><span>Most days paid out at year end (empty = no limit)</span><input className="input" type="number" min={0} value={form.encashMaxDays} onChange={(e) => set('encashMaxDays', e.target.value)} /></label>
            )}
            {form.isStatutory && (
              <label className="field" style={{ maxWidth: 160 }}><span>Statutory country (ISO code)</span><input className="input" maxLength={2} value={form.statutoryCountry} onChange={(e) => set('statutoryCountry', e.target.value.toUpperCase())} /></label>
            )}
          </div>
        )}
        {error && <div role="alert" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 14, padding: '10px 14px', fontSize: 13, marginTop: 12 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={() => setForm(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={!form?.name?.trim() || (!form?.id && !form?.code?.trim()) || write.isPending} onClick={save}>{write.isPending ? 'Saving…' : 'Save'}</button>
        </div>
      </Modal>
      <BlackoutsCard types={types} />
    </div>
  )
}

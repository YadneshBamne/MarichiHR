import { useState } from 'react'
import YearEndPanel from './YearEndPanel'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { errMsg } from '../../lib/hooks/useSalary'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle, selectStyle } from '../../components/ui/FormField'
import { card, th, td, empty, primaryBtn, ghostBtn, linkBtn, errorBox, grid2, footer } from '../salary/styles'
import BlackoutsCard from './BlackoutsCard'

const CATEGORIES = ['annual', 'sick', 'casual', 'maternity', 'paternity', 'bereavement', 'compensatory', 'unpaid', 'other']
const ACCRUALS: [string, string][] = [['manual', 'Manual allocation'], ['monthly_prorate', 'Monthly accrual'], ['annual_lumpsum', 'Annual lump sum']]

type Form = Record<string, any>
const BLANK: Form = {
  name: '', code: '', category: 'annual', isPaid: true, accrualType: 'manual', accrualAmount: '', carryForward: false, carryForwardMax: '',
  carryForwardExpiryMonths: '', allowNegative: false, allowOverBalance: true, hourlyAllowed: false, tenureSlabs: [], encashable: false, encashMaxDays: '', halfDayAllowed: true, approvalLevels: 1, attachmentRequiredAfterDays: '',
  sandwichRule: false, isStatutory: false, statutoryCountry: '',
}
const num = (v: any) => (v === '' || v == null ? null : Number(v))

export default function LeaveTypesPage() {
  const qc = useQueryClient()
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
      carryForwardExpiryMonths: f.carryForward ? num(f.carryForwardExpiryMonths) : null, allowNegative: f.allowNegative, allowOverBalance: f.allowOverBalance, hourlyAllowed: f.hourlyAllowed, tenureSlabs: (f.tenureSlabs ?? []).filter((x: any) => x.fromYears !== '' && x.amount !== '').map((x: any) => ({ fromYears: Number(x.fromYears), amount: Number(x.amount) })), encashable: f.encashable, encashMaxDays: f.encashable ? num(f.encashMaxDays) : null,
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
  const edit = (t: any) => setForm({ ...Object.fromEntries(Object.keys(BLANK).concat('id').map((k) => [k, t[k] ?? (typeof BLANK[k] === 'boolean' ? false : Array.isArray(BLANK[k]) ? [] : '')])), statutoryMinimum: t.statutoryMinimum ?? null })

  const check = (k: string, label: string) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <input type="checkbox" checked={!!form![k]} onChange={(e) => set(k, e.target.checked)} /> {label}
    </label>
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: 'clamp(32px, 4vw, 46px)', fontFamily: 'var(--font-display)', fontWeight: 400, letterSpacing: '-0.02em', margin: 0 }}>Leave policies</h2>
          <p style={{ fontSize: 13, color: 'var(--faint)', marginTop: 2 }}>Accrual, carry-forward and approval rules. Archived types can no longer be applied for.</p>
        </div>
        <button style={primaryBtn} onClick={() => { setError(''); setForm({ ...BLANK }) }}>+ New leave type</button>
      </div>
      <div style={card}>
        {isLoading ? <div style={empty}>Loading...</div> : types.length === 0 ? <div style={empty}>No leave types yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Leave type', 'Category', 'Paid', 'Accrual', 'Carry forward', 'Approval', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {types.map((t: any) => (
                <tr key={t.id} style={{ opacity: t.active ? 1 : 0.55 }}>
                  <td style={td}><strong>{t.name}</strong> <span style={{ color: 'var(--faint)', fontSize: 12 }}>{t.code}</span>{!t.active && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--danger)' }}>Archived</span>}</td>
                  <td style={{ ...td, textTransform: 'capitalize' }}>{t.category}</td>
                  <td style={td}>{t.isPaid ? 'Paid' : 'Unpaid'}</td>
                  <td style={td}>{t.accrualType === 'monthly_prorate' ? `${t.accrualAmount}/month` : t.accrualType === 'annual_lumpsum' ? `${t.accrualAmount}/year` : 'Manual'}</td>
                  <td style={td}>{t.carryForward ? `Up to ${t.carryForwardMax ?? '∞'} days` : 'No'}</td>
                  <td style={td}>{t.approvalLevels} level{t.approvalLevels > 1 ? 's' : ''}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button style={linkBtn} onClick={() => { setError(''); edit(t) }}>Edit</button>
                    <button style={{ ...linkBtn, color: t.active ? 'var(--danger)' : 'var(--brand)' }} onClick={() => toggleActive(t)}>{t.active ? 'Archive' : 'Restore'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {error && !form && <div style={errorBox}>{error}</div>}

      <YearEndPanel />

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit leave type' : 'New leave type'} width={620}>
        {form && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={grid2}>
              <FormField label="Name" required><input style={inputStyle} value={form.name} onChange={(e) => set('name', e.target.value)} /></FormField>
              <FormField label="Code" required>
                <input style={{ ...inputStyle, ...(form.id ? { backgroundColor: 'var(--well)', color: 'var(--faint)' } : {}) }} value={form.code} disabled={!!form.id} placeholder="e.g. STUDY" onChange={(e) => set('code', e.target.value.toUpperCase())} />
              </FormField>
              <FormField label="Category">
                <select style={selectStyle} value={form.category} onChange={(e) => set('category', e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
              </FormField>
              <FormField label="Approval levels">
                <select style={selectStyle} value={form.approvalLevels} onChange={(e) => set('approvalLevels', e.target.value)}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select>
              </FormField>
              <FormField label="Accrual">
                <select style={selectStyle} value={form.accrualType ?? 'manual'} onChange={(e) => set('accrualType', e.target.value)}>{ACCRUALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </FormField>
              <FormField label={form.accrualType === 'monthly_prorate' ? 'Days per month' : form.accrualType === 'annual_lumpsum' ? 'Days per year' : 'Default days (reference)'} required={form.accrualType !== 'manual'}>
                <input style={inputStyle} type="number" min={0} step={0.01} value={form.accrualAmount} onChange={(e) => set('accrualAmount', e.target.value)} />
              </FormField>
              <FormField label="Attachment required after (days)"><input style={inputStyle} type="number" min={1} value={form.attachmentRequiredAfterDays} onChange={(e) => set('attachmentRequiredAfterDays', e.target.value)} /></FormField>
            </div>
            <div style={{ ...grid2, gap: 10 }}>
              {check('isPaid', 'Paid leave')}
              {check('halfDayAllowed', 'Half days allowed')}
              {check('hourlyAllowed', 'Can be taken by the hour (8 hours = 1 day)')}
              {check('allowNegative', 'Allow negative balance')}
              {check('allowOverBalance', 'Allow requests beyond the balance (the approver decides paid or unpaid)')}
              {check('encashable', 'Encashable (exit and year end)')}
              {check('sandwichRule', 'Sandwich rule (count weekends between)')}
              {check('carryForward', 'Carry forward unused days')}
              {check('isStatutory', 'Statutory leave')}
            </div>
            {form.accrualType && form.accrualType !== 'manual' && (
              <div style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>More leave with longer service (optional)</span>
                {(form.tenureSlabs ?? []).map((sl: any, i: number) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                    From <input style={{ ...inputStyle, width: 70 }} type="number" min={0} value={sl.fromYears} onChange={(e) => set('tenureSlabs', form.tenureSlabs.map((x: any, j: number) => (j === i ? { ...x, fromYears: e.target.value } : x)))} aria-label="From years of service" /> years:
                    <input style={{ ...inputStyle, width: 80 }} type="number" min={0} step={0.01} value={sl.amount} onChange={(e) => set('tenureSlabs', form.tenureSlabs.map((x: any, j: number) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label="Days" /> {form.accrualType === 'monthly_prorate' ? 'days a month' : 'days a year'}
                    <button style={ghostBtn} onClick={() => set('tenureSlabs', form.tenureSlabs.filter((_: any, j: number) => j !== i))}>Remove</button>
                  </div>
                ))}
                <div><button style={ghostBtn} onClick={() => set('tenureSlabs', [...(form.tenureSlabs ?? []), { fromYears: '', amount: '' }])}>+ Add a service step</button></div>
              </div>
            )}
            {form.statutoryMinimum && <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>Legal minimum for this leave: {form.statutoryMinimum.days} days ({form.statutoryMinimum.source}). It cannot be set lower.</div>}
            {form.carryForward && (
              <div style={grid2}>
                <FormField label="Carry forward max (days)"><input style={inputStyle} type="number" min={0} value={form.carryForwardMax} onChange={(e) => set('carryForwardMax', e.target.value)} /></FormField>
                <FormField label="Carried days expire after (months)"><input style={inputStyle} type="number" min={1} value={form.carryForwardExpiryMonths} onChange={(e) => set('carryForwardExpiryMonths', e.target.value)} /></FormField>
              </div>
            )}
            {form.encashable && (
              <FormField label="Most days paid out at year end (empty = no limit)"><input style={{ ...inputStyle, maxWidth: 200 }} type="number" min={0} value={form.encashMaxDays} onChange={(e) => set('encashMaxDays', e.target.value)} /></FormField>
            )}
            {form.isStatutory && (
              <FormField label="Statutory country (ISO code)"><input style={{ ...inputStyle, maxWidth: 120 }} maxLength={2} value={form.statutoryCountry} onChange={(e) => set('statutoryCountry', e.target.value.toUpperCase())} /></FormField>
            )}
          </div>
        )}
        {error && <div style={errorBox}>{error}</div>}
        <div style={footer}>
          <button style={ghostBtn} onClick={() => setForm(null)}>Cancel</button>
          <button style={primaryBtn} disabled={!form?.name?.trim() || (!form?.id && !form?.code?.trim()) || write.isPending} onClick={save}>Save</button>
        </div>
      </Modal>
      <BlackoutsCard types={types} />
    </div>
  )
}

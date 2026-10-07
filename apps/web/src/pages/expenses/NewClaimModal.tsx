import { useState } from 'react'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle, selectStyle } from '../../components/ui/FormField'
import { useAuth } from '../../contexts/AuthContext'
import { useExpenseCategories, useCreateClaim, usePerDiemQuote, useFxQuote } from '../../lib/hooks/useExpenses'
import { money } from '../../lib/format'

const today = () => new Date().toISOString().slice(0, 10)

export default function NewClaimModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth()
  const home = user?.tenant?.baseCurrency || 'ZMW'
  const { data: categories = [] } = useExpenseCategories()
  const create = useCreateClaim()

  const [type, setType] = useState<'actual' | 'per_diem'>('actual')
  const [f, setF] = useState({
    categoryId: '', expenseDate: today(), description: '', receiptNumber: '',
    expenseCurrency: home, expenseAmount: '',
    countryCode: '', city: '', days: '',
  })
  const [error, setError] = useState('')
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))

  const amount = parseFloat(f.expenseAmount)
  const cur = f.expenseCurrency.trim().toUpperCase()
  const needsFx = type === 'actual' && /^[A-Z]{3}$/.test(cur) && cur !== home && amount > 0
  const fx = useFxQuote(cur, f.expenseDate, needsFx && !!f.expenseDate)

  const days = parseFloat(f.days)
  const country = f.countryCode.trim().toUpperCase()
  const perDiemReady = type === 'per_diem' && /^[A-Z]{2}$/.test(country) && days > 0 && !!f.expenseDate
  const quote = usePerDiemQuote({ countryCode: country, city: f.city.trim() || undefined, days, date: f.expenseDate }, perDiemReady)

  const apiError = (q: any) => q.error?.response?.data?.message || (q.error ? 'Could not get a rate' : '')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    const base = { categoryId: f.categoryId, expenseDate: f.expenseDate, description: f.description }
    const body = type === 'actual'
      ? { claimType: 'actual', ...base, expenseCurrency: cur, expenseAmount: amount, ...(f.receiptNumber.trim() && { receiptNumber: f.receiptNumber.trim() }) }
      : { claimType: 'per_diem', ...base, countryCode: country, ...(f.city.trim() && { city: f.city.trim() }), days }
    try {
      await create.mutateAsync(body)
      onClose()
    } catch (err: any) {
      const fields = err?.response?.data?.fieldErrors
      setError(err?.response?.data?.message === 'Validation failed' && Array.isArray(fields) ? fields.map((x: any) => `${x.field}: ${x.message}`).join('; ') : err?.response?.data?.message || 'Failed to submit claim')
    }
  }

  const preview = (() => {
    if (type === 'actual') {
      if (!(amount > 0)) return null
      if (cur === home) return <span>{money(amount, home)}</span>
      if (fx.isError) return <span style={{ color: 'var(--danger)' }}>{apiError(fx)}</span>
      if (fx.data) return <span>{money(amount, cur)} × {fx.data.fxRate} = <strong>{money(Math.round(amount * fx.data.fxRate * 100) / 100, home)}</strong></span>
      return <span style={{ color: 'var(--faint)' }}>Looking up rate...</span>
    }
    if (!perDiemReady) return null
    if (quote.isError) return <span style={{ color: 'var(--danger)' }}>{apiError(quote)}</span>
    if (quote.data) {
      const q = quote.data
      return <span>{q.days} day(s) × {money(q.rate, q.currency)} = {money(q.expenseAmount, q.currency)}{q.currency !== q.homeCurrency && <> → <strong>{money(q.homeAmount, q.homeCurrency)}</strong> (rate {q.fxRate})</>}</span>
    }
    return <span style={{ color: 'var(--faint)' }}>Looking up rate...</span>
  })()

  const tabBtn = (key: 'actual' | 'per_diem', label: string) => (
    <button type="button" onClick={() => setType(key)} style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--line)', backgroundColor: type === key ? 'var(--brand)' : 'var(--card-2)', color: type === key ? 'var(--card-2)' : 'var(--dim)', fontSize: 13, cursor: 'pointer', borderRadius: key === 'actual' ? '6px 0 0 6px' : '0 6px 6px 0' }}>{label}</button>
  )

  return (
    <Modal open={open} onClose={onClose} title="New expense claim" width={520}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex' }}>{tabBtn('actual', 'Actual expense')}{tabBtn('per_diem', 'Per diem')}</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FormField label="Category" required>
            <select style={selectStyle} value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)} required>
              <option value="">Select...</option>
              {categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </FormField>
          <FormField label={type === 'per_diem' ? 'Trip start date' : 'Expense date'} required>
            <input style={inputStyle} type="date" max={today()} value={f.expenseDate} onChange={(e) => set('expenseDate', e.target.value)} required />
          </FormField>
        </div>

        {type === 'actual' ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <FormField label="Currency" required><input style={inputStyle} maxLength={3} value={f.expenseCurrency} onChange={(e) => set('expenseCurrency', e.target.value.toUpperCase())} required /></FormField>
              <FormField label="Amount" required><input style={inputStyle} type="number" min="0.01" step="0.01" value={f.expenseAmount} onChange={(e) => set('expenseAmount', e.target.value)} required /></FormField>
            </div>
            <FormField label="Receipt number"><input style={inputStyle} value={f.receiptNumber} onChange={(e) => set('receiptNumber', e.target.value)} /></FormField>
          </>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '0.7fr 1fr 0.7fr', gap: 12 }}>
            <FormField label="Country (2 letters)" required><input style={inputStyle} maxLength={2} placeholder="ZM" value={f.countryCode} onChange={(e) => set('countryCode', e.target.value.toUpperCase())} required /></FormField>
            <FormField label="City (optional)"><input style={inputStyle} value={f.city} onChange={(e) => set('city', e.target.value)} /></FormField>
            <FormField label="Days" required><input style={inputStyle} type="number" min="0.5" step="0.5" value={f.days} onChange={(e) => set('days', e.target.value)} required /></FormField>
          </div>
        )}

        <FormField label="Description" required><input style={inputStyle} maxLength={500} value={f.description} onChange={(e) => set('description', e.target.value)} required /></FormField>

        {preview && <div style={{ backgroundColor: 'var(--honey-soft)', borderRadius: 12, padding: '10px 12px', fontSize: 13 }}>{preview}</div>}
        {error && <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '10px 12px', fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ padding: '9px 18px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={create.isPending} style={{ padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: create.isPending ? 0.7 : 1 }}>{create.isPending ? 'Submitting...' : 'Submit claim'}</button>
        </div>
      </form>
    </Modal>
  )
}

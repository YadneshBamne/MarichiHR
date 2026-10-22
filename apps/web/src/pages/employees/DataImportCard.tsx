import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import api from '../../lib/api'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useAuth } from '../../contexts/AuthContext'
import { parseCsv } from './ImportEmployeesPage'

// Spreadsheet imports for people already in the company (matched by employee ID or work email). All or nothing.
const TYPES = {
  leave_balances: { label: 'Leave balances', cols: ['employee_id', 'leave_type', 'balance_days', 'used_days'], example: ['EMP0002', 'Annual Leave', '18', '3'], note: 'Sets each person’s balance for that leave type (replacing what is there). used_days is optional.' },
  bank_details: { label: 'Bank details', cols: ['employee_id', 'bank', 'account_number', 'ifsc_swift'], example: ['EMP0002', 'Zanaco', '0123456789', 'ZNCOZMLU'], note: 'bank must be in your Bank list. Numbers are stored encrypted and need verifying by finance before payroll pays them.' },
  contracts: { label: 'Contracts', cols: ['employee_id', 'wage_monthly', 'ctc_annual', 'currency', 'effective_from', 'effective_until', 'salary_structure', 'notice_days'], example: ['EMP0002', '12000', '150000', 'ZMW', '2026-01-01', '', 'Standard', '30'], note: 'For people without a contract. A past start date makes it running; a future one waits until then. ctc_annual defaults to 12 × wage.' },
} as const
type T = keyof typeof TYPES
interface Result { dryRun: boolean; created: number; rows: { row: number; name: string; employeeCode: string | null; status: string; errors: string[] }[] }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export default function DataImportCard() {
  const toast = useToast()
  const { hasRole } = useAuth()
  const [type, setType] = useState<T>('leave_balances')
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [fileName, setFileName] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const def = TYPES[type]
  const pick = (t: T) => { setType(t); setRows([]); setFileName(''); setResult(null) }
  const template = () => {
    const url = URL.createObjectURL(new Blob(['﻿' + [def.cols.join(','), def.example.join(',')].join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    Object.assign(document.createElement('a'), { href: url, download: `${type}-template.csv` }).click()
    URL.revokeObjectURL(url)
  }
  const read = async (file: File) => {
    const table = parseCsv(await file.text())
    if (table.length < 2) return toast('The file has no rows under the header', 'error')
    const head = table[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''))
    if (!head.includes('employee_id')) return toast('The file needs an employee_id column. Start from the template.', 'error')
    setRows(table.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()]).filter(([h, v]) => (def.cols as readonly string[]).includes(h) && v))))
    setFileName(file.name)
    setResult(null)
  }
  const run = useMutation({
    mutationFn: async (dryRun: boolean) => (await api.post(`/employees/import/${type}`, { rows, dryRun })).data.data as Result,
    onSuccess: (r) => { setResult(r); if (!r.dryRun && r.created) toast(`${r.created} row${r.created === 1 ? '' : 's'} imported`) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const errors = result?.rows.filter((r) => r.errors.length) ?? []
  const done = result && !result.dryRun && result.created > 0

  return (
    <section data-card className="card" style={{ padding: 22, marginTop: 18, display: 'grid', gap: 14 }}>
      <div>
        <h3 style={{ fontSize: 15 }}>Import other data</h3>
        <span className="dim" style={{ fontSize: 13 }}>For people already in the company, matched by employee ID or work email.</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{(Object.keys(TYPES) as T[]).filter((t) => t !== 'contracts' || hasRole('payroll_admin')).map((t) => <button key={t} className="chip" aria-pressed={type === t} onClick={() => pick(t)} style={type === t ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{TYPES[t].label}</button>)}</div>
      <p className="dim" style={{ fontSize: 12, lineHeight: 1.6 }}>Columns: {def.cols.join(', ')}. {def.note}</p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-ghost btn-sm" onClick={template}><Icon name="download" size={14} /> Template</button>
        <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
          <Icon name="file" size={14} /> {fileName ? 'Choose another file' : 'Choose CSV file'}
          <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) read(f); e.target.value = '' }} />
        </label>
        {fileName && <span className="dim" style={{ fontSize: 13 }}>{fileName} · {rows.length} row{rows.length === 1 ? '' : 's'}</span>}
        <button className="btn btn-ghost btn-sm" disabled={!rows.length || run.isPending} onClick={() => run.mutate(true)}>Check file</button>
        <button className="btn btn-primary btn-sm" disabled={!result?.dryRun || errors.length > 0 || run.isPending} onClick={() => run.mutate(false)}>Import</button>
      </div>
      {result && (done ? <span className="pill ok" style={{ justifySelf: 'start' }}>{result.created} imported</span>
        : errors.length ? <div style={{ overflowX: 'auto' }}>
          <p style={{ marginBottom: 8 }}><span className="pill danger">{errors.length} row{errors.length > 1 ? 's' : ''} to fix</span> <span className="dim" style={{ fontSize: 13 }}>Nothing was imported.</span></p>
          <table className="tbl" style={{ width: '100%', minWidth: 520 }}>
            <thead><tr><th style={{ width: 50 }}>Row</th><th>Person</th><th>Problems</th></tr></thead>
            <tbody>{errors.map((r) => <tr key={r.row}><td className="dim">{r.row}</td><td>{r.name || '—'} <span className="dim">{r.employeeCode}</span></td><td><ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, color: 'var(--danger)' }}>{r.errors.map((e) => <li key={e}>{e}</li>)}</ul></td></tr>)}</tbody>
          </table>
        </div>
        : <span className="pill ok" style={{ justifySelf: 'start' }}>All {result.rows.length} rows look good</span>)}
    </section>
  )
}

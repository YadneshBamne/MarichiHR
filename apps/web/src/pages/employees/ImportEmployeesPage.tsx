import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import PageHeader from '../../components/ui/PageHeader'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

const COLUMNS = ['employee_id', 'first_name', 'last_name', 'work_email', 'hire_date', 'department', 'job_title', 'manager', 'employment_type', 'work_location', 'personal_email', 'mobile', 'date_of_birth', 'gender', 'nationality', 'tax_country'] as const
const REQUIRED = ['first_name', 'last_name', 'work_email', 'hire_date', 'department']
// Headers people actually type, mapped onto the template's
const ALIASES: Record<string, string> = { email: 'work_email', official_email: 'work_email', first: 'first_name', firstname: 'first_name', last: 'last_name', lastname: 'last_name', surname: 'last_name', joining_date: 'hire_date', date_of_joining: 'hire_date', doj: 'hire_date', start_date: 'hire_date', designation: 'job_title', title: 'job_title', position: 'job_title', reporting_manager: 'manager', manager_email: 'manager', location: 'work_location', phone: 'mobile', mobile_number: 'mobile', dob: 'date_of_birth', emp_id: 'employee_id', employee_code: 'employee_id', type: 'employment_type' }
const EXAMPLE = ['', 'Asha', 'Mwale', 'asha.mwale@yourcompany.com', '2026-11-01', 'Operations', 'Analyst', 'manager@yourcompany.com', 'full time', 'Lusaka HQ', '', '+260971234567', '1995-04-12', 'female', 'Zambian', 'ZM']

interface Result { dryRun: boolean; created: number; rows: { row: number; name: string; email: string; employeeCode: string | null; status: string; errors: string[] }[]; willCreate: { departments: string[]; positions: string[]; locations: string[] }; credentials?: Credential[] }
export interface Credential { name: string; employeeCode: string; email: string; temporaryPassword: string }

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
const save = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }))
  Object.assign(document.createElement('a'), { href: url, download: name }).click()
  URL.revokeObjectURL(url)
}

// RFC 4180-ish: quoted fields, doubled quotes, commas and newlines inside quotes
export function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  const s = text.replace(/^﻿/, '')
  const first = s.slice(0, s.search(/\r?\n|$/))
  const sep = first.includes(';') && !first.includes(',') ? ';' : ',' // Excel in some locales saves with semicolons
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === sep) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); out.push(row) }
  return out.filter((r) => r.some((c) => c.trim()))
}

export function downloadCredentials(list: Credential[]) {
  const lines = [['Name', 'Employee ID', 'Sign-in email', 'Temporary password', 'Sign in at'].join(','), ...list.map((c) => [c.name, c.employeeCode, c.email, c.temporaryPassword, window.location.origin + '/login'].map(csvCell).join(','))]
  save(`credentials-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\r\n'))
}

export default function ImportEmployeesPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [ignored, setIgnored] = useState<string[]>([])
  const [createMissing, setCreateMissing] = useState(true)
  const [grantLogin, setGrantLogin] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const root = useReveal<HTMLDivElement>(!!result)

  const read = async (file: File) => {
    const table = parseCsv(await file.text())
    if (table.length < 2) return toast('The file has no rows under the header', 'error')
    const head = table[0].map((h) => { const k = h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); return (COLUMNS as readonly string[]).includes(k) ? k : ALIASES[k] ?? null })
    const missing = REQUIRED.filter((c) => !head.includes(c))
    if (missing.length) return toast(`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Start from the template.`, 'error')
    setIgnored(table[0].filter((_, i) => !head[i]))
    setRows(table.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()]).filter(([h, v]) => h && v))))
    setFileName(file.name)
    setResult(null)
  }
  const run = useMutation({
    mutationFn: async (dryRun: boolean) => (await api.post('/employees/import', { rows, dryRun, createMissing, grantLogin })).data.data as Result,
    onSuccess: (r) => {
      setResult(r)
      if (!r.dryRun && r.created) {
        toast(`${r.created} ${r.created === 1 ? 'person' : 'people'} added`)
        qc.invalidateQueries({ queryKey: ['employees'] })
        if (r.credentials?.length) downloadCredentials(r.credentials)
      }
    },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const errors = result?.rows.filter((r) => r.errors.length) ?? []
  const done = result && !result.dryRun && result.created > 0

  return (
    <div ref={root}>
      <PageHeader title="Import employees" sub="Add many people at once from a spreadsheet"
        actions={<Link to="/employees" className="btn btn-ghost btn-sm"><Icon name="chevronLeft" size={14} /> Employees</Link>} />
      <div className="dgrid">
        <section data-card className="card span-8" style={{ padding: 22, display: 'grid', gap: 16, alignContent: 'start' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => save('employee-import-template.csv', [COLUMNS.join(','), EXAMPLE.map(csvCell).join(',')].join('\r\n'))}><Icon name="download" size={14} /> Download template</button>
            <label className="btn btn-primary btn-sm" style={{ cursor: 'pointer' }}>
              <Icon name="file" size={14} /> {fileName ? 'Choose another file' : 'Choose CSV file'}
              <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) read(f); e.target.value = '' }} />
            </label>
            {fileName && <span className="dim" style={{ fontSize: 13 }}>{fileName} · {rows.length} {rows.length === 1 ? 'person' : 'people'}</span>}
          </div>
          <p className="dim" style={{ fontSize: 12, lineHeight: 1.6 }}>
            Fill the template in Excel or Google Sheets and save it as CSV. Required: {REQUIRED.join(', ')}. Dates as 2026-11-01 or 01/11/2026.
            Leave employee_id empty to number people from your series. <b>manager</b> is the manager’s work email or employee ID, and can be someone in the same file.
          </p>
          {ignored.length > 0 && <p className="pill warn" style={{ whiteSpace: 'normal' }}>Ignored columns: {ignored.join(', ')}</p>}
          <label style={{ display: 'flex', gap: 10, alignItems: 'start', fontSize: 14 }}><input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} style={{ marginTop: 3 }} /><span>Create departments, job titles and locations that don’t exist yet<br /><span className="dim" style={{ fontSize: 12 }}>Untick to only accept names already in your masters.</span></span></label>
          <label style={{ display: 'flex', gap: 10, alignItems: 'start', fontSize: 14 }}><input type="checkbox" checked={grantLogin} onChange={(e) => setGrantLogin(e.target.checked)} style={{ marginTop: 3 }} /><span>Give everyone a login and download a credentials sheet<br /><span className="dim" style={{ fontSize: 12 }}>Temporary passwords, shown once. Each person sets their own at first sign-in.</span></span></label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" disabled={!rows.length || run.isPending} onClick={() => run.mutate(true)}>Check file</button>
            <button className="btn btn-primary" disabled={!result?.dryRun || errors.length > 0 || run.isPending} onClick={() => run.mutate(false)}>{run.isPending && !run.variables ? 'Importing…' : `Import ${rows.length || ''} ${rows.length === 1 ? 'person' : 'people'}`}</button>
          </div>
          {!result?.dryRun && rows.length > 0 && !done && <span className="dim" style={{ fontSize: 12 }}>Check the file first; nothing is saved until you import.</span>}
        </section>
        <IdSeries />
      </div>

      {result && (
        <section data-card className="card" style={{ padding: 20, marginTop: 18 }}>
          {done ? (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="pill ok">{result.created} added</span>
              {result.credentials?.length ? <><span className="dim" style={{ fontSize: 13 }}>The credentials sheet was downloaded. Store it safely; passwords are not shown again.</span><button className="btn btn-ghost btn-sm" onClick={() => downloadCredentials(result.credentials!)}>Download again</button></> : <span className="dim" style={{ fontSize: 13 }}>Grant logins later from the Employees list (select people → Issue logins).</span>}
            </div>
          ) : errors.length ? (
            <p style={{ marginBottom: 12 }}><span className="pill danger">{errors.length} row{errors.length > 1 ? 's' : ''} to fix</span> <span className="dim" style={{ fontSize: 13 }}>Nothing was imported. Fix these in the file and check it again.</span></p>
          ) : (
            <p style={{ marginBottom: 12 }}><span className="pill ok">All {result.rows.length} rows look good</span>{' '}
              {[['department', result.willCreate.departments], ['job title', result.willCreate.positions], ['location', result.willCreate.locations]].filter(([, l]) => l.length).map(([k, l]) => <span key={k as string} className="dim" style={{ fontSize: 13 }}>· new {k as string}{(l as string[]).length > 1 ? 's' : ''}: {(l as string[]).join(', ')} </span>)}
            </p>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl" style={{ width: '100%', minWidth: 620 }}>
              <thead><tr><th style={{ width: 50 }}>Row</th><th>Person</th><th>ID</th><th>Result</th></tr></thead>
              <tbody>{(errors.length ? errors : result.rows).map((r) => (
                <tr key={r.row}>
                  <td className="dim">{r.row}</td>
                  <td><strong style={{ fontWeight: 600 }}>{r.name || '—'}</strong><div className="dim" style={{ fontSize: 12 }}>{r.email}</div></td>
                  <td>{r.employeeCode}</td>
                  <td>{r.errors.length ? <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, color: 'var(--danger)' }}>{r.errors.map((e) => <li key={e}>{e}</li>)}</ul> : <span className={`pill ${r.status === 'created' ? 'ok' : 'info'}`}>{r.status === 'created' ? 'added' : 'ready'}</span>}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

function IdSeries() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: c } = useQuery({ queryKey: ['company'], queryFn: async () => (await api.get('/company')).data.data as { employeeCodePrefix: string; employeeCodeDigits: number } })
  const [edit, setEdit] = useState<{ prefix: string; digits: number } | null>(null)
  const saveSeries = useMutation({
    mutationFn: () => api.patch('/company', { employeeCodePrefix: edit!.prefix, employeeCodeDigits: edit!.digits }),
    onSuccess: () => { toast('Employee ID series saved'); qc.invalidateQueries({ queryKey: ['company'] }); setEdit(null) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const sample = (p: string, d: number) => `${p}${'1'.padStart(d, '0')}`
  return (
    <section data-card className="card span-4" style={{ padding: 22, display: 'grid', gap: 10, alignContent: 'start' }}>
      <h3 style={{ fontSize: 15 }}>Employee ID series</h3>
      {!c ? <div className="skeleton" style={{ height: 40 }} /> : edit ? (
        <form onSubmit={(e) => { e.preventDefault(); saveSeries.mutate() }} style={{ display: 'grid', gap: 10 }}>
          <label className="field"><span>Prefix</span><input className="input" value={edit.prefix} maxLength={10} onChange={(e) => setEdit({ ...edit, prefix: e.target.value.toUpperCase() })} /></label>
          <label className="field"><span>Digits</span><input className="input" type="number" min={3} max={8} value={edit.digits} onChange={(e) => setEdit({ ...edit, digits: Number(e.target.value) })} /></label>
          <span className="dim" style={{ fontSize: 12 }}>First ID with this prefix: {sample(edit.prefix, edit.digits)}. Existing IDs don’t change.</span>
          <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" disabled={saveSeries.isPending}>Save</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setEdit(null)}>Cancel</button></div>
        </form>
      ) : (
        <>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26 }}>{sample(c.employeeCodePrefix, c.employeeCodeDigits)}</div>
          <span className="dim" style={{ fontSize: 12 }}>New people get the next number after the highest {c.employeeCodePrefix} ID. You can also give your own IDs in the file.</span>
          <button className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => setEdit({ prefix: c.employeeCodePrefix, digits: c.employeeCodeDigits })}>Change</button>
        </>
      )}
    </section>
  )
}

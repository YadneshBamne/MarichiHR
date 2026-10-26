import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import { downloadCsv } from '../../lib/hooks/usePayroll'

const FORMAT_LABELS: Record<string, string> = {
  json: 'JSON (any ERP)', csv: 'CSV (any ERP)', xml: 'XML (any ERP)',
  quickbooks: 'QuickBooks Online journal import', xero: 'Xero manual journal import (check headers once)', tally: 'Tally voucher XML (test on a copy first)',
}
const ACCOUNT_LABELS: Record<string, string> = {
  SALARY_EXPENSE: 'Salary expense (debit)', EMPLOYER_CONTRIB_EXPENSE: 'Employer contributions expense (debit)', REIMBURSEMENT_EXPENSE: 'Reimbursements expense (debit)',
  NET_PAYABLE: 'Net salaries payable (credit)', TAX_PAYABLE: 'Tax payable (credit)', DEDUCTIONS_PAYABLE: 'Other deductions payable (credit)', EMPLOYER_CONTRIB_PAYABLE: 'Employer contributions payable (credit)',
}
type Acc = { code: string; name: string }
type Settings = { accounts: Record<string, Acc>; deductionAccounts: Record<string, Acc>; splitBy: string; webhookUrl: string | null; hasSecret: boolean; autoPush: boolean; formats: string[] }

export default function AccountingExportModal({ cycleId, open, onClose }: { cycleId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: s } = useQuery({ queryKey: ['accounting-settings'], enabled: open, queryFn: async () => (await api.get('/payroll/accounting/settings')).data.data as Settings })
  const [tab, setTab] = useState<'export' | 'settings'>('export')
  const [format, setFormat] = useState('json')
  const [draft, setDraft] = useState<Settings | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (s) setDraft(s) }, [s])
  const err = (e: any, f: string) => setMsg({ ok: false, text: e?.response?.data?.message || f })

  const save = useMutation({
    mutationFn: async (rotateSecret: boolean) => (await api.put('/payroll/accounting/settings', { accounts: draft!.accounts, splitBy: draft!.splitBy, webhookUrl: draft!.webhookUrl || null, autoPush: draft!.autoPush, ...(rotateSecret && { rotateSecret: true }) })).data.data,
    onSuccess: (d) => { qc.invalidateQueries({ queryKey: ['accounting-settings'] }); setSecret(d.webhookSecret ?? ''); setMsg({ ok: true, text: 'Saved' }) },
    onError: (e) => err(e, 'Could not save'),
  })
  const push = useMutation({
    mutationFn: async () => (await api.post(`/payroll/cycles/${cycleId}/journal/push`)).data.data,
    onSuccess: (d) => setMsg({ ok: true, text: `Sent ${d.journalRef} (HTTP ${d.status})` }),
    onError: (e) => err(e, 'The ERP did not accept the journal'),
  })
  const download = async () => {
    setMsg(null); setBusy(true)
    try { await downloadCsv(`/payroll/cycles/${cycleId}/journal`, { format }) } catch (e) { err(e, 'Export failed') } finally { setBusy(false) }
  }
  const setAcc = (k: string, f: keyof Acc, v: string) => setDraft((d) => d && { ...d, accounts: { ...d.accounts, [k]: { ...d.accounts[k], [f]: v } } })

  return (
    <Modal open={open} onClose={onClose} title="Accounting export" width={680}>
      <div className="chips" style={{ marginBottom: 14 }}>
        <button className={`chip${tab === 'export' ? ' is-on' : ''}`} onClick={() => setTab('export')}>Export</button>
        <button className={`chip${tab === 'settings' ? ' is-on' : ''}`} onClick={() => setTab('settings')}>Accounts &amp; ERP</button>
      </div>
      {msg && <div className={`pill ${msg.ok ? 'ok' : 'danger'}`} style={{ marginBottom: 12, display: 'block', whiteSpace: 'normal' }}>{msg.text}</div>}
      {!draft ? <div className="skeleton" style={{ height: 120 }} /> : tab === 'export' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--faint)', margin: 0 }}>One balanced journal for this run, posted to your own account codes{draft.splitBy !== 'none' ? `, split by ${draft.splitBy}` : ''}.</p>
          <select className="input" value={format} onChange={(e) => setFormat(e.target.value)}>
            {draft.formats.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f] ?? f}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={download} disabled={busy}>{busy ? 'Preparing...' : 'Download'}</button>
            <button className="btn btn-ghost" onClick={() => push.mutate()} disabled={!draft.webhookUrl || push.isPending} title={draft.webhookUrl ? '' : 'Set the ERP address under Accounts & ERP'}>{push.isPending ? 'Sending...' : 'Send to ERP'}</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <table className="tbl">
            <thead><tr><th>Posting</th><th>Account code</th><th>Account name</th></tr></thead>
            <tbody>
              {Object.keys(draft.accounts).map((k) => (
                <tr key={k}>
                  <td style={{ fontSize: 12 }}>{ACCOUNT_LABELS[k] ?? k}</td>
                  <td><input className="input" value={draft.accounts[k].code} onChange={(e) => setAcc(k, 'code', e.target.value)} style={{ width: 100 }} /></td>
                  <td><input className="input" value={draft.accounts[k].name} onChange={(e) => setAcc(k, 'name', e.target.value)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <label style={{ fontSize: 13 }}>Split lines by{' '}
            <select className="input" value={draft.splitBy} onChange={(e) => setDraft({ ...draft, splitBy: e.target.value })} style={{ width: 'auto' }}>
              <option value="none">Nothing (one line per account)</option><option value="department">Department</option><option value="entity">Legal entity</option>
            </select>
          </label>
          <label style={{ fontSize: 13 }}>ERP address (HTTPS, receives a signed JSON journal)
            <input className="input" placeholder="https://erp.example.com/hooks/payroll" value={draft.webhookUrl ?? ''} onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value })} />
          </label>
          <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={draft.autoPush} onChange={(e) => setDraft({ ...draft, autoPush: e.target.checked })} /> Send automatically when a run is paid
          </label>
          {secret && <div className="pill warn" style={{ display: 'block', whiteSpace: 'normal' }}>Signing secret (shown once, give it to your ERP team): <code style={{ userSelect: 'all' }}>{secret}</code></div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={() => save.mutate(false)} disabled={save.isPending}>Save</button>
            {draft.hasSecret && <button className="btn btn-ghost" onClick={() => save.mutate(true)} disabled={save.isPending}>New signing secret</button>}
          </div>
        </div>
      )}
    </Modal>
  )
}

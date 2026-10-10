import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

interface Award { id: string; employeeId: string; employee: string | null; type: string; typeId: string; amount: number; currency: string; reason: string; status: string; nominatedBy: string | null; nominatedByUserId: string; decidedBy: string | null; decisionNote: string | null; payrollCycleId: string | null; createdAt: string }
interface IType { id: string; code: string; name: string; description: string | null; defaultAmount: number | null; maxAmount: number | null; payrollInputTypeId: string | null; active: boolean }

const STATUS: Record<string, string> = { nominated: 'warn', approved: 'info', posted: 'ok', rejected: 'danger', cancelled: 'mute' }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const money = (n: number, c: string) => `${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${c}`

export default function IncentivesPage() {
  const { hasRole, user } = useAuth()
  const isHR = hasRole('hr_admin')
  const canPost = isHR || hasRole('payroll_admin')
  const canNominate = isHR || hasRole('manager')
  const qc = useQueryClient()
  const toast = useToast()
  const [tab, setTab] = useState<'awards' | 'types'>('awards')
  const [status, setStatus] = useState('')
  const [nominating, setNominating] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [posting, setPosting] = useState(false)
  const { data = [], isLoading } = useQuery({ queryKey: ['incentives', status], queryFn: async () => (await api.get('/incentives', { params: status ? { status } : {} })).data.data as Award[] })
  const refresh = () => qc.invalidateQueries({ queryKey: ['incentives'] })
  const decide = useMutation({
    mutationFn: ({ id, approve, note }: { id: string; approve: boolean; note?: string }) => api.post(`/incentives/${id}/${approve ? 'approve' : 'reject'}`, note ? { note } : {}),
    onSuccess: (_r, v) => { toast(v.approve ? 'Approved' : 'Rejected'); refresh() }, onError: (e) => toast(errMsg(e), 'error'),
  })
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/incentives/${id}/cancel`), onSuccess: () => { toast('Cancelled'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const root = useReveal<HTMLDivElement>(tab)
  const approved = data.filter((a) => a.status === 'approved')
  return (
    <div ref={root}>
      <PageHeader title="Incentives" sub={canNominate || canPost ? 'Awards and bonuses, approved by HR and paid through payroll' : 'Awards and bonuses you have received'}
        actions={canNominate ? <button className="btn btn-primary btn-sm" onClick={() => setNominating(true)}><Icon name="gift" size={14} /> Nominate</button> : undefined}>
        <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
          {isHR && ([['awards', 'Awards'], ['types', 'Incentive types']] as const).map(([k, l]) => <button key={k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{l}</button>)}
          {tab === 'awards' && ['', 'nominated', 'approved', 'posted', 'rejected'].map((s) => <button key={s} className="chip" aria-pressed={status === s} onClick={() => { setStatus(s); setPicked([]) }} style={status === s ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{s || 'All'}</button>)}
        </div>
      </PageHeader>

      {tab === 'types' ? <Types /> : (
        <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
          {canPost && approved.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, flexWrap: 'wrap' }}>
              <span className="dim" style={{ fontSize: 13 }}>{picked.length ? `${picked.length} selected` : `${approved.length} approved, not yet paid`}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setPicked(picked.length === approved.length ? [] : approved.map((a) => a.id))}>{picked.length === approved.length ? 'Clear' : 'Select all approved'}</button>
              <button className="btn btn-primary btn-sm" disabled={!picked.length} onClick={() => setPosting(true)}><Icon name="wallet" size={14} /> Post to payroll</button>
            </div>
          )}
          {isLoading ? <div className="skeleton" style={{ height: 140, borderRadius: 14, margin: 8 }} /> : !data.length ? <p className="dim" style={{ padding: 16 }}>No incentives here yet.</p> : (
            <table className="tbl" style={{ width: '100%', minWidth: 760 }}>
              <thead><tr>{canPost && <th style={{ width: 30 }} />}<th>Employee</th><th>Award</th><th style={{ textAlign: 'right' }}>Amount</th><th>Status</th><th>Nominated by</th><th /></tr></thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id}>
                    {canPost && <td>{a.status === 'approved' && <input type="checkbox" aria-label={`Select ${a.employee}`} checked={picked.includes(a.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))} />}</td>}
                    <td style={{ fontWeight: 500 }}>{a.employee}</td>
                    <td><div>{a.type}</div><div className="dim" style={{ fontSize: 12, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.reason}>{a.reason}</div></td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(a.amount, a.currency)}</td>
                    <td><span className={`pill ${STATUS[a.status]}`}>{a.status === 'posted' ? 'in payroll' : a.status}</span>{a.decisionNote && <div className="dim" style={{ fontSize: 11, marginTop: 2 }} title={a.decisionNote}>{a.decidedBy}: {a.decisionNote.slice(0, 40)}</div>}</td>
                    <td className="dim">{a.nominatedBy}</td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {isHR && a.status === 'nominated' && a.nominatedByUserId !== user?.id && <>
                        <button className="btn btn-primary btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, approve: true })}>Approve</button>{' '}
                        <button className="btn btn-ghost btn-sm" disabled={decide.isPending} onClick={() => { const note = prompt('Reason for rejecting'); if (note?.trim()) decide.mutate({ id: a.id, approve: false, note: note.trim() }) }}>Reject</button>
                      </>}
                      {a.status === 'nominated' && (a.nominatedByUserId === user?.id || isHR) && <button className="btn btn-ghost btn-sm" disabled={cancel.isPending} onClick={() => { if (confirm('Cancel this nomination?')) cancel.mutate(a.id) }}>Cancel</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {nominating && <Nominate onClose={() => { setNominating(false); refresh() }} />}
      {posting && <PostToPayroll ids={picked} onClose={(ok) => { setPosting(false); if (ok) { setPicked([]); refresh() } }} />}
    </div>
  )
}

function Nominate({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const { user } = useAuth()
  const { data: types = [] } = useQuery({ queryKey: ['incentive-types'], queryFn: async () => (await api.get('/incentives/types')).data.data as IType[] })
  const { data: people = [] } = useQuery({ queryKey: ['incentive-people'], queryFn: async () => (await api.get('/employees', { params: { limit: 500 } })).data.data as any[] })
  const [f, setF] = useState({ employeeId: '', typeId: '', amount: '', reason: '' })
  const type = types.find((t) => t.id === f.typeId)
  const save = useMutation({
    mutationFn: () => api.post('/incentives', { employeeId: f.employeeId, typeId: f.typeId, amount: Number(f.amount), reason: f.reason.trim() }),
    onSuccess: () => { toast('Nominated. HR will review it.'); onClose() }, onError: (e) => toast(errMsg(e), 'error'),
  })
  const over = !!type?.maxAmount && Number(f.amount) > type.maxAmount
  return (
    <Modal open onClose={onClose} title="Nominate for an incentive">
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Who</span><select className="input" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Choose a person…</option>{people.filter((p) => p.id !== user?.employee?.id).map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName} ({p.employeeCode})</option>)}</select></label>
        <label className="field"><span>Award</span><select className="input" value={f.typeId} onChange={(e) => { const t = types.find((x) => x.id === e.target.value); setF({ ...f, typeId: e.target.value, amount: t?.defaultAmount ? String(t.defaultAmount) : f.amount }) }}><option value="">Choose…</option>{types.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}{t.maxAmount ? ` (up to ${t.maxAmount.toLocaleString()})` : ''}</option>)}</select>{type?.description && <span className="muted" style={{ fontSize: 12 }}>{type.description}</span>}</label>
        <label className="field"><span>Amount</span><input className="input" type="number" min={1} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />{over && <span style={{ color: 'var(--danger)', fontSize: 12 }}>Above the cap of {type!.maxAmount!.toLocaleString()}</span>}</label>
        <label className="field"><span>Why (the person will see this)</span><textarea className="input" rows={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} style={{ height: 'auto', padding: 10 }} maxLength={500} /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={save.isPending || !f.employeeId || !f.typeId || !(Number(f.amount) > 0) || over || f.reason.trim().length < 5} onClick={() => save.mutate()}>Nominate</button>
        </div>
      </div>
    </Modal>
  )
}

function PostToPayroll({ ids, onClose }: { ids: string[]; onClose: (ok: boolean) => void }) {
  const toast = useToast()
  const { data: cycles = [] } = useQuery({ queryKey: ['payroll-cycles'], queryFn: async () => (await api.get('/payroll/cycles')).data.data as any[] })
  const open = cycles.filter((c) => ['draft', 'review'].includes(c.status))
  const [cycleId, setCycleId] = useState('')
  const post = useMutation({
    mutationFn: () => api.post('/incentives/post', { cycleId, incentiveIds: ids }),
    onSuccess: (r) => { toast(`${r.data.data.posted} posted. Approve them under the payroll run's inputs.`); onClose(true) }, onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={() => onClose(false)} title={`Post ${ids.length} award${ids.length === 1 ? '' : 's'} to payroll`}>
      <div style={{ display: 'grid', gap: 12 }}>
        {open.length ? (
          <label className="field"><span>Payroll run (draft or in review)</span><select className="input" value={cycleId} onChange={(e) => setCycleId(e.target.value)}><option value="">Choose…</option>{open.map((c) => <option key={c.id} value={c.id}>{String(c.payPeriodStart).slice(0, 7)} · {c.status}</option>)}</select></label>
        ) : <p className="dim">There is no open payroll run. Create next month’s run under Payroll first.</p>}
        <p className="muted" style={{ fontSize: 12 }}>Each award becomes an earnings line on that run. Payroll still approves them (by someone other than you) before they are paid.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => onClose(false)}>Cancel</button>
          <button className="btn btn-primary" disabled={post.isPending || !cycleId} onClick={() => post.mutate()}>Post</button>
        </div>
      </div>
    </Modal>
  )
}

function Types() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: types = [] } = useQuery({ queryKey: ['incentive-types'], queryFn: async () => (await api.get('/incentives/types')).data.data as IType[] })
  const { data: inputs = [] } = useQuery({ queryKey: ['payroll-input-types'], queryFn: async () => (await api.get('/salary/input-types')).data.data as any[] })
  const earnings = inputs.filter((i) => i.category === 'earnings')
  const [edit, setEdit] = useState<Partial<IType> & { id?: string } | null>(null)
  const save = useMutation({
    mutationFn: async (): Promise<unknown> => {
      const body = { name: edit!.name, description: edit!.description || null, defaultAmount: edit!.defaultAmount ? Number(edit!.defaultAmount) : null, maxAmount: edit!.maxAmount ? Number(edit!.maxAmount) : null, payrollInputTypeId: edit!.payrollInputTypeId || null }
      return edit!.id ? api.patch(`/incentives/types/${edit!.id}`, { ...body, active: edit!.active }) : api.post('/incentives/types', { ...body, code: edit!.code })
    },
    onSuccess: () => { toast('Saved'); setEdit(null); qc.invalidateQueries({ queryKey: ['incentive-types'] }) }, onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
      <div style={{ padding: 8 }}><button className="btn btn-ghost btn-sm" onClick={() => setEdit({ active: true })}><Icon name="plus" size={13} /> New type</button></div>
      <table className="tbl" style={{ width: '100%', minWidth: 620 }}>
        <thead><tr><th>Type</th><th>Default</th><th>Cap</th><th>Paid as</th><th>Status</th><th /></tr></thead>
        <tbody>{types.map((t) => <tr key={t.id}><td><div style={{ fontWeight: 500 }}>{t.name}</div><div className="dim" style={{ fontSize: 12 }}>{t.code}{t.description ? ` · ${t.description}` : ''}</div></td><td className="num">{t.defaultAmount ?? '—'}</td><td className="num">{t.maxAmount ?? '—'}</td><td>{earnings.find((i) => i.id === t.payrollInputTypeId)?.name ?? '—'}</td><td><span className={`pill ${t.active ? 'ok' : 'mute'}`}>{t.active ? 'active' : 'off'}</span></td><td><button className="btn btn-ghost btn-sm" onClick={() => setEdit(t)}>Edit</button></td></tr>)}</tbody>
      </table>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit incentive type' : 'New incentive type'}>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <label className="field"><span>Name</span><input className="input" value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              {!edit.id && <label className="field"><span>Code</span><input className="input" value={edit.code ?? ''} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} placeholder="SPOT" /></label>}
              <label className="field"><span>Default amount</span><input className="input" type="number" min={0} value={edit.defaultAmount ?? ''} onChange={(e) => setEdit({ ...edit, defaultAmount: e.target.value as any })} /></label>
              <label className="field"><span>Cap (max per award)</span><input className="input" type="number" min={0} value={edit.maxAmount ?? ''} onChange={(e) => setEdit({ ...edit, maxAmount: e.target.value as any })} /></label>
              <label className="field"><span>Paid as (payroll earning)</span><select className="input" value={edit.payrollInputTypeId ?? ''} onChange={(e) => setEdit({ ...edit, payrollInputTypeId: e.target.value })}><option value="">Default bonus</option>{earnings.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
            </div>
            <label className="field"><span>Description</span><input className="input" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} maxLength={300} /></label>
            {edit.id && <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={!!edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active (can be used for new nominations)</label>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={save.isPending || !edit.name?.trim() || (!edit.id && !/^[A-Z][A-Z0-9_]{1,29}$/.test(edit.code ?? ''))} onClick={() => save.mutate()}>Save</button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}

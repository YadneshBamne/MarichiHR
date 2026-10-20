import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'
import { fmtDate } from '../../lib/format'

// Leave year end: what will be carried forward, encashed and lapsed for each person, then run it (or roll back the last run)
interface Row { employeeId: string; leaveTypeId: string; employee: string; employeeCode: string; leaveType: string; available: number; carried: number; encashed: number; lapsed: number }
interface Data { yearEnd: string; alreadyRun: boolean; firstYear?: boolean; nextYearEnd?: string; rows: Row[]; totals: { people: number; carried: number; encashed: number; lapsed: number }; runs: { id: string; yearEnd: string; status: string; automatic: boolean; ranAt: string; rolledBackAt: string | null; totals: any }[] }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export default function YearEndPanel() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['leave-year-end'], queryFn: async () => (await api.get('/leave/year-end')).data.data as Data })
  const [confirm, setConfirm] = useState<null | 'run' | string>(null)
  const [show, setShow] = useState(false)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['leave-year-end'] }); qc.invalidateQueries({ queryKey: ['leave'] }) }
  const act = useMutation({
    mutationFn: async (what: string) => (what === 'run' ? api.post('/leave/year-end/run') : api.post(`/leave/year-end/${what}/rollback`)),
    onSuccess: (_r, what) => { toast(what === 'run' ? 'Leave year closed' : 'Year end rolled back'); setConfirm(null); refresh() },
    onError: (e) => { toast(errMsg(e), 'error'); setConfirm(null) },
  })
  if (isLoading || !data) return <div className="skeleton" style={{ height: 120, borderRadius: 14, marginTop: 20 }} />
  const latest = data.runs.find((r) => r.status === 'done')
  const rows = data.rows.filter((r) => r.available !== 0)
  if (data.firstYear) return (
    <section className="card" style={{ padding: 20, marginTop: 20, display: 'grid', gap: 6 }}>
      <h3 style={{ fontSize: 16 }}>Leave year end</h3>
      <p className="dim" style={{ fontSize: 13, margin: 0 }}>Nothing to close yet: this is your company's first leave year. On {data.nextYearEnd ? fmtDate(data.nextYearEnd) : 'the last day of the year'} unused days carry forward up to each type's limit, are paid out up to its encashment limit, and the rest lapse. It runs by itself the next morning.</p>
    </section>
  )
  return (
    <section className="card" style={{ padding: 20, marginTop: 20, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: 16 }}>Leave year end</h3>
          <p className="dim" style={{ fontSize: 13 }}>Closing the year ending {fmtDate(data.yearEnd)}: unused days carry forward up to each type's limit, are paid out up to its encashment limit, and the rest lapse. It runs by itself on the first day of the leave year.</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Preview'} ({data.totals.people} people)</button>
          <button className="btn btn-primary btn-sm" disabled={data.alreadyRun || act.isPending} onClick={() => setConfirm('run')}>{data.alreadyRun ? 'Already closed' : 'Close the year now'}</button>
        </div>
      </div>
      <div className="dim" style={{ fontSize: 13, display: 'flex', gap: 16, flexWrap: 'wrap' }}><span>Carry forward: <b>{data.totals.carried}</b> days</span><span>Encash: <b>{data.totals.encashed}</b> days</span><span>Lapse: <b>{data.totals.lapsed}</b> days</span></div>
      {show && (
        <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}>
          <table className="tbl" style={{ width: '100%', minWidth: 560, fontSize: 13 }}>
            <thead><tr><th>Person</th><th>Leave</th><th style={{ textAlign: 'right' }}>Left</th><th style={{ textAlign: 'right' }}>Carry</th><th style={{ textAlign: 'right' }}>Encash</th><th style={{ textAlign: 'right' }}>Lapse</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={`${r.employeeId}:${r.leaveTypeId}`}><td>{r.employee} <span className="dim">{r.employeeCode}</span></td><td>{r.leaveType}</td><td style={{ textAlign: 'right' }}>{r.available}</td><td style={{ textAlign: 'right' }}>{r.carried}</td><td style={{ textAlign: 'right' }}>{r.encashed}</td><td style={{ textAlign: 'right' }}>{r.lapsed}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {data.runs.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {data.runs.map((r) => (
            <div key={r.id} className="well" style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', fontSize: 13, flexWrap: 'wrap' }}>
              <span>Year ending {fmtDate(r.yearEnd)} · {r.automatic ? 'closed automatically' : 'closed by HR'} {fmtDate(r.ranAt)} · <span className={`pill ${r.status === 'done' ? 'ok' : 'mute'}`}>{r.status === 'done' ? 'done' : 'rolled back'}</span></span>
              {r.id === latest?.id && <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(r.id)}>Roll back</button>}
            </div>
          ))}
        </div>
      )}
      {confirm && (
        <Modal open onClose={() => setConfirm(null)} title={confirm === 'run' ? 'Close the leave year?' : 'Roll back the year end?'}>
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ fontSize: 14 }}>{confirm === 'run' ? `This updates ${data.totals.people} people's balances: ${data.totals.carried} days carried forward, ${data.totals.encashed} encashed and ${data.totals.lapsed} lapsed. Payroll is told what to pay out. You can roll it back.` : 'Balances go back to how they were before the run. Leave taken since then is kept.'}</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="btn btn-ghost" onClick={() => setConfirm(null)}>Cancel</button><button className="btn btn-primary" disabled={act.isPending} onClick={() => act.mutate(confirm)}>{confirm === 'run' ? 'Close the year' : 'Roll back'}</button></div>
          </div>
        </Modal>
      )}
    </section>
  )
}

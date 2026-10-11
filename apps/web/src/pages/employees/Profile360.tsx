import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import Avatar from '../../components/ui/Avatar'
import Icon from '../../components/ui/Icon'
import { fmtDate } from '../../lib/format'

interface Person { id: string; name: string; employeeCode: string; title: string | null; avatarUrl: string | null }
interface Data {
  chain: Person[]; directReports: Person[]
  leave: { type: string; paid: boolean; available: number; used: number; pending: number }[]
  attendanceThisMonth: { days: Record<string, number>; hours: number } | null
  lastPayslip: { month: string; gross: number; net: number; currency: string } | null
  awards: { type: string; amount: number; currency: string; reason: string; at: string }[]
  joined: { hireDate: string; viaRecruitment: { opening: string; source: string; referredBy: string | null } | null }
  exit: { type: string; status: string; lastWorkingDate: string } | null
  history: { action: string; at: string; by: string | null; fields: string[] }[]
  can: { seePay: boolean; seeHistory: boolean }
}

const money = (n: number, c: string) => `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${c}`
const words = (s: string) => s.toLowerCase().replace(/_/g, ' ')
const hhmm = (h: number) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}m`

function Chip({ p, me }: { p: Person; me?: boolean }) {
  const inner = <><Avatar name={p.name} src={p.avatarUrl ?? undefined} size={28} /><span style={{ display: 'grid', lineHeight: 1.2 }}><strong style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</strong><span className="dim" style={{ fontSize: 11 }}>{p.title ?? p.employeeCode}</span></span></>
  const style = { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px 6px 6px', borderRadius: 999, background: me ? 'var(--night)' : 'var(--card-2)', color: me ? 'var(--night-ink)' : 'inherit', border: '1px solid var(--hair)' }
  return me ? <span style={style}>{inner}</span> : <Link to={`/employees/${p.id}`} className="row-link" style={style}>{inner}</Link>
}

export default function Profile360({ employeeId, self }: { employeeId: string; self: Person }) {
  const { data: d, isLoading } = useQuery({ queryKey: ['employee-360', employeeId], queryFn: async () => (await api.get(`/employees/${employeeId}/360`)).data.data as Data })
  if (isLoading || !d) return <div className="skeleton" style={{ height: 220, borderRadius: 18 }} />
  const days = d.attendanceThisMonth?.days ?? {}
  return (
    <div style={{ display: 'grid', gap: 22 }}>
      <section>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Reporting line</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {d.chain.map((p) => <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Chip p={p} /><Icon name="chevronRight" size={14} /></span>)}
          <Chip p={self} me />
        </div>
        {!d.chain.length && <p className="dim" style={{ fontSize: 12, marginTop: 6 }}>Top of the reporting line.</p>}
        {d.directReports.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>{d.directReports.length} direct report{d.directReports.length > 1 ? 's' : ''}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{d.directReports.map((p) => <Chip key={p.id} p={p} />)}</div>
          </div>
        )}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 14 }}>
        <Block title="Joined" icon="calendar">
          <strong>{fmtDate(d.joined.hireDate)}</strong>
          {d.joined.viaRecruitment && <span className="dim" style={{ fontSize: 12 }}>Hired for {d.joined.viaRecruitment.opening} · {words(d.joined.viaRecruitment.source)}{d.joined.viaRecruitment.referredBy ? `, referred by ${d.joined.viaRecruitment.referredBy}` : ''}</span>}
          {d.exit && <span className="pill warn" style={{ justifySelf: 'start' }}>{words(d.exit.type)} · last day {fmtDate(d.exit.lastWorkingDate)} · {words(d.exit.status)}</span>}
        </Block>
        {d.attendanceThisMonth && (
          <Block title="This month" icon="clock">
            <strong>{hhmm(d.attendanceThisMonth.hours)} worked</strong>
            <span className="dim" style={{ fontSize: 12 }}>{Object.entries(days).map(([k, v]) => `${v} ${words(k)}`).join(' · ')}</span>
          </Block>
        )}
        {d.can.seePay && d.lastPayslip && (
          <Block title={`Pay · ${d.lastPayslip.month}`} icon="wallet">
            <strong>{money(d.lastPayslip.net, d.lastPayslip.currency)} net</strong>
            <span className="dim" style={{ fontSize: 12 }}>{money(d.lastPayslip.gross, d.lastPayslip.currency)} gross</span>
          </Block>
        )}
        {d.can.seePay && d.awards.length > 0 && (
          <Block title="Awards" icon="gift">
            {d.awards.map((a, i) => <span key={i} style={{ fontSize: 13 }}><strong style={{ fontWeight: 600 }}>{a.type}</strong> · {money(a.amount, a.currency)}<span className="dim" style={{ display: 'block', fontSize: 11 }}>{a.reason}</span></span>)}
          </Block>
        )}
      </div>

      {d.leave.length > 0 && (
        <section>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Leave balances</h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {d.leave.map((b) => (
              <div key={b.type} style={{ padding: '10px 14px', borderRadius: 14, background: 'var(--card-2)', border: '1px solid var(--hair)', minWidth: 130 }}>
                <div className="dim" style={{ fontSize: 11 }}>{b.type}</div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 24 }}>{b.available}</div>
                <div className="dim" style={{ fontSize: 11 }}>{b.used} used{b.pending ? ` · ${b.pending} pending` : ''}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {d.can.seeHistory && d.history.length > 0 && (
        <section>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Recent changes</h3>
          <div style={{ display: 'grid', gap: 6 }}>
            {d.history.map((h, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, fontSize: 13, flexWrap: 'wrap' }}>
                <span className="dim" style={{ minWidth: 92 }}>{fmtDate(h.at)}</span>
                <span><strong style={{ fontWeight: 600 }}>{words(h.action)}</strong>{h.fields.length > 0 && <span className="dim"> · {h.fields.join(', ')}</span>}{h.by && <span className="dim"> · by {h.by}</span>}</span>
              </div>
            ))}
          </div>
          <Link to={`/audit?entityId=${employeeId}`} className="link" style={{ fontSize: 12, display: 'inline-block', marginTop: 8 }}>Full history in the audit log</Link>
        </section>
      )}
    </div>
  )
}

function Block({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: 16, borderRadius: 16, background: 'var(--card-2)', border: '1px solid var(--hair)', display: 'grid', gap: 6, alignContent: 'start' }}>
      <span className="dim" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name={icon as any} size={13} /> {title}</span>
      {children}
    </div>
  )
}

import { useVariance } from '../../lib/hooks/usePayroll'
import Badge from '../../components/ui/Badge'
import { money } from '../../lib/format'

const FLAG_LABEL: Record<string, string> = {
  net_change_over_threshold: 'Net change > threshold',
  lwp_days: 'LWP days',
  negative_net: 'Negative net',
  manual_input: 'Manual input',
  new_in_cycle: 'New this cycle',
  missing_from_cycle: 'Missing from cycle',
}

export default function VariancePanel({ cycleId, currency }: { cycleId: string; currency: string }) {
  const { data, isLoading } = useVariance(cycleId)
  if (isLoading) return <div style={{ color: 'var(--faint)', fontSize: 13 }}>Loading variance report...</div>
  if (!data) return null

  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--dim)', marginBottom: 12 }}>
        {data.flaggedCount} flagged · threshold ±{data.thresholdPct}% · {data.previousCycleId ? 'compared with previous cycle' : 'no previous cycle to compare'}
      </div>
      <div style={{ backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Employee', 'Net pay', 'Previous', 'Change', 'LWP days', 'Flags'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {data.rows.map((r: any) => (
              <tr key={r.employeeId} style={{ borderBottom: '1px solid var(--well)', backgroundColor: r.flags.length ? 'var(--solid)' : 'var(--card-2)' }}>
                <td style={td}><strong>{r.name}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>{r.employeeCode}</span></td>
                <td style={td}>{money(r.netPay, currency)}</td>
                <td style={td}>{r.previousNetPay == null ? '—' : money(r.previousNetPay, currency)}</td>
                <td style={{ ...td, color: r.changePct == null ? 'var(--faint)' : Math.abs(r.changePct) > data.thresholdPct ? 'var(--danger)' : 'var(--ink)' }}>{r.changePct == null ? '—' : `${r.changePct > 0 ? '+' : ''}${r.changePct}%`}</td>
                <td style={td}>{r.lwpDays || 0}</td>
                <td style={td}><div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{r.flags.map((f: string) => <Badge key={f} label={FLAG_LABEL[f] || f} variant="pending" />)}</div></td>
              </tr>
            ))}
            {data.missing.map((m: any) => (
              <tr key={m.employeeId} style={{ borderBottom: '1px solid var(--well)', backgroundColor: 'var(--danger-bg)' }}>
                <td style={td}><strong>{m.name}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>{m.employeeCode}</span></td>
                <td style={td} colSpan={4}>—</td>
                <td style={td}><Badge label={FLAG_LABEL.missing_from_cycle} variant="rejected" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
const th: React.CSSProperties = { padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, color: 'var(--faint)', borderBottom: '1px solid var(--line)', backgroundColor: 'var(--solid)' }
const td: React.CSSProperties = { padding: '12px 16px', fontSize: 13, color: 'var(--ink)' }

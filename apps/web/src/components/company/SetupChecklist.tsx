import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import Icon from '../ui/Icon'

// "Next steps" for admins, checked live by the server; `app` limits it to one area (e.g. what payroll still needs).
export interface SetupStep { key: string; title: string; detail: string; done: boolean; to: string; app?: string; optional?: boolean }
export function useSetupStatus(enabled = true) {
  return useQuery({ queryKey: ['setup-status'], enabled, staleTime: 30_000, queryFn: async () => (await api.get('/company/setup-status')).data.data as { steps: SetupStep[]; done: number; total: number } })
}

export default function SetupChecklist({ app, title = 'Next steps', compact }: { app?: string; title?: string; compact?: boolean }) {
  const { data } = useSetupStatus()
  if (!data) return <div className="skeleton" style={{ height: 120, borderRadius: 14 }} />
  const steps = app ? data.steps.filter((s) => s.app === app) : data.steps
  const left = steps.filter((s) => !s.done && !s.optional).length
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h3 style={{ fontSize: compact ? 15 : 16 }}>{title}</h3>
        <span className="dim" style={{ fontSize: 12 }}>{left ? `${left} to do` : 'All set'}</span>
      </div>
      <ul style={{ listStyle: 'none', marginTop: 10 }}>
        {steps.map((s) => (
          <li key={s.key} style={{ borderTop: '1px solid var(--line)' }}>
            <Link to={s.to} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}>
              <span aria-label={s.done ? 'done' : 'to do'} style={{ width: 24, height: 24, flexShrink: 0, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: s.done ? 'var(--honey)' : 'transparent', border: s.done ? 'none' : '1.5px solid var(--line-2)' }}>{s.done && <Icon name="check" size={12} stroke={2.4} />}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 500 }}>{s.title}{s.optional && <span className="dim" style={{ fontWeight: 400 }}> · optional</span>}</span>
                <span className="dim" style={{ fontSize: 12 }}>{s.detail}</span>
              </span>
              <Icon name="chevronRight" size={15} className="muted" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

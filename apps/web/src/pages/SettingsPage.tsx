import { Link } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import api from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { useReveal } from '../lib/motion'
import { useToast } from '../components/ui/Toast'
import Icon, { type IconName } from '../components/ui/Icon'

type Tile = { icon: IconName; title: string; body: string; to?: string; status?: { text: string; kind: string }; roles?: string[] }

export default function SettingsPage() {
  const { user } = useAuth()
  const toast = useToast()
  const roles = user?.roles?.map((r) => r.name) ?? []
  const isSys = roles.includes('system_admin')
  const ref = useReveal<HTMLDivElement>()
  const { data: providers } = useQuery({ queryKey: ['auth-providers'], queryFn: async () => (await api.get('/auth/providers')).data.data as { google: boolean } })
  const { data: jobs = [], refetch } = useQuery({ queryKey: ['system-jobs'], enabled: isSys, queryFn: async () => (await api.get('/system/jobs')).data.data as any[] })
  const run = useMutation({
    mutationFn: async (name: string) => (await api.post(`/system/jobs/${name}/run`)).data.data,
    onSuccess: (_d, name) => { toast(`Ran ${name}`); refetch() },
    onError: () => toast('The job could not run', 'error'),
  })

  const tiles: Tile[] = [
    { icon: 'lock', title: 'Security', body: 'Two-factor sign-in with an authenticator app.', to: '/security', status: user?.mfaEnabled ? { text: '2FA on', kind: 'ok' } : { text: '2FA off', kind: 'warn' } },
    { icon: 'sliders', title: 'Leave types', body: 'Accrual, carry-forward and approval rules.', to: '/leave-types', roles: ['hr_admin'] },
    { icon: 'wallet', title: 'Compensation', body: 'Salary structures, formula rules and grade bands.', to: '/compensation', roles: ['hr_admin', 'payroll_admin', 'compliance_officer'] },
    { icon: 'globe', title: 'Google sign-in', body: 'Let people sign in with their Google Workspace account.', status: providers?.google ? { text: 'Connected', kind: 'ok' } : { text: 'Not configured', kind: 'mute' }, roles: ['system_admin', 'hr_admin'] },
    { icon: 'mail', title: 'Email delivery', body: 'Send notifications by email through Resend.', status: { text: 'Log only', kind: 'mute' }, roles: ['system_admin', 'hr_admin'] },
    { icon: 'bell', title: 'Notification preferences', body: 'Choose which updates reach you and how.', status: { text: 'Soon', kind: 'honey' } },
    { icon: 'briefcase', title: 'Company profile', body: 'Legal entities, logo, fiscal year and locations.', status: { text: 'Soon', kind: 'honey' }, roles: ['system_admin', 'hr_admin'] },
    { icon: 'shield', title: 'Roles & permissions', body: 'Who can see and approve what.', status: { text: 'Soon', kind: 'honey' }, roles: ['system_admin'] },
  ].filter((t) => !t.roles || t.roles.some((r) => roles.includes(r)))

  return (
    <div ref={ref}>
      <header data-rise style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 'clamp(32px, 4vw, 44px)' }}>Settings</h1>
        <p className="dim" style={{ marginTop: 4 }}>Your account and, if you administer it, the workspace.</p>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 'var(--gap)' }}>
        {tiles.map((t) => {
          const body = (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ width: 42, height: 42, borderRadius: '50%', background: t.to ? 'var(--honey)' : 'var(--well)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={t.icon} size={19} /></span>
                {t.status ? <span className={`pill ${t.status.kind}`}>{t.status.text}</span> : <Icon name="arrowUpRight" size={18} className="muted" />}
              </div>
              <h2 style={{ fontSize: 20, marginTop: 18 }}>{t.title}</h2>
              <p className="dim" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{t.body}</p>
            </>
          )
          return t.to
            ? <Link key={t.title} to={t.to} data-card className="card lift" style={{ padding: 22, display: 'block' }}>{body}</Link>
            : <div key={t.title} data-card className="card" style={{ padding: 22, opacity: 0.85 }}>{body}</div>
        })}
      </div>

      {isSys && (
        <section data-card className="card" style={{ marginTop: 'var(--gap)', padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ fontSize: 22 }}>Scheduled jobs</h2>
            <span className="muted" style={{ fontSize: 12 }}>Times are UTC. Running a job now only affects this organisation.</span>
          </div>
          <table className="tbl" style={{ marginTop: 10 }}>
            <thead><tr><th>Job</th><th>What it does</th><th>Schedule</th><th>Next run</th><th /></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.name}>
                  <td style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{j.name}</td>
                  <td className="dim">{j.description}</td>
                  <td><code style={{ fontSize: 12 }}>{j.pattern}</code></td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>{j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : <span className="pill warn">Not scheduled</span>}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn btn-ghost btn-sm" disabled={run.isPending} onClick={() => run.mutate(j.name)}><Icon name="play" size={13} /> Run now</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

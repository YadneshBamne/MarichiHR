import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import PageHeader from '../components/ui/PageHeader'
import { useToast } from '../components/ui/Toast'
import { useReveal } from '../lib/motion'

// Per-person delivery choices. The bell always keeps every notification; these switch email / WhatsApp per category.
// Mandatory categories (pay, policies) always go out on every channel the company has switched on.
interface Category { key: string; label: string; hint: string; mandatory: boolean; email: boolean; whatsapp: boolean }
interface Prefs { channels: { email: boolean; whatsapp: boolean }; categories: Category[] }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export default function NotificationSettingsPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['notify-prefs'], queryFn: async () => (await api.get('/notifications/preferences')).data.data as Prefs })
  const root = useReveal<HTMLDivElement>(isLoading)
  const save = useMutation({
    mutationFn: (c: Category) => api.put('/notifications/preferences', { prefs: { [c.key]: { email: c.email, whatsapp: c.whatsapp } } }),
    onSuccess: () => { toast('Saved'); qc.invalidateQueries({ queryKey: ['notify-prefs'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const channels = data ? (['email', 'whatsapp'] as const).filter((c) => data.channels[c]) : []
  return (
    <div ref={root}>
      <PageHeader title="Notification settings" sub="Everything always lands in the bell. Choose what else reaches you by email or WhatsApp." />
      {isLoading || !data ? <div className="skeleton" style={{ height: 220, borderRadius: 22 }} /> : (
        <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
          {!channels.length && <p className="dim" style={{ padding: 14, fontSize: 13 }}>Your company has not switched on email or WhatsApp yet, so notifications only appear in the bell. Your choices here apply as soon as it does.</p>}
          <table className="tbl" style={{ width: '100%', minWidth: 480 }}>
            <thead><tr><th>Category</th><th style={{ textAlign: 'center' }}>Bell</th><th style={{ textAlign: 'center' }}>Email</th><th style={{ textAlign: 'center' }}>WhatsApp</th></tr></thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.key}>
                  <td><div style={{ fontWeight: 500 }}>{c.label}{c.mandatory && <span className="pill mute" style={{ marginLeft: 8 }}>Always on</span>}</div><div className="dim" style={{ fontSize: 12 }}>{c.hint}</div></td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" checked disabled aria-label={`${c.label} in the bell`} /></td>
                  {(['email', 'whatsapp'] as const).map((ch) => (
                    <td key={ch} style={{ textAlign: 'center' }}>
                      <input type="checkbox" aria-label={`${c.label} by ${ch}`} checked={c.mandatory || c[ch]} disabled={c.mandatory || save.isPending} onChange={(e) => save.mutate({ ...c, [ch]: e.target.checked })} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import PageHeader from '../components/ui/PageHeader'
import { useToast } from '../components/ui/Toast'
import { useReveal } from '../lib/motion'

// Per-person delivery choices. The bell always keeps every notification; these switch email / WhatsApp / push per
// category. Mandatory categories (pay, policies) always go out on every channel the company has switched on.
type Ch = 'email' | 'whatsapp' | 'push'
interface Category { key: string; label: string; hint: string; mandatory: boolean; email: boolean; whatsapp: boolean; push: boolean }
interface Prefs { channels: Record<Ch, boolean>; devices: number; categories: Category[] }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const LABEL: Record<Ch, string> = { email: 'Email', whatsapp: 'WhatsApp', push: 'Push' }

// The VAPID key arrives base64url; the browser wants bytes
const toBytes = (b64: string) => { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)) }

function ThisDevice({ onChange }: { onChange: () => void }) {
  const toast = useToast()
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const [sub, setSub] = useState<PushSubscription | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (supported) navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then(setSub).catch(() => null) }, [supported])
  if (!supported) return <p className="dim" style={{ fontSize: 13 }}>This browser can’t show push notifications. On a phone, install MarichiHR to the home screen first.</p>
  const on = async () => {
    setBusy(true)
    try {
      if ((await Notification.requestPermission()) !== 'granted') { toast('Notifications are blocked for this site in your browser settings', 'error'); return }
      const key = (await api.get('/notifications/push/key')).data.data.key
      if (!key) { toast('Push is not set up on the server yet', 'error'); return }
      const reg = await navigator.serviceWorker.ready
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) })
      await api.post('/notifications/push/subscribe', s.toJSON())
      setSub(s); onChange(); toast('Push notifications on for this device')
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const off = async () => {
    if (!sub) return
    setBusy(true)
    try { await api.post('/notifications/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); setSub(null); onChange(); toast('Push off for this device') } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 14, flex: 1 }}>{sub ? 'This device gets push notifications.' : 'Get notifications on this phone or computer, even when MarichiHR is closed.'}</span>
      {sub ? <button className="btn btn-ghost btn-sm" disabled={busy} onClick={off}>Turn off here</button> : <button className="btn btn-primary btn-sm" disabled={busy} onClick={on}>Turn on for this device</button>}
    </div>
  )
}

export default function NotificationSettingsPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['notify-prefs'], queryFn: async () => (await api.get('/notifications/preferences')).data.data as Prefs })
  const root = useReveal<HTMLDivElement>(isLoading)
  const save = useMutation({
    mutationFn: (c: Category) => api.put('/notifications/preferences', { prefs: { [c.key]: { email: c.email, whatsapp: c.whatsapp, push: c.push } } }),
    onSuccess: () => { toast('Saved'); qc.invalidateQueries({ queryKey: ['notify-prefs'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const channels = data ? (['email', 'whatsapp', 'push'] as const).filter((c) => data.channels[c]) : []
  return (
    <div ref={root}>
      <PageHeader title="Notification settings" sub="Everything always lands in the bell. Choose what else reaches you by email, WhatsApp or push." />
      {isLoading || !data ? <div className="skeleton" style={{ height: 220, borderRadius: 22 }} /> : (
        <div style={{ display: 'grid', gap: 'var(--gap)' }}>
          {data.channels.push && <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 6 }}><h3 style={{ fontSize: 16 }}>Push notifications</h3><ThisDevice onChange={() => qc.invalidateQueries({ queryKey: ['notify-prefs'] })} />{data.devices > 0 && <span className="dim" style={{ fontSize: 12 }}>On for {data.devices} device{data.devices === 1 ? '' : 's'}.</span>}</section>}
          <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
            {!channels.length && <p className="dim" style={{ padding: 14, fontSize: 13 }}>Your company has not switched on email, WhatsApp or push yet, so notifications only appear in the bell. Your choices here apply as soon as it does.</p>}
            <table className="tbl" style={{ width: '100%', minWidth: 480 }}>
              <thead><tr><th>Category</th><th style={{ textAlign: 'center' }}>Bell</th>{channels.map((ch) => <th key={ch} style={{ textAlign: 'center' }}>{LABEL[ch]}</th>)}</tr></thead>
              <tbody>
                {data.categories.map((c) => (
                  <tr key={c.key}>
                    <td><div style={{ fontWeight: 500 }}>{c.label}{c.mandatory && <span className="pill mute" style={{ marginLeft: 8 }}>Always on</span>}</div><div className="dim" style={{ fontSize: 12 }}>{c.hint}</div></td>
                    <td style={{ textAlign: 'center' }}><input type="checkbox" checked disabled aria-label={`${c.label} in the bell`} /></td>
                    {channels.map((ch) => (
                      <td key={ch} style={{ textAlign: 'center' }}>
                        <input type="checkbox" aria-label={`${c.label} by ${LABEL[ch]}`} checked={c.mandatory || c[ch]} disabled={c.mandatory || save.isPending} onChange={(e) => save.mutate({ ...c, [ch]: e.target.checked })} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  )
}

import webpush from 'web-push'
import { prisma } from '../database/prisma'

// Web Push (browser and installed-app notifications on phones and computers). Needs VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY and VAPID_SUBJECT, and is off unless PUSH_ENABLED=true (not offered for now; code kept). A subscription the push service reports as
// gone (404/410) is removed.
let configured: boolean | null = null
export function pushEnabled() {
  if (configured === null) {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env
    configured = process.env.PUSH_ENABLED === 'true' && !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
    if (configured) webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:admin@example.com', VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!)
  }
  return configured
}
export const pushPublicKey = () => (pushEnabled() ? process.env.VAPID_PUBLIC_KEY! : null)

export async function subscribe(tenantId: string, userId: string, s: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string) {
  await prisma.pushSubscription.upsert({
    where: { endpoint: s.endpoint },
    update: { tenantId, userId, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: userAgent?.slice(0, 200) ?? null },
    create: { tenantId, userId, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: userAgent?.slice(0, 200) ?? null },
  })
}
export async function unsubscribe(userId: string, endpoint: string) {
  await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } })
}

// One push to each of the person's devices; returns how many got it
export async function pushTo(userId: string, msg: { title: string; body: string; link?: string | null }) {
  if (!pushEnabled()) return { sent: 0, devices: 0 }
  const subs = await prisma.pushSubscription.findMany({ where: { userId } })
  let sent = 0
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: msg.title, body: msg.body.slice(0, 300), link: msg.link ?? '/' }), { TTL: 86_400 })
      sent++
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => null)
    }
  }
  return { sent, devices: subs.length }
}

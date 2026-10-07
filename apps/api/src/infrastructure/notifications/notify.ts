import { prisma } from '../database/prisma'

// In-app notification rows plus outbound delivery over pluggable transports.
// Channels: NOTIFY_CHANNELS (default "email"). Email transport: EMAIL_TRANSPORT = log (default) | resend.
// WhatsApp is an adapter that needs WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID (Meta Cloud API) before it can send.

export interface OutboundMessage {
  to: { name: string; email?: string | null; phone?: string | null }
  subject: string
  text: string
}

export interface Transport {
  name: string
  send(msg: OutboundMessage): Promise<void>
}

export const logTransport: Transport = {
  name: 'log',
  async send(msg) {
    console.log(`[notify:email:log] to=${msg.to.email} subject="${msg.subject}"`)
  },
}

export const resendTransport: Transport = {
  name: 'resend',
  async send(msg) {
    if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) throw new Error('Resend is not configured (RESEND_API_KEY, EMAIL_FROM)')
    if (!msg.to.email) throw new Error('Recipient has no email address')
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [msg.to.email], subject: msg.subject, text: msg.text }),
    })
    if (!res.ok) throw new Error(`Resend responded ${res.status}`)
  },
}

export const whatsappTransport: Transport = {
  name: 'whatsapp',
  async send(msg) {
    const token = process.env.WHATSAPP_TOKEN
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID
    if (!token || !phoneId) throw new Error('WhatsApp is not configured (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID)')
    if (!msg.to.phone) throw new Error('Recipient has no mobile number')
    // ponytail: free-form text only reaches users inside the 24h service window; outside it Meta requires an approved template
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: msg.to.phone.replace(/[^\d]/g, ''), type: 'text', text: { body: `${msg.subject}\n${msg.text}` } }),
    })
    if (!res.ok) throw new Error(`WhatsApp responded ${res.status}`)
  },
}

function transportsFor(): Record<string, Transport> {
  const channels = (process.env.NOTIFY_CHANNELS || 'email').split(',').map((c) => c.trim()).filter(Boolean)
  const out: Record<string, Transport> = {}
  for (const c of channels) {
    if (c === 'email') out.email = process.env.EMAIL_TRANSPORT === 'resend' ? resendTransport : logTransport
    if (c === 'whatsapp') out.whatsapp = whatsappTransport
  }
  return out
}

export interface NotifyInput {
  tenantId: string
  userIds: string[]
  type: string
  title: string
  body: string
  link?: string
  entityType?: string
  entityId?: string
  eventId?: string
}

export async function notify(input: NotifyInput) {
  const userIds = [...new Set(input.userIds.filter(Boolean))]
  if (!userIds.length) return []
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, tenantId: input.tenantId, active: true },
    select: { id: true, email: true, fullName: true, employee: { select: { mobileWork: true, mobilePersonal: true } } },
  })
  const transports = transportsFor()
  const created = []

  for (const user of users) {
    // A retried event never notifies the same person twice
    if (input.eventId) {
      const existing = await prisma.notification.findUnique({
        where: { eventId_userId_type: { eventId: input.eventId, userId: user.id, type: input.type } },
      })
      if (existing) continue
    }
    const row = await prisma.notification.create({
      data: {
        tenantId: input.tenantId, userId: user.id, type: input.type, title: input.title, body: input.body,
        link: input.link, entityType: input.entityType, entityId: input.entityId, eventId: input.eventId,
      },
    })

    const deliveries = []
    for (const [channel, transport] of Object.entries(transports)) {
      const msg: OutboundMessage = {
        to: { name: user.fullName, email: user.email, phone: user.employee?.mobileWork || user.employee?.mobilePersonal },
        subject: input.title,
        text: input.body,
      }
      try {
        await transport.send(msg)
        deliveries.push({ channel, transport: transport.name, status: 'sent', at: new Date().toISOString() })
      } catch (err: any) {
        deliveries.push({ channel, transport: transport.name, status: 'failed', error: String(err?.message || err) })
      }
    }
    created.push(await prisma.notification.update({ where: { id: row.id }, data: { deliveries } }))
  }
  return created
}

// ─── Recipient lookups ────────────────────────────────────────
export async function userIdsWithRole(tenantId: string, roleName: string) {
  const rows = await prisma.userRole.findMany({
    where: {
      role: { tenantId, name: roleName },
      user: { tenantId, active: true },
      OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
    },
    select: { userId: true },
  })
  return rows.map((r) => r.userId)
}

export async function userIdOfEmployee(tenantId: string, employeeId?: string | null) {
  if (!employeeId) return null
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { userId: true } })
  return emp?.userId ?? null
}

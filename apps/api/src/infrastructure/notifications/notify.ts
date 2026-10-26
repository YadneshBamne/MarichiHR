import nodemailer from 'nodemailer'
import { prisma } from '../database/prisma'
import { wants } from './preferences'
import { pushEnabled, pushTo } from './push'
import { templateFor, waVar, detailFor } from './whatsapp-templates'

// In-app notification rows plus outbound delivery over pluggable transports.
// Channels: NOTIFY_CHANNELS (default "email"). Email transport: EMAIL_TRANSPORT = log (default) | smtp | resend.
// SMTP (e.g. Mandrill): SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM.
// WhatsApp is an adapter that needs WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID (Meta Cloud API) before it can send.

export interface OutboundMessage {
  to: { name: string; email?: string | null; phone?: string | null }
  subject: string
  text: string
  attachments?: { filename: string; content: Buffer }[] // email only
  type?: string // notification type: picks the WhatsApp template
  link?: string | null // page in the app: the WhatsApp button opens it
}

export interface Transport {
  name: string
  send(msg: OutboundMessage): Promise<void>
}

export const logTransport: Transport = {
  name: 'log',
  async send(msg) {
    console.log(`[notify:email:log] to=${msg.to.email} subject="${msg.subject}"${msg.attachments?.length ? ` attachments=${msg.attachments.map((a) => a.filename).join(',')}` : ''}`)
  },
}

// One pooled SMTP connection per process (Mandrill, or any SMTP relay)
let smtp: ReturnType<typeof nodemailer.createTransport> | null = null
export function smtpClient() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) throw new Error('SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS)')
  smtp ??= nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT) || 587, secure: SMTP_SECURE === 'true', auth: { user: SMTP_USER, pass: SMTP_PASS }, pool: true, maxConnections: 3 })
  return smtp
}
export const smtpTransport: Transport = {
  name: 'smtp',
  async send(msg) {
    if (!process.env.SMTP_FROM) throw new Error('SMTP_FROM is not set')
    if (!msg.to.email) throw new Error('Recipient has no email address')
    await smtpClient().sendMail({
      from: { name: process.env.SMTP_FROM_NAME || 'MarichiHR', address: process.env.SMTP_FROM },
      to: { name: msg.to.name, address: msg.to.email },
      subject: msg.subject,
      text: `${msg.text}\n\n— MarichiHR`,
      ...(msg.attachments?.length && { attachments: msg.attachments.map((a) => ({ filename: a.filename, content: a.content })) }),
    })
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
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [msg.to.email], subject: msg.subject, text: msg.text, ...(msg.attachments?.length && { attachments: msg.attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })) }) }),
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
    // Business-started messages must use an approved template (whatsapp-templates.ts): {{1}} first name, {{2}} detail,
    // and a URL button whose suffix is the page to open
    const t = templateFor(msg.type ?? '')
    const firstName = waVar(msg.to.name.split(' ')[0] || msg.to.name, 60)
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: msg.to.phone.replace(/[^\d]/g, ''), type: 'template',
        template: {
          name: t.name, language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: firstName }, { type: 'text', text: waVar(detailFor(msg.type ?? '', msg.subject)) }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: (msg.link ?? '/dashboard').replace(/^\//, '') || 'dashboard' }] },
          ],
        },
      }),
    })
    if (!res.ok) throw new Error(`WhatsApp responded ${res.status}`)
  },
}

function transportsFor(): Record<string, Transport> {
  const channels = (process.env.NOTIFY_CHANNELS || 'email').split(',').map((c) => c.trim()).filter(Boolean)
  const out: Record<string, Transport> = {}
  for (const c of channels) {
    if (c === 'email') out.email = process.env.EMAIL_TRANSPORT === 'smtp' ? smtpTransport : process.env.EMAIL_TRANSPORT === 'resend' ? resendTransport : logTransport
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
  // Built only when an email is actually sent (e.g. a payslip PDF); one recipient per call
  attachments?: () => Promise<{ filename: string; content: Buffer }[]>
}

export async function notify(input: NotifyInput) {
  const userIds = [...new Set(input.userIds.filter(Boolean))]
  if (!userIds.length) return []
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, tenantId: input.tenantId, active: true },
    select: { id: true, email: true, fullName: true, notifyPrefs: true, employee: { select: { mobileWork: true, mobilePersonal: true } } },
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
    let attachments: { filename: string; content: Buffer }[] | undefined
    for (const [channel, transport] of Object.entries(transports)) {
      if (!wants(user.notifyPrefs, input.type, channel as 'email' | 'whatsapp')) {
        deliveries.push({ channel, transport: transport.name, status: 'skipped', reason: 'preference' })
        continue
      }
      const msg: OutboundMessage = {
        to: { name: user.fullName, email: user.email, phone: user.employee?.mobileWork || user.employee?.mobilePersonal },
        subject: input.title,
        text: input.body,
        type: input.type,
        link: input.link ?? null,
      }
      if (channel === 'email' && input.attachments) {
        try { attachments ??= await input.attachments(); msg.attachments = attachments } catch (err: any) { deliveries.push({ channel, transport: transport.name, status: 'attachment_failed', error: String(err?.message || err) }) }
      }
      try {
        await transport.send(msg)
        deliveries.push({ channel, transport: transport.name, status: 'sent', at: new Date().toISOString() })
      } catch (err: any) {
        deliveries.push({ channel, transport: transport.name, status: 'failed', error: String(err?.message || err) })
      }
    }
    // Push to the person's phones and browsers that asked for it
    if (pushEnabled() && wants(user.notifyPrefs, input.type, 'push')) {
      const p = await pushTo(user.id, { title: input.title, body: input.body, link: input.link })
      if (p.devices) deliveries.push({ channel: 'push', transport: 'webpush', status: p.sent ? 'sent' : 'failed', devices: p.devices, at: new Date().toISOString() })
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

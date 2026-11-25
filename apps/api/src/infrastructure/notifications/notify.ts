import nodemailer from 'nodemailer'
import { prisma } from '../database/prisma'
import { wants } from './preferences'
import { pushEnabled, pushTo } from './push'
import { templateFor, waVar, detailFor } from './whatsapp-templates'

// In-app notification rows plus outbound delivery over pluggable transports.
// Channels: NOTIFY_CHANNELS (default "email"). Email transport: EMAIL_TRANSPORT = log (default) | smtp | mandrill (HTTPS, for hosts that block SMTP) | resend.
// SMTP (e.g. Mandrill): SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM.
// WhatsApp is an adapter that needs WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID (Meta Cloud API) before it can send.

export interface OutboundMessage {
  to: { name: string; email?: string | null; phone?: string | null }
  subject: string
  text: string
  attachments?: { filename: string; content: Buffer }[] // email only
  type?: string // notification type: picks the WhatsApp template
  link?: string | null // page in the app: the WhatsApp button opens it
  button?: string // email only: the button label (default "Open in MarichiHR")
  footer?: string // email only: the small print (default: notification settings)
  raw?: boolean // email only: send the text as written (a letter to someone outside the app), without the greeting, headline and button
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
// The email people get: a greeting, the message, and a button that opens the page in the app (APP_URL, else CLIENT_URL).
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
export function renderEmail(msg: OutboundMessage, base = process.env.APP_URL || process.env.CLIENT_URL || '') {
  const url = msg.link && base ? `${base.replace(/\/$/, '')}${msg.link.startsWith('/') ? '' : '/'}${msg.link}` : null
  if (msg.raw) {
    const small = msg.footer ? `<p style="font-size:12px;color:#8a877e;margin:18px 0 0">${esc(msg.footer)}</p>` : ''
    return { text: msg.text + (msg.footer ? `\n\n${msg.footer}` : ''), html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#252523;font-size:15px;line-height:1.55">${esc(msg.text).replace(/\n/g, '<br>')}${small}</div>` }
  }
  const first = msg.to.name.split(' ')[0] || msg.to.name
  const text = `Hi ${first},\n\n${msg.subject}\n${msg.text}${url ? `\n\nOpen it here: ${url}` : ''}\n\n— MarichiHR`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#252523"><p style="font-size:16px;margin:0 0 14px">Hi ${esc(first)},</p><p style="font-size:15px;line-height:1.55;margin:0 0 18px"><strong>${esc(msg.subject)}</strong><br>${esc(msg.text).replace(/\n/g, '<br>')}</p>${url ? `<p style="margin:0 0 22px"><a href="${esc(url)}" style="display:inline-block;background:#f6c343;color:#252523;padding:11px 22px;border-radius:999px;text-decoration:none;font-weight:600">${esc(msg.button ?? 'Open in MarichiHR')}</a></p>` : ''}<p style="font-size:12px;color:#8a877e;margin:0">${esc(msg.footer ?? 'You get this email because of your notification settings in MarichiHR. You can change them under your account.')}</p></div>`
  return { text, html }
}
export const smtpTransport: Transport = {
  name: 'smtp',
  async send(msg) {
    if (!process.env.SMTP_FROM) throw new Error('SMTP_FROM is not set')
    if (!msg.to.email) throw new Error('Recipient has no email address')
    const body = renderEmail(msg)
    await smtpClient().sendMail({
      from: { name: process.env.SMTP_FROM_NAME || 'MarichiHR', address: process.env.SMTP_FROM },
      to: { name: msg.to.name, address: msg.to.email },
      subject: msg.subject,
      text: body.text,
      html: body.html,
      ...(msg.attachments?.length && { attachments: msg.attachments.map((a) => ({ filename: a.filename, content: a.content })) }),
    })
  },
}

// Mandrill over HTTPS (messages/send): the same account and API key as SMTP, for hosts that block SMTP ports (Railway's Hobby plan blocks 587).
// The key is MANDRILL_API_KEY, else SMTP_PASS (a Mandrill SMTP password is an API key).
const mandrillKey = () => process.env.MANDRILL_API_KEY || process.env.SMTP_PASS
export function mandrillPayload(msg: OutboundMessage) {
  const body = renderEmail(msg)
  return {
    key: mandrillKey(),
    message: {
      from_email: process.env.SMTP_FROM, from_name: process.env.SMTP_FROM_NAME || 'MarichiHR',
      to: [{ email: msg.to.email, name: msg.to.name, type: 'to' }],
      subject: msg.subject, text: body.text, html: body.html,
      ...(msg.attachments?.length && { attachments: msg.attachments.map((a) => ({ type: /\.pdf$/i.test(a.filename) ? 'application/pdf' : /\.ics$/i.test(a.filename) ? 'text/calendar' : 'application/octet-stream', name: a.filename, content: a.content.toString('base64') })) }),
    },
  }
}
export const mandrillTransport: Transport = {
  name: 'mandrill',
  async send(msg) {
    if (!mandrillKey()) throw new Error('Mandrill is not configured (MANDRILL_API_KEY or SMTP_PASS)')
    if (!process.env.SMTP_FROM) throw new Error('SMTP_FROM is not set')
    if (!msg.to.email) throw new Error('Recipient has no email address')
    const res = await fetch('https://mandrillapp.com/api/1.0/messages/send.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mandrillPayload(msg)), signal: AbortSignal.timeout(15000) })
    const out: any = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`Mandrill responded ${res.status}${out?.message ? `: ${out.message}` : ''}`)
    // one entry per recipient: sent and queued are fine, rejected and invalid are not
    const r = Array.isArray(out) ? out[0] : null
    if (r && ['rejected', 'invalid'].includes(r.status)) throw new Error(`Mandrill ${r.status}${r.reject_reason ? ` (${r.reject_reason})` : ''}`)
  },
}
// Login check without sending anything (for the admin email check)
export async function mandrillPing() {
  const res = await fetch('https://mandrillapp.com/api/1.0/users/ping2.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: mandrillKey() }), signal: AbortSignal.timeout(12000) })
  const out: any = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${res.status}${out?.message ? `: ${out.message}` : ''}`)
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

// The email transport chosen by EMAIL_TRANSPORT (also used by mails that are not notifications: password reset, welcome)
export const emailTransport = (): Transport => process.env.EMAIL_TRANSPORT === 'smtp' ? smtpTransport : process.env.EMAIL_TRANSPORT === 'mandrill' ? mandrillTransport : process.env.EMAIL_TRANSPORT === 'resend' ? resendTransport : logTransport

function transportsFor(): Record<string, Transport> {
  const channels = (process.env.NOTIFY_CHANNELS || 'email').split(',').map((c) => c.trim()).filter(Boolean)
  const out: Record<string, Transport> = {}
  for (const c of channels) {
    if (c === 'email') out.email = emailTransport()
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

if (require.main === module) {
  const m = renderEmail({ to: { name: 'Dan Zulu' }, subject: 'Leave <request> waiting', text: 'Open Approvals.', link: '/approvals' }, 'https://app.example.com/')
  console.assert(m.html.includes('href="https://app.example.com/approvals"') && m.text.includes('https://app.example.com/approvals'), 'the button and the text both carry the full link')
  console.assert(!m.html.includes('<request>') && m.html.includes('&lt;request&gt;'), 'message text is escaped in the html')
  console.assert(!renderEmail({ to: { name: 'A' }, subject: 's', text: 't' }, '').html.includes('<a '), 'no link, no button')
  console.log('notify email self-check done')
}

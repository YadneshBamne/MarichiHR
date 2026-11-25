import { Router, RequestHandler } from 'express'
import multer from 'multer'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { z } from 'zod'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { prisma } from '../../infrastructure/database/prisma.stub' // a .mongo file needs the stub to get the Prisma-compatible client
import { storage, storageConfigured } from '../../infrastructure/storage/storage'
import { emailTransport, type OutboundMessage } from '../../infrastructure/notifications/notify'
import { recruitmentService } from './recruitment.service'

// Recruitment extras (MongoDB API only), mounted in front of the main recruitment router:
//  - email templates HR can edit per company, a preview, and an explicit Send (never silent); every send is logged in the candidate's history
//  - a calendar file (.ics) for each interview, attached to the interview email
//  - a CV uploaded as a file (PDF or Word, up to 5 MB), private, opened only through a short-lived signed link
export const recruitmentExtrasRouter = Router()

const isHR = (roleIds: string[]) => roleIds.includes('hr_admin')
const idp = z.object({ id: z.string().uuid() })
const col = () => mongoose.connection.collection('recruitment_templates')

// ─── Templates ───
export const PLACEHOLDERS = ['candidate', 'role', 'company', 'date', 'time', 'mode', 'link', 'pay', 'joining', 'note'] as const
export const TEMPLATE_KEYS = ['interview', 'rejection', 'offer', 'application_received'] as const
type Key = (typeof TEMPLATE_KEYS)[number]
export const DEFAULTS: Record<Key, { label: string; subject: string; body: string }> = {
  interview: {
    label: 'Interview invitation',
    subject: 'Interview for {role} at {company}',
    body: 'Dear {candidate},\n\nThank you for applying for the {role} role at {company}. We would like to invite you to an interview.\n\nDate: {date}\nTime: {time}\nHow: {mode}\nMeeting link: {link}\n\nA calendar invitation is attached. Please reply to this email if you cannot make it.\n\nKind regards,\n{company}',
  },
  rejection: {
    label: 'Rejection',
    subject: 'Your application for {role} at {company}',
    body: 'Dear {candidate},\n\nThank you for your interest in the {role} role at {company} and for the time you put into your application. After careful consideration we have decided not to take your application further at this time.\n\nWe will keep your details on file and wish you every success.\n\nKind regards,\n{company}',
  },
  application_received: {
    label: 'Application received (sent automatically from the careers page)',
    subject: 'We received your application: {role} at {company}',
    body: 'Dear {candidate},\n\nThank you for applying for the {role} role at {company}. We have received your application and our team will review it. If your profile matches what we are looking for, we will contact you about the next steps.\n\nYou do not need to do anything else for now.\n\nKind regards,\n{company}',
  },
  offer: {
    label: 'Offer',
    subject: 'Offer of employment: {role} at {company}',
    body: 'Dear {candidate},\n\nWe are delighted to offer you the position of {role} at {company}.\n\nYearly pay: {pay}\nProposed joining date: {joining}\n\n{note}\n\nPlease reply to this email to accept the offer. The offer is subject to the usual checks and documents.\n\nKind regards,\n{company}',
  },
}

// Fills {placeholders}. A line whose placeholder has no value (no meeting link, no note) is dropped, so mail never shows an empty label.
export function render(text: string, vars: Record<string, string>) {
  return text.split('\n').filter((line) => ![...line.matchAll(/\{(\w+)\}/g)].some((m) => m[1] in vars && !vars[m[1]])).map((line) => line.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? vars[k] : all))).join('\n').replace(/\n{3,}/g, '\n\n')
}
const unknownPlaceholder = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).find((k) => !(PLACEHOLDERS as readonly string[]).includes(k))

export async function templateFor(tenantId: string, key: Key) {
  const mine: any = await col().findOne({ _id: `${tenantId}:${key}` } as any)
  return { key, label: DEFAULTS[key].label, subject: mine?.subject ?? DEFAULTS[key].subject, body: mine?.body ?? DEFAULTS[key].body, custom: !!mine, defaultSubject: DEFAULTS[key].subject, defaultBody: DEFAULTS[key].body }
}

recruitmentExtrasRouter.get('/templates', asyncHandler(async (req, res) => {
  if (!isHR(req.user!.roleIds)) throw new AppError('Only HR edits the email templates', 403)
  res.json({ success: true, data: { placeholders: PLACEHOLDERS, templates: await Promise.all(TEMPLATE_KEYS.map((k) => templateFor(req.user!.tenantId, k))) } })
}))
recruitmentExtrasRouter.put('/templates/:key', validate(z.object({ params: z.object({ key: z.enum(TEMPLATE_KEYS) }), body: z.object({ subject: z.string().trim().min(3).max(200), body: z.string().trim().min(10).max(5000) }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId, roleIds } = req.user!
  if (!isHR(roleIds)) throw new AppError('Only HR edits the email templates', 403)
  const bad = unknownPlaceholder(req.body.subject) ?? unknownPlaceholder(req.body.body)
  if (bad) throw new AppError(`{${bad}} is not a placeholder. Use: ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}`, 400)
  const key = String(req.params.key) as Key
  await col().updateOne({ _id: `${tenantId}:${key}` } as any, { $set: { tenantId, key, subject: req.body.subject, body: req.body.body, updatedBy: userId, updatedAt: new Date() } }, { upsert: true })
  await prisma.auditLog.create({ data: { tenantId, userId, action: 'RECRUITMENT_TEMPLATE_SAVED', entityType: 'recruitment_template', entityId: key } })
  res.json({ success: true, data: await templateFor(tenantId, key) })
}))
recruitmentExtrasRouter.delete('/templates/:key', validate(z.object({ params: z.object({ key: z.enum(TEMPLATE_KEYS) }) })), asyncHandler(async (req, res) => {
  const { tenantId, userId, roleIds } = req.user!
  if (!isHR(roleIds)) throw new AppError('Only HR edits the email templates', 403)
  const key = String(req.params.key) as Key
  await col().deleteOne({ _id: `${tenantId}:${key}` } as any)
  await prisma.auditLog.create({ data: { tenantId, userId, action: 'RECRUITMENT_TEMPLATE_RESET', entityType: 'recruitment_template', entityId: key } })
  res.json({ success: true, data: await templateFor(tenantId, key) })
}))

// ─── Access to a candidate: HR and the opening's hiring manager (full), an interviewer of theirs (interview + CV only) ───
async function candidateFor(req: any, id: string, interviewerOk = false) {
  const { tenantId, userId, roleIds, employeeId } = req.user
  const c: any = await prisma.candidate.findFirst({ where: { id, tenantId }, include: { opening: true } })
  if (!c) throw new AppError('Candidate not found', 404)
  const manages = isHR(roleIds) || (!!employeeId && c.opening.hiringManagerId === employeeId) || c.opening.requestedByUserId === userId
  if (manages) return { c, full: true }
  if (interviewerOk && (await prisma.interview.findFirst({ where: { candidateId: id, interviewerUserId: userId } }))) return { c, full: false }
  throw new AppError('Candidate not found', 404)
}

// ─── Calendar file ───
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const fold = (line: string) => line.match(/.{1,73}/g)!.map((p, i) => (i ? ' ' + p : p)).join('\r\n')
export function icsFor(i: { id: string; scheduledAt: Date; mode: string }, c: { firstName: string; lastName: string }, role: string, company: string, link?: string) {
  const start = new Date(i.scheduledAt), end = new Date(start.getTime() + 60 * 60_000)
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MarichiHR//Recruitment//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT', `UID:${i.id}@marichihr`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(`Interview: ${role} at ${company}`)}`, `DESCRIPTION:${esc(`${c.firstName} ${c.lastName} · ${i.mode.replace(/_/g, ' ')}${link ? `\n${link}` : ''}`)}`, ...(link ? [`LOCATION:${esc(link)}`] : []), 'END:VEVENT', 'END:VCALENDAR']
  return lines.map(fold).join('\r\n') + '\r\n'
}
async function company(tenantId: string) { return (await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, timezone: true } })) ?? { name: 'our company', timezone: 'UTC' } }

recruitmentExtrasRouter.get('/interviews/:id/ics', validate(z.object({ params: idp })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const i: any = await prisma.interview.findFirst({ where: { id: String(req.params.id), candidate: { tenantId } }, include: { candidate: { include: { opening: true } } } })
  if (!i) throw new AppError('Interview not found', 404)
  if (i.interviewerUserId !== userId) await candidateFor(req, i.candidateId)
  const co = await company(tenantId)
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="interview.ics"')
  res.send(icsFor(i, i.candidate, i.candidate.opening.title, co.name))
}))

// ─── Emails to candidates ───
let mailer: (m: OutboundMessage) => Promise<void> = (m) => emailTransport().send(m)
export const setRecruitMailer = (f: typeof mailer) => { mailer = f }

const Compose = z.object({ params: idp, body: z.object({
  template: z.enum(TEMPLATE_KEYS), interviewId: z.string().uuid().optional(),
  link: z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Use an http(s) link').optional(),
  subject: z.string().trim().min(3).max(200).optional(), body: z.string().trim().min(10).max(5000).optional(), // the text HR saw in the preview, possibly edited
  rejectNow: z.boolean().optional(), reason: z.string().trim().min(2).max(500).optional(),
}).strict() })

async function compose(req: any, send: boolean) {
  const { tenantId } = req.user
  if (!isHR(req.user.roleIds)) throw new AppError('Only HR sends emails to candidates', 403)
  const { c } = await candidateFor(req, String(req.params.id))
  const b = req.body as z.infer<typeof Compose>['body']
  const co = await company(tenantId)
  const tpl = await templateFor(tenantId, b.template)
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: co.timezone || 'UTC', ...o }).format(d)
  const vars: Record<string, string> = { candidate: `${c.firstName} ${c.lastName}`, role: c.opening.title, company: co.name, date: '', time: '', mode: '', link: b.link ?? '', pay: '', joining: '', note: '' }
  let interview: any = null
  if (b.template === 'interview') {
    if (!b.interviewId) throw new AppError('Choose which interview this email is about', 400)
    interview = await prisma.interview.findFirst({ where: { id: b.interviewId, candidateId: c.id, status: 'scheduled' } })
    if (!interview) throw new AppError('That interview is not scheduled any more', 409)
    vars.date = fmt(new Date(interview.scheduledAt), { dateStyle: 'full' })
    vars.time = fmt(new Date(interview.scheduledAt), { hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' })
    vars.mode = ({ video: 'Video call', phone: 'Phone call', in_person: 'In person' } as any)[interview.mode] ?? interview.mode
  }
  if (b.template === 'offer') {
    if (c.stage !== 'offer' || !['made', 'accepted'].includes(c.offerStatus ?? '')) throw new AppError('Make the offer first, then email it', 409)
    vars.pay = `${Number(c.offerCtcAnnual).toLocaleString('en-GB')} ${c.opening.currency}`
    vars.joining = c.offerJoiningDate ? fmt(new Date(c.offerJoiningDate), { dateStyle: 'long' }) : ''
    vars.note = c.offerNote ?? ''
  }
  if (b.template === 'rejection' && b.rejectNow && !b.reason) throw new AppError('Give the reason for rejecting (kept on the candidate, not sent)', 400)
  const subject = b.subject ?? render(tpl.subject, vars)
  const text = b.body ?? render(tpl.body, vars)
  const msg: OutboundMessage = {
    to: { name: vars.candidate, email: c.email }, subject, text, type: 'recruitment.candidate', raw: true,
    footer: `You are receiving this email because you applied for a role at ${co.name}.`,
    ...(interview && { attachments: [{ filename: 'interview.ics', content: Buffer.from(icsFor(interview, c, c.opening.title, co.name, b.link)) }] }),
  }
  if (!send) return { to: c.email, subject, body: text, attachment: interview ? 'interview.ics' : null }
  if (b.template === 'rejection' && b.rejectNow) await recruitmentService.updateCandidate(req.user, c.id, { stage: 'rejected', rejectionReason: b.reason })
  try { await mailer(msg) } catch (e: any) {
    throw new AppError(`The email could not be sent (${String(e?.message ?? 'unknown error').slice(0, 120)}).${b.rejectNow ? ' The candidate was rejected; send the email again from their page.' : ''}`, 502, 'EMAIL_FAILED')
  }
  await prisma.auditLog.create({ data: { tenantId, userId: req.user.userId, action: 'CANDIDATE_EMAIL_SENT', entityType: 'candidate', entityId: c.id, newValue: { template: b.template, subject, to: c.email, interviewId: interview?.id ?? null, rejected: !!b.rejectNow } } })
  return { sent: true, to: c.email, subject }
}
recruitmentExtrasRouter.post('/candidates/:id/email/preview', validate(Compose), asyncHandler(async (req, res) => res.json({ success: true, data: await compose(req, false) })))
recruitmentExtrasRouter.post('/candidates/:id/email/send', validate(Compose), asyncHandler(async (req, res) => res.json({ success: true, data: await compose(req, true) })))

// ─── CV as a file ───
const CV_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' }
const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } })
const accept = (mw: RequestHandler): RequestHandler => (req, res, next) => mw(req, res, (err: any) => { if (!err) return next(); next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 'A CV can be up to 5 MB' : 'The file could not be read', 400)) })

recruitmentExtrasRouter.post('/candidates/:id/cv', validate(z.object({ params: idp })), accept(memory.single('file')), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const { c } = await candidateFor(req, String(req.params.id))
  const file = (req as any).file as { buffer: Buffer; mimetype: string; originalname: string } | undefined
  if (!storageConfigured()) throw new AppError('File storage is not set up yet. Ask your administrator.', 503)
  if (!file) throw new AppError('Choose a file first', 400)
  const ext = CV_TYPES[file.mimetype]
  if (!ext) throw new AppError('Use a PDF, DOC or DOCX file', 400)
  const name = String(file.originalname).replace(/[^\w.\- ]/g, '_').slice(0, 80)
  const key = `recruitment/${tenantId}/${c.id}/${crypto.randomUUID()}.${ext}`
  await storage().put(key, file.buffer, file.mimetype)
  if (c.resumeUrl?.startsWith('file:')) await storage().remove(c.resumeUrl.slice(5).split('|')[0]).catch(() => undefined)
  await prisma.candidate.update({ where: { id: c.id }, data: { resumeUrl: `file:${key}|${name}` } })
  await prisma.auditLog.create({ data: { tenantId, userId, action: 'CANDIDATE_CV_UPLOADED', entityType: 'candidate', entityId: c.id, newValue: { name, bytes: file.buffer.length } } })
  res.status(201).json({ success: true, data: { resumeFile: name } })
}))
recruitmentExtrasRouter.get('/candidates/:id/cv', validate(z.object({ params: idp })), asyncHandler(async (req, res) => {
  const { c } = await candidateFor(req, String(req.params.id), true)
  if (!c.resumeUrl?.startsWith('file:')) throw new AppError('There is no CV file', 404)
  const [key, name] = c.resumeUrl.slice(5).split('|')
  res.json({ success: true, data: { url: await storage().signedUrl(key, 300, name), name, expiresInSeconds: 300 } })
}))
recruitmentExtrasRouter.delete('/candidates/:id/cv', validate(z.object({ params: idp })), asyncHandler(async (req, res) => {
  const { c } = await candidateFor(req, String(req.params.id))
  if (c.resumeUrl?.startsWith('file:')) {
    await storage().remove(c.resumeUrl.slice(5).split('|')[0]).catch(() => undefined)
    await prisma.candidate.update({ where: { id: c.id }, data: { resumeUrl: null } })
    await prisma.auditLog.create({ data: { tenantId: req.user!.tenantId, userId: req.user!.userId, action: 'CANDIDATE_CV_REMOVED', entityType: 'candidate', entityId: c.id } })
  }
  res.json({ success: true, data: { removed: true } })
}))

// Self-check: node -r dotenv/config -r ts-node/register/transpile-only src/modules/recruitment/recruitment.extras.mongo.router.ts
if (require.main === module) {
  console.assert(render('Hi {candidate}\nLink: {link}\nBye', { candidate: 'Ann', link: '' }) === 'Hi Ann\nBye', 'a line with an empty placeholder is dropped')
  console.assert(render('Pay {pay} for {role}', { pay: '10', role: 'Cook' }) === 'Pay 10 for Cook', 'placeholders are filled')
  console.assert(render('Keep {unknown}', { a: 'b' }) === 'Keep {unknown}', 'an unknown placeholder is left for HR to see')
  console.assert(unknownPlaceholder('Hello {candidate} {foo}') === 'foo' && unknownPlaceholder('{role} {company}') === undefined, 'unknown placeholders are found')
  const ics = icsFor({ id: 'abc', scheduledAt: new Date('2026-12-01T09:00:00Z'), mode: 'video' }, { firstName: 'Ann', lastName: 'Lee' }, 'Cook, senior', 'Acme', 'https://meet.example/x')
  console.assert(ics.includes('DTSTART:20261201T090000Z') && ics.includes('DTEND:20261201T100000Z') && ics.includes('SUMMARY:Interview: Cook\\, senior at Acme') && ics.startsWith('BEGIN:VCALENDAR'), 'a calendar file with escaped text')
  console.log('recruitment extras check done')
}

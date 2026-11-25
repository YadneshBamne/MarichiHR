import { Router, RequestHandler } from 'express'
import multer from 'multer'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { z } from 'zod'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { tenantHasFeature } from '../../middleware/module.middleware.mongo'
import { prisma } from '../../infrastructure/database/prisma.stub' // a .mongo file needs the stub to get the Prisma-compatible client
import { redis, soft } from '../../infrastructure/cache/redis'
import { storage, storageConfigured } from '../../infrastructure/storage/storage'
import { notify, userIdsWithRole, userIdOfEmployee, emailTransport, type OutboundMessage } from '../../infrastructure/notifications/notify'
import { Tenant } from '../../infrastructure/mongo/mongo'
import { templateFor, render } from './recruitment.extras.mongo.router'

// The public careers page (MongoDB API only).
//  - HR side (behind sign-in and the recruitment feature): the company switch and texts, and per opening "show on careers page" + a public description.
//  - Public side (NO sign-in, /api/v1/public/careers/:slug...): the list of published openings, one opening, and the application.
// Nothing here changes the Postgres schema: the settings and the per-opening public texts live in two small collections.
// Anything that is not public (unknown company, careers switched off, recruitment not in the plan, opening not published or not open) answers the same 404.
export const careersAdminRouter = Router()
export const careersPublicRouter = Router()

const isHR = (roleIds: string[]) => roleIds.includes('hr_admin')
const settingsCol = () => mongoose.connection.collection('careers_settings')
const openingCol = () => mongoose.connection.collection('careers_openings')
const idp = z.object({ id: z.string().uuid() })

type Settings = { enabled: boolean; headline: string; intro: string; applyNote: string; contactEmail: string; showSalary: boolean }
const DEFAULT_SETTINGS: Settings = { enabled: false, headline: '', intro: '', applyNote: '', contactEmail: '', showSalary: false }
const settingsOf = async (tenantId: string): Promise<Settings> => ({ ...DEFAULT_SETTINGS, ...(((await settingsCol().findOne({ _id: tenantId } as any)) as any) ?? {}) })

// ─────────────────────────────── HR side ───────────────────────────────
const SettingsBody = z.object({
  enabled: z.boolean(), headline: z.string().trim().max(120), intro: z.string().trim().max(1500), applyNote: z.string().trim().max(600),
  contactEmail: z.union([z.literal(''), z.string().trim().email().max(200)]), showSalary: z.boolean(),
}).strict()

careersAdminRouter.get('/careers', asyncHandler(async (req, res) => {
  const { tenantId, roleIds } = req.user!
  if (!isHR(roleIds)) throw new AppError('Only HR sets up the careers page', 403)
  const [s, tenant, rows, metas] = await Promise.all([
    settingsOf(tenantId),
    Tenant.findById(tenantId).select('slug').lean() as any,
    prisma.jobOpening.findMany({ where: { tenantId, status: { in: ['open', 'on_hold', 'pending_approval'] } }, orderBy: { createdAt: 'desc' }, take: 200 }),
    openingCol().find({ tenantId } as any).toArray(),
  ])
  const meta = new Map((metas as any[]).map((m) => [String(m._id), m]))
  res.json({ success: true, data: { ...s, slug: tenant?.slug ?? null, openings: rows.map((o: any) => ({ id: o.id, title: o.title, status: o.status, published: !!meta.get(o.id)?.published, publicDescription: meta.get(o.id)?.publicDescription ?? '' })) } })
}))

careersAdminRouter.put('/careers/settings', validate(z.object({ body: SettingsBody })), asyncHandler(async (req, res) => {
  const { tenantId, userId, roleIds } = req.user!
  if (!isHR(roleIds)) throw new AppError('Only HR sets up the careers page', 403)
  await settingsCol().updateOne({ _id: tenantId } as any, { $set: { ...req.body, tenantId, updatedAt: new Date() } }, { upsert: true })
  await prisma.auditLog.create({ data: { tenantId, userId, action: req.body.enabled ? 'CAREERS_PAGE_SAVED_ON' : 'CAREERS_PAGE_SAVED_OFF', entityType: 'careers', entityId: tenantId } })
  res.json({ success: true, data: await settingsOf(tenantId) })
}))

careersAdminRouter.put('/careers/openings/:id', validate(z.object({ params: idp, body: z.object({ published: z.boolean().optional(), publicDescription: z.string().max(6000).optional() }).strict() })), asyncHandler(async (req, res) => {
  const { tenantId, userId, roleIds } = req.user!
  if (!isHR(roleIds)) throw new AppError('Only HR sets up the careers page', 403)
  const id = String(req.params.id)
  const o = await prisma.jobOpening.findFirst({ where: { id, tenantId } })
  if (!o) throw new AppError('Opening not found', 404)
  const cur: any = (await openingCol().findOne({ _id: id } as any)) ?? {}
  const text = (req.body.publicDescription ?? cur.publicDescription ?? '').replace(/\r\n/g, '\n').trim()
  const published = req.body.published ?? !!cur.published
  if (published && text.length < 20) throw new AppError('Write the public description first (at least a couple of sentences). It is what applicants read.', 400)
  await openingCol().updateOne({ _id: id } as any, { $set: { tenantId, published, publicDescription: text, updatedAt: new Date() } }, { upsert: true })
  if (published !== !!cur.published) await prisma.auditLog.create({ data: { tenantId, userId, action: published ? 'CAREERS_OPENING_PUBLISHED' : 'CAREERS_OPENING_UNPUBLISHED', entityType: 'job_opening', entityId: id } })
  res.json({ success: true, data: { id, published, publicDescription: text, status: o.status } })
}))

// ─────────────────────────────── Public side ───────────────────────────────
const notFound = () => new AppError('This page is not available', 404, 'NOT_FOUND')
const isPublicCache: RequestHandler = (_req, res, next) => { res.setHeader('Cache-Control', 'public, max-age=60'); next() }

async function companyFor(slug: string) {
  if (!/^[a-z0-9-]{2,80}$/.test(slug)) throw notFound()
  const t: any = await Tenant.findOne({ slug, active: true }).select('name logoUrl').lean()
  if (!t) throw notFound()
  const s = await settingsOf(t._id)
  if (!s.enabled || !(await tenantHasFeature(t._id, 'recruitment'))) throw notFound()
  return { tenantId: t._id as string, name: t.name as string, logoUrl: (t.logoUrl ?? null) as string | null, settings: s }
}

const TYPE_LABEL: Record<string, string> = { full_time: 'Full time', part_time: 'Part time', contract: 'Contract', intern: 'Internship', temporary: 'Temporary', casual: 'Casual' }
const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
const excerpt = (text: string) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > 180 ? `${flat.slice(0, 177).trimEnd()}…` : flat }

// Published AND open openings of a company, in the public shape (no tenant id, no internal fields)
async function published(c: Awaited<ReturnType<typeof companyFor>>, only?: string) {
  const metas: any[] = await openingCol().find({ tenantId: c.tenantId, published: true, ...(only && { _id: only }) } as any).toArray()
  if (!metas.length) return []
  const db = mongoose.connection
  const rows: any[] = await db.collection('job_openings').find({ _id: { $in: metas.map((m) => m._id) }, tenantId: c.tenantId, status: 'open' } as any).sort({ createdAt: -1 }).toArray()
  const [units, places]: any[] = await Promise.all([
    db.collection('org_units').find({ _id: { $in: [...new Set(rows.map((r) => r.orgUnitId).filter(Boolean))] }, tenantId: c.tenantId } as any).project({ name: 1 }).toArray(),
    db.collection('work_locations').find({ _id: { $in: [...new Set(rows.map((r) => r.workLocationId).filter(Boolean))] }, tenantId: c.tenantId } as any).project({ name: 1, city: 1 }).toArray(),
  ])
  const unit = new Map<string, string>(units.map((u: any) => [String(u._id), u.name]))
  const place = new Map<string, string>(places.map((p: any) => [String(p._id), p.city ? `${p.name}, ${p.city}` : p.name]))
  const text = new Map<string, string>(metas.map((m) => [String(m._id), String(m.publicDescription ?? '')]))
  return rows.map((o) => ({
    id: String(o._id), title: o.title as string, department: unit.get(o.orgUnitId) ?? null, location: place.get(o.workLocationId) ?? null,
    employmentType: o.employmentType as string, employmentTypeLabel: typeLabel(o.employmentType), postedAt: o.approvedAt ?? o.createdAt,
    excerpt: excerpt(text.get(String(o._id)) ?? ''), description: text.get(String(o._id)) ?? '',
    salary: c.settings.showSalary && o.salaryMin != null && o.salaryMax != null ? { min: Number(o.salaryMin), max: Number(o.salaryMax), currency: o.currency as string } : null,
  }))
}
const head = (c: Awaited<ReturnType<typeof companyFor>>) => ({ name: c.name, logoUrl: c.logoUrl, headline: c.settings.headline || `Careers at ${c.name}`, intro: c.settings.intro, applyNote: c.settings.applyNote, contactEmail: c.settings.contactEmail || null })

careersPublicRouter.get('/:slug', isPublicCache, asyncHandler(async (req, res) => {
  const c = await companyFor(String(req.params.slug))
  const openings = (await published(c)).map(({ description: _d, ...o }) => o)
  res.json({ success: true, data: { company: head(c), openings } })
}))
careersPublicRouter.get('/:slug/openings/:id', isPublicCache, asyncHandler(async (req, res) => {
  const id = String(req.params.id)
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound()
  const c = await companyFor(String(req.params.slug))
  const [o] = await published(c, id)
  if (!o) throw notFound()
  res.json({ success: true, data: { company: head(c), opening: o } })
}))

// A failed or unknown page must never be cached
careersPublicRouter.use((err: any, _req: any, res: any, next: any) => { res.setHeader('Cache-Control', 'no-store'); next(err) })

// ─── Applying ───
const CV_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' }
const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 12, fieldSize: 8 * 1024 } })
const accept = (mw: RequestHandler): RequestHandler => (req, res, next) => mw(req, res, (err: any) => { if (!err) return next(); next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 'A CV can be up to 5 MB' : 'The application could not be read', 400)) })

// The file's own first bytes must match its claimed type: PDF, Word (old OLE) or Word (zip)
export function looksLike(buf: Buffer, ext: string) {
  if (ext === 'pdf') return buf.subarray(0, 5).toString('latin1') === '%PDF-'
  if (ext === 'docx') return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
  if (ext === 'doc') return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  return false
}
// Text from a stranger: no tags, no control characters, bounded
export const clean = (v: unknown, multiline = false) => String(v ?? '').replace(/<[^>]*>/g, '').replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
const EMAIL = /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[A-Za-z]{2,}$/
const PHONE = /^\+?[\d][\d\s().-]{5,24}$/

let mailer: (m: OutboundMessage) => Promise<void> = (m) => emailTransport().send(m)
export const setCareersMailer = (f: typeof mailer) => { mailer = f }

async function tooMany(key: string, max: number, ttl: number) {
  const n = Number(await soft(async () => { const c = await redis.incr(key); if (c === 1) await redis.expire(key, ttl); return c }, 0)) || 0
  return n > max
}

careersPublicRouter.post('/:slug/openings/:id/apply', accept(memory.single('cv')), asyncHandler(async (req, res) => {
  const id = String(req.params.id)
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound()
  const c = await companyFor(String(req.params.slug))
  const [o] = await published(c, id)
  if (!o) throw notFound()
  res.setHeader('Cache-Control', 'no-store')
  const b: any = req.body ?? {}
  // a bot fills the hidden field: say thanks and keep nothing
  if (clean(b.website)) return void res.status(201).json({ success: true, data: { received: true, company: c.name, role: o.title } })
  const age = Date.now() - Number(b.startedAt)
  if (!Number.isFinite(age) || age < 3000) throw new AppError('That was very quick. Please check your details and send again.', 400, 'TOO_FAST')

  const first = clean(b.firstName).slice(0, 60), last = clean(b.lastName).slice(0, 60)
  const email = clean(b.email).toLowerCase(), phone = clean(b.phone), message = clean(b.message, true)
  const problems: Record<string, string> = {}
  if (first.length < 1) problems.firstName = 'Enter your first name'
  if (last.length < 1) problems.lastName = 'Enter your last name'
  if (!EMAIL.test(email) || email.length > 200) problems.email = 'Enter a valid email address'
  if (phone && !PHONE.test(phone)) problems.phone = 'Use digits, spaces and + only, for example +260 97 1234567'
  if (message.length > 2000) problems.message = 'Keep the message under 2,000 characters'
  if (!['true', 'on', '1'].includes(String(b.consent).toLowerCase())) problems.consent = 'Please agree to the use of your details'
  if (Object.keys(problems).length) throw new AppError(Object.values(problems)[0], 400, 'INVALID', { fields: problems })

  const file = (req as any).file as { buffer: Buffer; mimetype: string; originalname: string } | undefined
  let ext = ''
  if (file) {
    ext = CV_TYPES[file.mimetype] ?? ''
    const named = String(file.originalname).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] // the name's own extension must be the one the type says
    if (!ext || named !== ext || !looksLike(file.buffer, ext)) throw new AppError('Use a PDF, DOC or DOCX file for your CV', 400, 'INVALID', { fields: { cv: 'Use a PDF, DOC or DOCX file' } })
    if (!storageConfigured()) throw new AppError('CV upload is not available right now. You can apply without a CV and share it later.', 503, 'CV_UNAVAILABLE')
  }

  // limits count real attempts only (after the checks above), so a typo does not use one up
  const ip = req.ip ?? 'unknown'
  if (await tooMany(`careers:ip:${ip}`, 5, 3600)) throw new AppError('You have sent several applications from this connection. Please try again in an hour.', 429, 'RATE_LIMITED')
  if (await tooMany(`careers:email:${email}`, 3, 86400)) throw new AppError('This email address has already been used for several applications today. Please try again tomorrow.', 429, 'RATE_LIMITED')
  if (await tooMany(`careers:co:${c.tenantId}`, 60, 3600)) throw new AppError('We are receiving a lot of applications right now. Please try again in a little while.', 429, 'RATE_LIMITED')

  const done = () => res.status(201).json({ success: true, data: { received: true, company: c.name, role: o.title } })
  // the same person applying again: no second candidate, and nothing is revealed; HR sees a note on the existing one
  const before: any = await prisma.candidate.findFirst({ where: { tenantId: c.tenantId, openingId: id, email: { equals: email, mode: 'insensitive' } } })
  if (before) {
    await prisma.auditLog.create({ data: { tenantId: c.tenantId, userId: null, action: 'CANDIDATE_APPLIED_AGAIN', entityType: 'candidate', entityId: before.id, newValue: { via: 'careers', cvOffered: !!file, hasMessage: !!message } } })
    return void done()
  }

  const candidateId = crypto.randomUUID()
  let resumeUrl: string | null = null
  if (file) {
    const name = String(file.originalname).replace(/[^\w.\- ]/g, '_').slice(0, 80) || `cv.${ext}`
    const key = `recruitment/${c.tenantId}/${candidateId}/${crypto.randomUUID()}.${ext}`
    await storage().put(key, file.buffer, file.mimetype)
    resumeUrl = `file:${key}|${name}`
  }
  try {
    await prisma.candidate.create({ data: { id: candidateId, tenantId: c.tenantId, openingId: id, firstName: first, lastName: last, email, phone: phone || null, source: 'careers', resumeUrl, summary: message || null, createdByUserId: 'careers' } })
  } catch (e) {
    if (resumeUrl) await storage().remove(resumeUrl.slice(5).split('|')[0]).catch(() => undefined)
    throw e
  }
  await prisma.auditLog.create({ data: { tenantId: c.tenantId, userId: null, action: 'CANDIDATE_APPLIED', entityType: 'candidate', entityId: candidateId, newValue: { via: 'careers', openingId: id, name: `${first} ${last}`, cv: !!resumeUrl } } })
  done()

  // after the answer: tell HR and the hiring manager, and thank the applicant (never fails the application)
  void (async () => {
    const opening: any = await prisma.jobOpening.findFirst({ where: { id, tenantId: c.tenantId } })
    const to = new Set(await userIdsWithRole(c.tenantId, 'hr_admin'))
    const hm = await userIdOfEmployee(c.tenantId, opening?.hiringManagerId)
    if (hm) to.add(hm)
    await notify({ tenantId: c.tenantId, userIds: [...to], type: 'recruitment.application', title: `New application for ${o.title}`, body: `${first} ${last} applied through the careers page`, link: `/recruitment/${id}`, entityType: 'candidate', entityId: candidateId })
    const tpl = await templateFor(c.tenantId, 'application_received')
    const vars = { candidate: `${first} ${last}`, role: o.title, company: c.name }
    const subject = render(tpl.subject, vars)
    await mailer({ to: { name: vars.candidate, email }, subject, text: render(tpl.body, vars), type: 'recruitment.candidate', raw: true, footer: `You are receiving this email because you applied for a role at ${c.name}.` })
    await prisma.auditLog.create({ data: { tenantId: c.tenantId, userId: null, action: 'CANDIDATE_EMAIL_SENT', entityType: 'candidate', entityId: candidateId, newValue: { template: 'application_received', subject, to: email, automatic: true } } })
  })().catch((e) => console.warn('[careers] follow-up failed:', e?.message))
}))

// Self-check: node -r dotenv/config -r ts-node/register/transpile-only src/modules/recruitment/careers.mongo.router.ts
if (require.main === module) {
  console.assert(looksLike(Buffer.from('%PDF-1.7 hello'), 'pdf') && !looksLike(Buffer.from('MZ....'), 'pdf'), 'a PDF is recognised by its first bytes')
  console.assert(looksLike(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), 'docx') && !looksLike(Buffer.from('%PDF-'), 'docx'), 'a docx is a zip')
  console.assert(looksLike(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), 'doc') && !looksLike(Buffer.from('plain text file'), 'doc'), 'a doc is an OLE file')
  console.assert(clean('<b>Ann</b>\u0007  Lee') === 'Ann Lee' && clean('a\nb', true) === 'a\nb' && clean('a\nb') === 'a b', 'tags and control characters are removed')
  console.assert(EMAIL.test('ann@example.com') && !EMAIL.test('ann@') && !EMAIL.test('a b@c.de') && !EMAIL.test('<x>@y.zz'), 'email check')
  console.assert(PHONE.test('+260 97 1234567') && !PHONE.test('abc') && !PHONE.test('12'), 'phone check')
  console.assert(excerpt('word '.repeat(100)).endsWith('…') && excerpt('short text') === 'short text', 'excerpt is cut at 180 characters')
  console.log('careers check done')
  process.exit(0) // the imports open connections that would keep the process alive
}

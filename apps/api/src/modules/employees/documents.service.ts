import crypto from 'crypto'
import { prisma } from '../../infrastructure/database/prisma'
import { storage, storageConfigured } from '../../infrastructure/storage/storage'
import { notify, userIdsWithRole, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, canAccessProfile } from '../../shared/utils/access'
import { assertMasters } from '../masters/masters.service'

// Files on a person, kept in private storage. Who may do what:
//  - HR admins: upload (choosing whether the person can see it), list, download, archive any document
//  - the person: upload their own (always visible to them), see and download documents shared with them,
//    archive what they uploaded themselves
//  - everyone else, managers included: nothing
// Every download is a 60-second signed link and is audit-logged.

export const MAX_BYTES = 10 * 1024 * 1024
const isHR = (u: AccessUser) => u.roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

// The file's own first bytes decide its type (the name and the browser's claim are not trusted)
export function sniff(buf: Buffer, name: string): string | null {
  const ext = name.toLowerCase().split('.').pop()
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf'
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buf.subarray(0, 4).toString('latin1') === 'PK\u0003\u0004' && ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (buf.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) && ext === 'doc') return 'application/msword'
  return null
}
const safeName = (n: string) => n.normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').slice(-120) || 'file'

async function access(u: AccessUser, employeeId: string) {
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: u.tenantId }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
  if (!emp || !(await canAccessProfile(u, employeeId))) throw new AppError('Employee not found', 404)
  const self = !!u.employeeId && u.employeeId === employeeId
  return { emp, self, hr: isHR(u) }
}
const view = (d: any) => ({ id: d.id, category: d.category, title: d.title, fileName: d.fileName, mimeType: d.mimeType, size: d.size, expiryDate: ymd(d.expiryDate), visibility: d.visibility, uploadedBy: d.uploadedBy, createdAt: d.createdAt })

export const documentService = {
  async list(u: AccessUser, employeeId: string) {
    const { self, hr } = await access(u, employeeId)
    if (!self && !hr) return { documents: [], canUpload: false, storageReady: storageConfigured() }
    const rows = await prisma.employeeDocument.findMany({ where: { tenantId: u.tenantId, employeeId, active: true, ...(hr ? {} : { visibility: 'employee' }) }, orderBy: { createdAt: 'desc' } })
    return { documents: rows.map(view), canUpload: true, storageReady: storageConfigured() }
  },

  async upload(u: AccessUser, employeeId: string, file: { buffer: Buffer; originalname: string; size: number } | undefined, body: { category: string; title?: string; expiryDate?: string; visibility?: 'employee' | 'hr' }) {
    const { self, hr } = await access(u, employeeId)
    if (!self && !hr) throw new AppError('You cannot add documents for this person', 403)
    if (!storageConfigured()) throw new AppError("Document storage isn't set up yet", 503)
    if (!file) throw new AppError('Choose a file', 400)
    if (file.size > MAX_BYTES) throw new AppError('Files can be up to 10 MB', 400)
    const mimeType = sniff(file.buffer, file.originalname)
    if (!mimeType) throw new AppError('Upload a PDF, JPG, PNG, WebP or Word document', 400)
    await assertMasters(u.tenantId, { document_category: body.category })
    const id = crypto.randomUUID()
    const fileName = safeName(file.originalname)
    const fileKey = `${u.tenantId}/employees/${employeeId}/${id}-${fileName}`
    await storage().put(fileKey, file.buffer, mimeType)
    const doc = await prisma.employeeDocument.create({
      data: {
        id, tenantId: u.tenantId, employeeId, category: body.category, title: (body.title || file.originalname).slice(0, 160), fileKey, fileName, mimeType, size: file.size,
        expiryDate: body.expiryDate ? new Date(`${body.expiryDate}T00:00:00.000Z`) : null, visibility: hr ? body.visibility ?? 'employee' : 'employee', uploadedBy: u.userId,
      },
    })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'DOCUMENT_UPLOADED', entityType: 'employee', entityId: employeeId, newValue: { documentId: id, category: body.category, fileName, size: file.size } } })
    return view(doc)
  },

  async download(u: AccessUser, employeeId: string, docId: string) {
    const { self, hr } = await access(u, employeeId)
    const doc = await prisma.employeeDocument.findFirst({ where: { id: docId, employeeId, tenantId: u.tenantId, active: true } })
    if (!doc || !(hr || (self && doc.visibility === 'employee'))) throw new AppError('Document not found', 404)
    const url = await storage().signedUrl(doc.fileKey, 60, doc.fileName)
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'DOCUMENT_DOWNLOADED', entityType: 'employee', entityId: employeeId, newValue: { documentId: doc.id, fileName: doc.fileName } } })
    return { url, expiresInSeconds: 60 }
  },

  async archive(u: AccessUser, employeeId: string, docId: string) {
    const { self, hr } = await access(u, employeeId)
    const doc = await prisma.employeeDocument.findFirst({ where: { id: docId, employeeId, tenantId: u.tenantId, active: true } })
    if (!doc || !(hr || (self && doc.visibility === 'employee'))) throw new AppError('Document not found', 404)
    if (!hr && doc.uploadedBy !== u.userId) throw new AppError('Only HR can remove a document HR added', 403)
    await prisma.employeeDocument.update({ where: { id: docId }, data: { active: false, archivedBy: u.userId, archivedAt: new Date() } })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'DOCUMENT_ARCHIVED', entityType: 'employee', entityId: employeeId, newValue: { documentId: doc.id, fileName: doc.fileName } } })
    return { archived: true }
  },

  // Many files at once, each named after the person's employee ID: "EMP0042.pdf", "EMP0042_cv.pdf", "emp0042 - licence.jpg"
  async bulk(u: AccessUser, files: { buffer: Buffer; originalname: string; size: number }[], body: { category: string; visibility?: 'employee' | 'hr' }) {
    if (!isHR(u)) throw new AppError('Only HR uploads documents in bulk', 403)
    if (!storageConfigured()) throw new AppError("Document storage isn't set up yet", 503)
    await assertMasters(u.tenantId, { document_category: body.category })
    const people = await prisma.employee.findMany({ where: { tenantId: u.tenantId }, select: { id: true, employeeCode: true } })
    const byCode = new Map(people.map((p) => [p.employeeCode.toUpperCase(), p.id]))
    const results: { file: string; status: 'uploaded' | 'error'; employeeCode?: string; error?: string }[] = []
    for (const f of files) {
      const stem = f.originalname.replace(/\.[^.]+$/, '')
      const code = [...byCode.keys()].filter((c) => stem.toUpperCase().startsWith(c) && !/[A-Z0-9]/i.test(stem.charAt(c.length) || '')).sort((a, b) => b.length - a.length)[0]
      if (!code) { results.push({ file: f.originalname, status: 'error', error: 'The file name does not start with an employee ID' }); continue }
      try {
        await this.upload(u, byCode.get(code)!, f, { category: body.category, title: stem.slice(code.length).replace(/^[\s_\-]+/, '') || undefined, visibility: body.visibility })
        results.push({ file: f.originalname, status: 'uploaded', employeeCode: code })
      } catch (e: any) { results.push({ file: f.originalname, status: 'error', employeeCode: code, error: e?.message ?? 'Upload failed' }) }
    }
    return { uploaded: results.filter((r) => r.status === 'uploaded').length, results }
  },
}

// Daily: documents and identity papers that expire in 30 days, in 7 days, or today. Each warning is sent once.
export async function sendExpiryReminders(tenantId: string) {
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)
  const plus = (n: number) => new Date(today.getTime() + n * 86400000)
  const [docs, ids, hrs] = await Promise.all([
    prisma.employeeDocument.findMany({ where: { tenantId, active: true, expiryDate: { gte: today, lte: plus(30) }, employee: { active: true } }, include: { employee: { select: { id: true, firstName: true, lastName: true } } } }),
    prisma.employeeIdentity.findMany({ where: { tenantId, expiryDate: { gte: today, lte: plus(30) }, employee: { active: true } }, include: { employee: { select: { id: true, firstName: true, lastName: true } } } }),
    userIdsWithRole(tenantId, 'hr_admin'),
  ])
  const items = [
    ...docs.map((d) => ({ id: d.id, what: d.title, expiry: d.expiryDate!, emp: d.employee })),
    ...ids.map((i) => ({ id: i.id, what: i.documentType.replace(/_/g, ' '), expiry: i.expiryDate!, emp: i.employee })),
  ]
  let sent = 0
  for (const it of items) {
    const days = Math.round((it.expiry.getTime() - today.getTime()) / 86400000)
    const step = days === 0 ? 0 : days <= 7 ? 7 : 30
    const person = await userIdOfEmployee(tenantId, it.emp.id)
    const when = days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`
    const out = await notify({
      tenantId, userIds: [...hrs, ...(person ? [person] : [])], type: 'document.expiring',
      title: `${it.what} expires ${when}`, body: `${it.emp.firstName} ${it.emp.lastName}: ${it.what} expires on ${ymd(it.expiry)}`,
      link: `/employees/${it.emp.id}`, entityType: 'employee', entityId: it.emp.id, eventId: `expiry:${it.id}:${ymd(it.expiry)}:${step}`,
    })
    sent += out.length
  }
  return sent
}

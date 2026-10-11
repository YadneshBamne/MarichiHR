// Employee documents against the real storage bucket: who uploads/sees/downloads/removes what, file-type and size
// checks, HR-only documents, signed downloads, bulk upload by employee ID, expiry reminders (sent once), isolation.
// Runs in a throwaway company and deletes every uploaded file at the end.
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } })
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, tokenFor, check, done, prisma } = require('./lib')
const { storage } = require('../../src/infrastructure/storage/storage')

const BASE = (process.env.API_URL || 'http://localhost:4000') + '/api/v1'
const TAG = `dc${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const sign = (u, roles) => ({ token: jwt.sign({ userId: u.userId, tenantId: u.tenantId, employeeId: u.id, roleIds: roles, email: u.workEmail }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) })
async function upload(who, path, files, fields = {}) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  for (const f of files) fd.append(f.field ?? 'file', new Blob([f.data]), f.name)
  const res = await fetch(BASE + path, { method: 'POST', headers: { Authorization: `Bearer ${who.token}` }, body: fd })
  const data = await res.json()
  return { status: res.status, data, body: data.data }
}

;(async () => {
  const keys = await redis.keys('signup:*'); if (keys.length) await redis.del(...keys)
  const email = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Docs ${TAG}`, fullName: 'Dot Owner', email, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email } } } })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, managerId) => (await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2026-01-05', employmentType: 'full_time', ...(managerId && { managerId }) })).body.employee
  const A = await add('Ana'), B = await add('Bo', A.id)
  const tA = sign(A, ['employee', 'manager']), tB = sign(B, ['employee'])

  // ─── Upload rules ──────────────────────────────────────────
  r = await upload(tB, `/employees/${B.id}/documents`, [{ data: PDF, name: 'my cv.pdf' }], { category: 'cv', title: 'CV 2026' })
  const cv = r.body
  check('I upload my own CV (PDF)', r.status === 201 && cv.mimeType === 'application/pdf' && cv.visibility === 'employee' && cv.fileName === 'my_cv.pdf', r.data)
  r = await upload(tB, `/employees/${B.id}/documents`, [{ data: Buffer.from('not really a pdf'), name: 'fake.pdf' }], { category: 'cv' })
  check('a file that only pretends to be a PDF is refused (400)', r.status === 400, r.data)
  r = await upload(tB, `/employees/${B.id}/documents`, [{ data: PDF, name: 'x.pdf' }], { category: 'tax_returns' })
  check('the category must be in the Document category list (400)', r.status === 400, r.status)
  r = await upload(tB, `/employees/${B.id}/documents`, [{ data: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), name: 'big.pdf' }], { category: 'cv' })
  check('files over 10 MB are refused (400)', r.status === 400 && /10 MB/.test(r.data.message), r.data)
  r = await upload(tB, `/employees/${A.id}/documents`, [{ data: PDF, name: 'x.pdf' }], { category: 'cv' })
  check("I cannot add documents to my manager's file (404)", r.status === 404, r.status)
  const inAWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  r = await upload(owner, `/employees/${B.id}/documents`, [{ data: PNG, name: 'licence.png' }], { category: 'identity', title: 'Driving licence', expiryDate: inAWeek, visibility: 'hr' })
  const hrDoc = r.body
  check('HR adds an HR-only document with an expiry date', r.status === 201 && hrDoc.visibility === 'hr' && hrDoc.mimeType === 'image/png' && hrDoc.expiryDate === inAWeek, r.data)

  // ─── Who sees what ─────────────────────────────────────────
  r = await api(tB, 'GET', `/employees/${B.id}/documents`)
  check('I see my own documents but not HR-only ones', r.body.documents.some((d) => d.id === cv.id) && !r.body.documents.some((d) => d.id === hrDoc.id), r.body?.documents)
  r = await api(owner, 'GET', `/employees/${B.id}/documents`)
  check('HR sees both', r.body.documents.length === 2, r.body?.documents?.length)
  r = await api(tA, 'GET', `/employees/${B.id}/documents`)
  check("a manager sees none of their report's documents", r.status === 200 && r.body.documents.length === 0 && !r.body.canUpload, r.body)
  r = await api(tA, 'GET', `/employees/${B.id}/documents/${cv.id}/download`)
  check('…and cannot download them (404)', r.status === 404, r.status)
  r = await api(tB, 'GET', `/employees/${B.id}/documents/${hrDoc.id}/download`)
  check('I cannot download an HR-only document (404)', r.status === 404, r.status)
  r = await api(tB, 'GET', `/employees/${B.id}/documents/${cv.id}/download`)
  const got = r.status === 200 ? Buffer.from(await (await fetch(r.body.url)).arrayBuffer()) : null
  check('my download is a short-lived signed link to the same bytes', r.status === 200 && r.body.expiresInSeconds === 60 && got && got.equals(PDF), r.data)
  check('…and the download is audit-logged', !!(await prisma.auditLog.findFirst({ where: { tenantId: tenant.id, action: 'DOCUMENT_DOWNLOADED', entityId: B.id } })))

  // ─── Removing ──────────────────────────────────────────────
  r = await api(tB, 'DELETE', `/employees/${B.id}/documents/${hrDoc.id}`)
  check('I cannot remove an HR document (404)', r.status === 404, r.status)
  r = await api(tB, 'DELETE', `/employees/${B.id}/documents/${cv.id}`)
  check('I can remove what I uploaded (archived, not lost)', r.status === 200 && (await prisma.employeeDocument.findUnique({ where: { id: cv.id } })).active === false, r.data)

  // ─── Bulk by employee ID ───────────────────────────────────
  const code = (await prisma.employee.findUnique({ where: { id: B.id } })).employeeCode
  r = await upload(owner, '/employees/documents/bulk', [{ field: 'files', data: PDF, name: `${code.toLowerCase()} - offer letter.pdf` }, { field: 'files', data: PDF, name: 'nobody.pdf' }, { field: 'files', data: Buffer.from('txt'), name: `${code}_notes.pdf` }], { category: 'offer_letter' })
  const res = r.body
  check('bulk upload matches files to people by their employee ID', r.status === 200 && res.uploaded === 1 && res.results.find((x) => x.status === 'uploaded').employeeCode === code, res)
  check('…and explains each file it could not take', res.results.filter((x) => x.status === 'error').length === 2 && res.results.some((x) => /employee ID/.test(x.error ?? '')), res.results)
  r = await upload(tB, '/employees/documents/bulk', [{ field: 'files', data: PDF, name: `${code}.pdf` }], { category: 'cv' })
  check('an employee cannot bulk upload (403)', r.status === 403, r.status)

  // ─── Expiry reminders ──────────────────────────────────────
  await api(owner, 'POST', '/system/jobs/document-expiry/run')
  const bUser = await prisma.user.findFirst({ where: { employee: { id: B.id } } })
  const first = await prisma.notification.count({ where: { tenantId: tenant.id, type: 'document.expiring' } })
  check('a document expiring in a week reminds the person and HR', first >= 2 && (await prisma.notification.count({ where: { userId: bUser.id, type: 'document.expiring' } })) === 1, first)
  await api(owner, 'POST', '/system/jobs/document-expiry/run')
  check('…once (running the job again sends nothing new)', (await prisma.notification.count({ where: { tenantId: tenant.id, type: 'document.expiring' } })) === first)

  // ─── Isolation ─────────────────────────────────────────────
  const admin = await tokenFor('admin@marichihr.com')
  r = await api(admin, 'GET', `/employees/${B.id}/documents/${hrDoc.id}/download`)
  check("another company cannot reach these files (404)", r.status === 404, r.status)

  // ─── Cleanup: files out of the bucket, company deactivated ─
  const docs = await prisma.employeeDocument.findMany({ where: { tenantId: tenant.id } })
  for (const d of docs) await storage().remove(d.fileKey).catch(() => {})
  check('test files removed from storage', (await Promise.all(docs.map((d) => storage().exists(d.fileKey)))).every((x) => !x))
  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  await prisma.user.updateMany({ where: { tenantId: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()

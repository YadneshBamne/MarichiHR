import { Router, RequestHandler } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { documentService, MAX_BYTES } from './documents.service'

// Employee documents. Mounted inside the employees router (after authentication, before its /:id routes).
const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 50 } })
// Multer's own errors (file too big, too many files) become plain 400s
const accept = (mw: RequestHandler): RequestHandler => (req, res, next) => mw(req, res, (err: any) => {
  if (!err) return next()
  next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 'Files can be up to 10 MB' : err.code === 'LIMIT_FILE_COUNT' ? 'Upload up to 50 files at a time' : 'The upload could not be read', 400))
})

const id = z.string().uuid()
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Meta = z.object({ category: z.string().trim().min(1).max(40), title: z.string().trim().max(160).optional(), expiryDate: ymd.optional().or(z.literal('').transform(() => undefined)), visibility: z.enum(['employee', 'hr']).optional() }).strict()

export const documentsRouter = Router()
const p = (req: any, k = 'id') => String(req.params[k])

documentsRouter.post('/documents/bulk', requireRoles('hr_admin', 'system_admin'), accept(memory.array('files', 50)), asyncHandler(async (req, res) => {
  const body = Meta.pick({ category: true, visibility: true }).parse(req.body)
  res.json({ success: true, data: await documentService.bulk(req.user!, (req.files as any[]) ?? [], body) })
}))
documentsRouter.get('/:id/documents', validate(z.object({ params: z.object({ id }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await documentService.list(req.user!, p(req)) })
}))
documentsRouter.post('/:id/documents', validate(z.object({ params: z.object({ id }) })), accept(memory.single('file')), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await documentService.upload(req.user!, p(req), req.file as any, Meta.parse(req.body)) })
}))
documentsRouter.get('/:id/documents/:docId/download', validate(z.object({ params: z.object({ id, docId: id }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await documentService.download(req.user!, p(req), p(req, 'docId')) })
}))
documentsRouter.delete('/:id/documents/:docId', validate(z.object({ params: z.object({ id, docId: id }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await documentService.archive(req.user!, p(req), p(req, 'docId')) })
}))

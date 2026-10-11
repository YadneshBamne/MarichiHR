import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { recruitmentService as svc } from './recruitment.service'

const id = z.object({ id: z.string().uuid() })
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const money = z.number().positive().max(1_000_000_000)
const uuidOrNull = z.string().uuid().nullable()
const openingFields = {
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(5000),
  orgUnitId: z.string().uuid(),
  jobPositionId: uuidOrNull,
  workLocationId: uuidOrNull,
  employmentType: z.enum(['full_time', 'part_time', 'contractor', 'intern']),
  openings: z.number().int().min(1).max(500),
  salaryMin: money.nullable(),
  salaryMax: money.nullable(),
  hiringManagerId: uuidOrNull,
}
const CreateOpening = z.object({ body: z.object(openingFields).partial().required({ title: true, orgUnitId: true }).strict() })
const UpdateOpening = z.object({ params: id, body: z.object({ ...openingFields, status: z.enum(['open', 'on_hold', 'closed']), closedReason: z.string().trim().max(300).nullable() }).partial().strict() })
const Decide = z.object({ params: id, body: z.object({ note: z.string().trim().min(1).max(500).optional() }).strict() })
const candidateFields = {
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(40).nullable().optional(),
  resumeUrl: z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Use an http(s) link').nullable().optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
}
const AddCandidate = z.object({ params: id, body: z.object({ ...candidateFields, source: z.enum(['direct', 'job_board', 'careers', 'agency', 'other']).optional() }).strict() })
const Refer = z.object({ params: id, body: z.object(candidateFields).strict() })
const UpdateCandidate = z.object({ params: id, body: z.object({
  stage: z.enum(['applied', 'screening', 'interview', 'rejected', 'withdrawn']).optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  rejectionReason: z.string().trim().min(2).max(500).optional(),
  summary: candidateFields.summary, resumeUrl: candidateFields.resumeUrl, phone: candidateFields.phone,
}).strict() })
const Schedule = z.object({ params: id, body: z.object({ interviewerUserId: z.string().uuid(), scheduledAt: z.string().datetime({ offset: true }), mode: z.enum(['video', 'phone', 'in_person']).optional() }).strict() })
const Feedback = z.object({ params: id, body: z.object({ rating: z.number().int().min(1).max(5), recommendation: z.enum(['strong_hire', 'hire', 'no_hire', 'strong_no_hire']), feedback: z.string().trim().min(5).max(5000) }).strict() })
const Offer = z.object({ params: id, body: z.object({ ctcAnnual: money, joiningDate: ymd, note: z.string().trim().max(1000).optional() }).strict() })
const OfferResponse = z.object({ params: id, body: z.object({ accepted: z.boolean() }).strict() })
const Hire = z.object({ params: id, body: z.object({ workEmail: z.string().trim().email().max(200), orgUnitId: z.string().uuid().optional(), managerId: uuidOrNull.optional(), jobPositionId: uuidOrNull.optional(), hireDate: ymd.optional(), referralBonus: money.optional() }).strict() })

export const recruitmentRouter = Router()
recruitmentRouter.use(authenticate)
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data })
const p = (req: any) => String(req.params.id)

recruitmentRouter.get('/openings', asyncHandler(async (req, res) => ok(res, await svc.openings(req.user!))))
recruitmentRouter.post('/openings', validate(CreateOpening), asyncHandler(async (req, res) => ok(res, await svc.createOpening(req.user!, req.body), 201)))
recruitmentRouter.get('/openings/:id', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await svc.opening(req.user!, p(req)))))
recruitmentRouter.patch('/openings/:id', validate(UpdateOpening), asyncHandler(async (req, res) => ok(res, await svc.updateOpening(req.user!, p(req), req.body))))
recruitmentRouter.post('/openings/:id/approve', validate(Decide), asyncHandler(async (req, res) => ok(res, await svc.decideOpening(req.user!, p(req), true, req.body.note))))
recruitmentRouter.post('/openings/:id/reject', validate(Decide), asyncHandler(async (req, res) => ok(res, await svc.decideOpening(req.user!, p(req), false, req.body.note))))
recruitmentRouter.post('/openings/:id/candidates', validate(AddCandidate), asyncHandler(async (req, res) => ok(res, await svc.addCandidate(req.user!, p(req), req.body, false), 201)))
recruitmentRouter.post('/openings/:id/refer', validate(Refer), asyncHandler(async (req, res) => ok(res, await svc.addCandidate(req.user!, p(req), req.body, true), 201)))

recruitmentRouter.get('/referrals/mine', asyncHandler(async (req, res) => ok(res, await svc.myReferrals(req.user!))))
recruitmentRouter.get('/interviews/mine', asyncHandler(async (req, res) => ok(res, await svc.myInterviews(req.user!))))
recruitmentRouter.post('/interviews/:id/feedback', validate(Feedback), asyncHandler(async (req, res) => ok(res, await svc.feedback(req.user!, p(req), req.body))))
recruitmentRouter.post('/interviews/:id/cancel', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await svc.cancelInterview(req.user!, p(req)))))

recruitmentRouter.get('/candidates/:id', validate(z.object({ params: id })), asyncHandler(async (req, res) => ok(res, await svc.candidate(req.user!, p(req)))))
recruitmentRouter.patch('/candidates/:id', validate(UpdateCandidate), asyncHandler(async (req, res) => ok(res, await svc.updateCandidate(req.user!, p(req), req.body))))
recruitmentRouter.post('/candidates/:id/interviews', validate(Schedule), asyncHandler(async (req, res) => ok(res, await svc.schedule(req.user!, p(req), req.body), 201)))
recruitmentRouter.post('/candidates/:id/offer', validate(Offer), asyncHandler(async (req, res) => ok(res, await svc.offer(req.user!, p(req), req.body))))
recruitmentRouter.post('/candidates/:id/offer-response', validate(OfferResponse), asyncHandler(async (req, res) => ok(res, await svc.offerResponse(req.user!, p(req), req.body.accepted))))
recruitmentRouter.post('/candidates/:id/hire', validate(Hire), asyncHandler(async (req, res) => ok(res, await svc.hire(req.user!, p(req), req.body), 201)))

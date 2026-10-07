import { Request, Response } from 'express'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { exitsService } from './exits.service'

const id = (req: Request) => String(req.params['id'])

export const exitsController = {
  initiate: asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ success: true, data: await exitsService.initiate(req.user!, req.body) })
  }),
  assignableUsers: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await exitsService.assignableUsers(req.user!) })
  }),
  list: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await exitsService.list(req.user!) })
  }),
  myClearances: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await exitsService.myClearances(req.user!) })
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await exitsService.get(id(req), req.user!) })
  }),
  sign: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await exitsService.signClearance(id(req), String(req.params['department']), req.user!, req.body.note) })
  }),
  compute: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await exitsService.compute(id(req), req.user!, req.body.recoveries) })
  }),
  approve: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await exitsService.approve(id(req), req.user!) })
  }),
  pay: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await exitsService.pay(id(req), req.user!) })
  }),
  cancel: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await exitsService.cancel(id(req), req.user!, req.body.reason) })
  }),
  pdf: asyncHandler(async (req: Request, res: Response) => {
    const { pdf, filename } = await exitsService.settlementPdf(id(req), req.user!)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', String(pdf.length))
    res.send(pdf)
  }),
}

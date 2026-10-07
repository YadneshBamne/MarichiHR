import { Request, Response, NextFunction } from 'express'
import { AppError } from '../shared/utils/AppError'
import { ZodError } from 'zod'

export function errorMiddleware(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
    })
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      fieldErrors: err.issues.map((e) => ({
        field: e.path.map(String).join('.'),
        message: e.message,
      })),
    })
  }

  console.error('Unhandled error:', err)

  return res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong',
  })
}

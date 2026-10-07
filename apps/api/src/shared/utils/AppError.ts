export class AppError extends Error {
  public statusCode: number
  public code: string
  public isOperational: boolean

  constructor(message: string, statusCode: number = 500, code?: string) {
    super(message)
    this.statusCode = statusCode
    this.code = code || this.deriveCode(statusCode)
    this.isOperational = true
    Error.captureStackTrace(this, this.constructor)
  }

  private deriveCode(statusCode: number): string {
    const codes: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE',
      500: 'INTERNAL_ERROR',
    }
    return codes[statusCode] || 'UNKNOWN_ERROR'
  }
}

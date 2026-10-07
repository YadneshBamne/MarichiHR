import { Request, Response, NextFunction } from 'express'

// Defence in depth: no JSON response may ever contain these keys, however the record was loaded
const REDACTED_KEYS = new Set(['bankAccountNo'])

export function redactSensitiveResponse(_req: Request, res: Response, next: NextFunction) {
  res.json = function (this: Response, body?: any) {
    const serialised = JSON.stringify(body, (key, value) => (REDACTED_KEYS.has(key) ? undefined : value))
    if (!this.get('Content-Type')) this.type('json')
    return this.send(serialised)
  } as Response['json']
  next()
}

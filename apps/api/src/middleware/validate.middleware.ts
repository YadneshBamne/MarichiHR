import { Request, Response, NextFunction } from 'express'
import { ZodObject, ZodRawShape } from 'zod'

export function validate(schema: ZodObject<ZodRawShape>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed: any = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      })
      // Hand services only what the schema declares (non-strict schemas strip unknown keys)
      if (parsed && parsed.body !== undefined) req.body = parsed.body
      next()
    } catch (err) {
      next(err)
    }
  }
}

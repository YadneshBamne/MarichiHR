import { AppError } from '../../shared/utils/AppError'

// Stands in for the Prisma client when the API runs on MongoDB (DB_PROVIDER=mongo). Modules that have not been ported yet
// still call prisma; here every such call answers 501 instead of reaching a database that holds none of the company's data.
// The error comes back as a rejected promise (never thrown on the spot) and is pre-handled, so a caller that builds several
// queries before awaiting them cannot turn the 501 into an unhandled rejection that stops the server.
const notPorted = (): Promise<never> => {
  const p = Promise.reject(new AppError('This feature is not available on the MongoDB version yet', 501, 'NOT_AVAILABLE_ON_MONGO'))
  p.catch(() => undefined)
  return p
}
const trap: any = new Proxy(notPorted, { get: (_t, p) => (p === 'then' ? undefined : trap), apply: notPorted })

export const prisma: any = new Proxy({}, {
  get: (_t, p) => (p === 'then' ? undefined : p === '$connect' || p === '$disconnect' ? async () => undefined : trap),
})

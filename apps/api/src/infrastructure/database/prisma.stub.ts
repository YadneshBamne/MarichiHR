// Stands in for the Prisma client when the API runs on MongoDB (DB_PROVIDER=mongo): the Prisma-compatible client in prisma.mongo.ts.
// Models that have not been enabled there yet still answer 501 NOT_AVAILABLE_ON_MONGO.
export { prisma } from './prisma.mongo'

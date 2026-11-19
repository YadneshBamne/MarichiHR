import path from 'path'

// The policies module is not ported to MongoDB yet, so no policy blocks anyone from working. Everything else the module
// exports is the original (it answers 501 through the Prisma stand-in when used).
// The original is loaded by absolute path: Node caches './policies.service' per directory, which would hand this file back to itself.
const original = require(path.join(__dirname, 'policies.service'))
module.exports = { ...original, blockingPolicies: async (_user: unknown): Promise<{ title: string }[]> => [] }

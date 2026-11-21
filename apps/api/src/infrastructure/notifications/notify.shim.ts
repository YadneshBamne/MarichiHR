import path from 'path'
import { User } from '../mongo/mongo'

// notify() and the transports are the original code (it runs on the Prisma-compatible client). Only the role lookup changes:
// on MongoDB a person's roles are embedded in the user document (users.userRoles[].roleName), not a user_roles table.
// The original is loaded by absolute path: Node caches './notify' per directory, which would hand this file back to itself.
const original = require(path.join(__dirname, 'notify'))
module.exports = {
  ...original,
  userIdsWithRole: async (tenantId: string, roleName: string): Promise<string[]> => {
    const now = new Date()
    const rows: any[] = await User.find({ tenantId, active: true, userRoles: { $elemMatch: { roleName, $or: [{ validUntil: null }, { validUntil: { $gt: now } }] } } }).select('_id').lean()
    return rows.map((u) => u._id as string)
  },
}

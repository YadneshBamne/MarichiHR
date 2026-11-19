import path from 'path'

// The bell is served from MongoDB; the scheduled-jobs admin router stays the original (it answers 501 until jobs are ported).
// The original is loaded by absolute path: Node caches './notifications.router' per directory, which would hand this file back to itself.
const original = require(path.join(__dirname, 'notifications.router'))
export { notificationsRouter } from '../dashboard/dashboard.router.mongo'
export const systemRouter = original.systemRouter

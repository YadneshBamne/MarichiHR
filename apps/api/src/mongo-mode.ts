import Module from 'module'
import path from 'path'

// Runs the API on MongoDB. Instead of editing every router and controller, the modules that touch the company's data are
// swapped for their MongoDB versions at load time: the existing routes, validation and permission checks stay as they are and
// call the MongoDB services (same export names, same responses). Anything not ported yet reaches the Prisma stand-in and
// answers 501 NOT_AVAILABLE_ON_MONGO. Import this file before anything else.

process.env.DB_PROVIDER = 'mongo'
process.env.JOBS_ENABLED ??= 'false' // scheduled jobs are opt-in on MongoDB: set JOBS_ENABLED=true to run the ones listed in JOBS_ONLY
// webhook-retry is left out: the in-process event pump retries webhooks itself
process.env.JOBS_ONLY ??= 'events-sweep,people-dates,leave-sla-escalation,absent-marking,contracts,position-changes,document-expiry,leave-year-end,absence-flags,leave-attendance-check,carry-forward-expiry,declaration-window,leave-accrual,geomark-purge,tracking-purge,helpdesk-maintenance'

const SWAPS: Record<string, string> = {
  'infrastructure/database/prisma': 'infrastructure/database/prisma.stub',
  'middleware/module.middleware': 'middleware/module.middleware.mongo',
  'shared/utils/access': 'shared/utils/access.mongo',
  'shared/utils/auditSignIn': 'shared/utils/auditSignIn.mongo',
  'modules/auth/auth.service': 'modules/auth/auth.mongo',
  'modules/auth/auth.repository': 'modules/auth/auth.mongo',
  'modules/company/company.service': 'modules/company/company.mongo',
  'modules/company/company.bootstrap': 'modules/company/company.bootstrap.mongo',
  'modules/company/setup.service': 'modules/company/setup.service.mongo',
  'modules/employees/employees.service': 'modules/employees/employees.service.mongo',
  'modules/employees/employees.repository': 'modules/employees/employees.mongo',
  'modules/employees/contracts.service': 'modules/employees/contracts.mongo',
  'modules/employees/contracts.repository': 'modules/employees/contracts.mongo',
  'modules/salary/salary.service': 'modules/salary/salary.mongo',
  'modules/salary/starter.service': 'modules/salary/starter.service.shim',
  'modules/payroll/payroll.service': 'modules/payroll/payroll.mongo',
  'modules/dashboard/dashboard.router': 'modules/dashboard/dashboard.router.mongo',
  'modules/notifications/notifications.router': 'modules/notifications/notifications.router.shim',
  'infrastructure/notifications/notify': 'infrastructure/notifications/notify.shim',
}

const root = __dirname.replace(/\\/g, '/')
const M = Module as any
const original = M._resolveFilename
M._resolveFilename = function (request: string, parent: any, ...rest: any[]) {
  const resolved: string = original.call(this, request, parent, ...rest)
  const from = String(parent?.filename ?? '').replace(/\\/g, '/')
  if (/\.(mongo|shim|stub)\.[jt]s$/.test(from) || /\.mongo\.check\.[jt]s$/.test(from)) return resolved // the swapped-in files read the originals when they need to
  const norm = resolved.replace(/\\/g, '/')
  if (!norm.startsWith(root)) return resolved
  const ext = path.extname(norm)
  const key = norm.slice(root.length + 1, norm.length - ext.length)
  const to = SWAPS[key]
  return to ? path.join(root, to) + ext : resolved
}

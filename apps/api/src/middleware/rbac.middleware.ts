import { Request, Response, NextFunction } from 'express'
import { AppError } from '../shared/utils/AppError'

const ROLE_PERMISSIONS: Record<string, string[]> = {
  employee: [
    'expenses:read', 'expenses:write',
    'employees:read',
    'leave:read', 'leave:write',
    'attendance:read', 'attendance:write',
    'payroll:read',
    'salary:read',
    'tax:read',
    'incentives:read',
    'policy:read',
    'forums:read', 'forums:write',
  ],
  manager: [
    'expenses:read', 'expenses:write', 'expenses:approve',
    'employees:read',
    'leave:read', 'leave:write', 'leave:approve',
    'attendance:read', 'attendance:write', 'attendance:approve',
    'payroll:read',
    'salary:read',
    'tax:read',
    'incentives:read', 'incentives:nominate',
    'policy:read',
    'forums:read', 'forums:write', 'forums:moderate',
  ],
  hr_admin: [
    'expenses:read', 'expenses:write', 'expenses:approve', 'expenses:finance', 'expenses:configure',
    'employees:read', 'employees:write',
    'leave:read', 'leave:write', 'leave:approve', 'leave:configure',
    'attendance:read', 'attendance:write', 'attendance:approve', 'attendance:lock',
    'payroll:read', 'payroll:run', 'payroll:disburse',
    'salary:read', 'salary:write', 'salary:configure',
    'tax:read', 'tax:configure', 'tax:file',
    'incentives:read', 'incentives:nominate', 'incentives:approve',
    'policy:read', 'policy:write', 'policy:publish',
    'forums:read', 'forums:write', 'forums:moderate',
    'audit:read',
  ],
  payroll_admin: [
    'expenses:read', 'expenses:finance', 'expenses:configure',
    'employees:read',
    'attendance:read', 'attendance:lock',
    'payroll:read', 'payroll:run', 'payroll:disburse',
    'salary:read',
    'tax:read',
  ],
  compliance_officer: [
    'employees:read',
    'payroll:read',
    'tax:read', 'tax:configure', 'tax:file',
    'audit:read',
  ],
  system_admin: [
    'employees:read', 'employees:write',
    'system:configure',
    'audit:read',
  ],
}

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const { roleIds } = req.user!

      const hasPermission = roleIds.some((roleId) => {
        const permissions = ROLE_PERMISSIONS[roleId] || []
        return permissions.includes(permission)
      })

      if (!hasPermission) {
        throw new AppError(`Access denied: ${permission}`, 403)
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}

// Role-name gate for endpoints whose audience is a staff group rather than a permission every employee holds
export function requireRoles(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user!.roleIds.some((r) => roles.includes(r))) {
      return next(new AppError("Access denied: restricted to " + roles.join(", "), 403))
    }
    next()
  }
}

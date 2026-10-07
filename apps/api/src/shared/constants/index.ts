export const ROLES = {
  EMPLOYEE: 'employee',
  MANAGER: 'manager',
  HR_ADMIN: 'hr_admin',
  PAYROLL_ADMIN: 'payroll_admin',
  COMPLIANCE_OFFICER: 'compliance_officer',
  SYSTEM_ADMIN: 'system_admin',
} as const

export const PERMISSIONS = {
  EMPLOYEES_READ: 'employees:read',
  EMPLOYEES_WRITE: 'employees:write',
  LEAVE_READ: 'leave:read',
  LEAVE_WRITE: 'leave:write',
  LEAVE_APPROVE: 'leave:approve',
  LEAVE_CONFIGURE: 'leave:configure',
  ATTENDANCE_READ: 'attendance:read',
  ATTENDANCE_WRITE: 'attendance:write',
  ATTENDANCE_APPROVE: 'attendance:approve',
  ATTENDANCE_LOCK: 'attendance:lock',
  PAYROLL_READ: 'payroll:read',
  PAYROLL_RUN: 'payroll:run',
  PAYROLL_DISBURSE: 'payroll:disburse',
  SALARY_READ: 'salary:read',
  SALARY_WRITE: 'salary:write',
  TAX_READ: 'tax:read',
  TAX_CONFIGURE: 'tax:configure',
  TAX_FILE: 'tax:file',
  INCENTIVES_READ: 'incentives:read',
  INCENTIVES_NOMINATE: 'incentives:nominate',
  INCENTIVES_APPROVE: 'incentives:approve',
  POLICY_READ: 'policy:read',
  POLICY_WRITE: 'policy:write',
  POLICY_PUBLISH: 'policy:publish',
  FORUMS_READ: 'forums:read',
  FORUMS_WRITE: 'forums:write',
  FORUMS_MODERATE: 'forums:moderate',
  AUDIT_READ: 'audit:read',
  SYSTEM_CONFIGURE: 'system:configure',
} as const

export const CONTRACT_STATUS = {
  NEW: 'new',
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
  RUNNING: 'running',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
} as const

export const LEAVE_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  RECALLED: 'recalled',
} as const

export const ATTENDANCE_STATUS = {
  PRESENT: 'present',
  ABSENT: 'absent',
  HALF_DAY: 'half_day',
  ON_LEAVE: 'on_leave',
  HOLIDAY: 'holiday',
  WEEK_OFF: 'week_off',
  LWP: 'lwp',
} as const

export const PAYROLL_STATUS = {
  DRAFT: 'draft',
  PROCESSING: 'processing',
  REVIEW: 'review',
  APPROVED: 'approved',
  DISBURSED: 'disbursed',
  LOCKED: 'locked',
} as const

export const EVENT_TYPES = {
  EMPLOYEE_CREATED: 'employee.created',
  EMPLOYEE_ARCHIVED: 'employee.archived',
  CONTRACT_ACTIVATED: 'contract.activated',
  CONTRACT_EXPIRED: 'contract.expired',
  CONTRACT_EXPIRING_SOON: 'contract.expiring.soon',
  LEAVE_SUBMITTED: 'leave.request.submitted',
  LEAVE_APPROVED: 'leave.request.approved',
  LEAVE_REJECTED: 'leave.request.rejected',
  LEAVE_SLA_BREACHED: 'leave.sla.breached',
  ATTENDANCE_EXCEPTION: 'attendance.exception.flagged',
  ATTENDANCE_LOCKED: 'attendance.locked',
  PAYROLL_CYCLE_STARTED: 'payroll.cycle.started',
  PAYROLL_CYCLE_DISBURSED: 'payroll.cycle.disbursed',
  PAYSLIP_RELEASED: 'payslip.released',
  STATUTORY_FILING_SUBMITTED: 'statutory.filing.submitted',
  STATUTORY_FILING_ACKNOWLEDGED: 'statutory.filing.acknowledged',
  STATUTORY_FILING_FAILED: 'statutory.filing.failed',
  INCENTIVE_APPROVED: 'incentive.nomination.approved',
  POLICY_PUBLISHED: 'policy.published',
  GRIEVANCE_RAISED: 'grievance.raised',
} as const

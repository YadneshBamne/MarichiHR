// Apps a company can install. Core (people, approvals, activities, notifications, settings) is always on.
export const APP_KEYS = ['leave', 'attendance', 'payroll', 'expenses', 'exits'] as const
export type AppKey = (typeof APP_KEYS)[number]
export const ALL_APPS: AppKey[] = [...APP_KEYS]

export const ROLE_DEFS = [
  { name: 'employee', description: 'Standard employee: self-service access' },
  { name: 'manager', description: 'Team manager: approves team leave and attendance' },
  { name: 'hr_admin', description: 'HR administrator: organisation-wide people access' },
  { name: 'payroll_admin', description: 'Payroll administrator: runs and disburses payroll' },
  { name: 'compliance_officer', description: 'Compliance officer: statutory configuration and filing' },
  { name: 'system_admin', description: 'System administrator: company settings, apps and access' },
]
export const ASSIGNABLE_ROLES = ROLE_DEFS.map((r) => r.name)

// Sensible starting leave types; HR adapts them on the Leave types screen
export const DEFAULT_LEAVE_TYPES = [
  { name: 'Annual Leave', code: 'ANNUAL', category: 'annual', isPaid: true, accrualType: 'monthly_prorate', accrualAmount: 1.67, accrualDayOfMonth: 1, carryForward: true, carryForwardMax: 10, carryForwardExpiryMonths: 3, encashable: true, halfDayAllowed: true, approvalLevels: 1 },
  { name: 'Sick Leave', code: 'SICK', category: 'sick', isPaid: true, accrualType: 'annual_lumpsum', accrualAmount: 10, halfDayAllowed: true, approvalLevels: 1, attachmentRequiredAfterDays: 3 },
  { name: 'Casual Leave', code: 'CASUAL', category: 'casual', isPaid: true, accrualType: 'annual_lumpsum', accrualAmount: 6, halfDayAllowed: true, approvalLevels: 1 },
  { name: 'Maternity Leave', code: 'MATERNITY', category: 'maternity', isPaid: true, isStatutory: true, accrualType: 'manual', accrualAmount: 90, halfDayAllowed: false, approvalLevels: 2, requiresHrForStatutory: true },
  { name: 'Paternity Leave', code: 'PATERNITY', category: 'paternity', isPaid: true, isStatutory: true, accrualType: 'manual', accrualAmount: 5, halfDayAllowed: false, approvalLevels: 2, requiresHrForStatutory: true },
  { name: 'Leave Without Pay', code: 'LWP', category: 'unpaid', isPaid: false, accrualType: 'manual', accrualAmount: 0, halfDayAllowed: true, approvalLevels: 2, sandwichRule: true },
  { name: 'Compensatory Off', code: 'COMPOFF', category: 'compensatory', isPaid: true, accrualType: 'manual', accrualAmount: 0, carryForward: true, carryForwardMax: 5, carryForwardExpiryMonths: 1, halfDayAllowed: true, approvalLevels: 1 },
  { name: 'Bereavement Leave', code: 'BEREAVEMENT', category: 'bereavement', isPaid: true, accrualType: 'manual', accrualAmount: 3, halfDayAllowed: false, approvalLevels: 1 },
]

export const DEFAULT_ACTIVITY_TYPES = [
  { name: 'Phone Call', icon: 'phone', defaultDays: 1 },
  { name: 'Email', icon: 'mail', defaultDays: 1 },
  { name: 'Meeting', icon: 'users', defaultDays: 1 },
  { name: 'Document Upload', icon: 'file', defaultDays: 3 },
  { name: 'Follow-up', icon: 'clock', defaultDays: 2 },
  { name: 'Review', icon: 'eye', defaultDays: 3 },
  { name: 'Contract Review', icon: 'file-text', defaultDays: 5 },
  { name: 'Onboarding Task', icon: 'check-square', defaultDays: 7 },
]

export const DEFAULT_EXPENSE_CATEGORIES = [
  { name: 'Travel', code: 'TRAVEL', receiptRequiredAbove: 100 },
  { name: 'Meals', code: 'MEALS', maxAmount: 150, enforceLimit: true },
  { name: 'Accommodation', code: 'ACCOM', receiptRequiredAbove: 100 },
  { name: 'Communication', code: 'COMM' },
  { name: 'Other', code: 'OTHER' },
]

export const DEFAULT_INPUT_TYPES = [
  { name: 'Manual Bonus', code: 'MANUAL_BONUS', category: 'earnings', description: 'One-off bonus payment' },
  { name: 'Advance Recovery', code: 'ADVANCE_REC', category: 'deductions', description: 'Recovery of salary advance' },
  { name: 'Referral Bonus', code: 'REFERRAL', category: 'earnings', description: 'Employee referral bonus' },
  { name: 'Salary Arrear', code: 'ARREAR', category: 'earnings', description: 'Arrear payment from prior period' },
  { name: 'Leave Encashment', code: 'LEAVE_ENCASH', category: 'earnings', description: 'Leave balance encashment' },
  { name: 'Loan Recovery', code: 'LOAN_REC', category: 'deductions', description: 'Monthly loan EMI recovery' },
]

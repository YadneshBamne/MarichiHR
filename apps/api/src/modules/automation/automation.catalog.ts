// What automation rules and webhooks can listen to. Each trigger lists the fields its conditions and message
// templates may use; every trigger about a person also gets the employee.* fields (filled in when the rule runs).
export type FieldType = 'text' | 'number' | 'date'
export interface TriggerField { key: string; label: string; type: FieldType }
export interface Trigger { key: string; label: string; group: string; fields: TriggerField[]; person: boolean; link?: (p: any) => string }

const f = (key: string, label: string, type: FieldType = 'text'): TriggerField => ({ key, label, type })

export const EMPLOYEE_FIELDS: TriggerField[] = [
  f('employee.name', 'Employee name'), f('employee.employeeCode', 'Employee ID'), f('employee.department', 'Department'),
  f('employee.workLocation', 'Office'), f('employee.employmentType', 'Employment type'), f('employee.taxCountry', 'Tax country'),
  f('employee.manager', 'Manager name'), f('employee.hireDate', 'Joining date', 'date'),
]

export const TRIGGERS: Trigger[] = [
  { key: 'employee.created', label: 'Someone joins (employee added)', group: 'People', person: true, fields: [], link: (p) => `/employees/${p.employeeId}` },
  { key: 'employee.updated', label: 'An employee record changes', group: 'People', person: true, fields: [f('changes', 'Changed fields')], link: (p) => `/employees/${p.employeeId}` },
  { key: 'employee.archived', label: 'An employee is archived', group: 'People', person: true, fields: [f('reason', 'Reason')] },
  { key: 'employee.birthday', label: 'Birthday (daily check)', group: 'People', person: true, fields: [f('date', 'Date', 'date')], link: (p) => `/employees/${p.employeeId}` },
  { key: 'employee.work_anniversary', label: 'Work anniversary (daily check)', group: 'People', person: true, fields: [f('years', 'Years of service', 'number'), f('date', 'Date', 'date')], link: (p) => `/employees/${p.employeeId}` },
  { key: 'employee.probation.ending', label: 'Probation ending (7 days before and on the day)', group: 'People', person: true, fields: [f('daysRemaining', 'Days remaining', 'number'), f('probationEndDate', 'Probation end date', 'date')], link: (p) => `/employees/${p.employeeId}` },
  { key: 'leave.request.submitted', label: 'Leave is applied for', group: 'Leave', person: true, fields: [f('leaveTypeName', 'Leave type'), f('totalDays', 'Days', 'number'), f('startDate', 'From', 'date'), f('endDate', 'To', 'date')], link: () => '/approvals' },
  { key: 'leave.request.approved', label: 'Leave is approved', group: 'Leave', person: true, fields: [f('leaveTypeName', 'Leave type'), f('totalDays', 'Days', 'number'), f('startDate', 'From', 'date'), f('endDate', 'To', 'date')], link: () => '/leave' },
  { key: 'leave.request.rejected', label: 'Leave is rejected', group: 'Leave', person: true, fields: [f('reason', 'Reason')], link: () => '/leave' },
  { key: 'leave.approval.escalated', label: 'A leave approval is overdue', group: 'Leave', person: true, fields: [f('slaHours', 'SLA hours', 'number')], link: () => '/approvals' },
  { key: 'attendance.absent.marked', label: 'Someone is marked absent', group: 'Attendance', person: true, fields: [f('date', 'Dates')], link: () => '/attendance' },
  { key: 'attendance.exception.flagged', label: 'An attendance exception is flagged', group: 'Attendance', person: true, fields: [f('exceptionType', 'Exception'), f('date', 'Date', 'date')], link: () => '/attendance' },
  { key: 'contract.activated', label: 'A contract starts', group: 'Contracts', person: true, fields: [], link: (p) => `/employees/${p.employeeId}` },
  { key: 'contract.expiring.soon', label: 'A contract is about to expire', group: 'Contracts', person: true, fields: [f('daysRemaining', 'Days remaining', 'number')], link: (p) => `/employees/${p.employeeId}` },
  { key: 'contract.expired', label: 'A contract expires', group: 'Contracts', person: true, fields: [], link: (p) => `/employees/${p.employeeId}` },
  { key: 'exit.initiated', label: 'An exit is started', group: 'Exits', person: true, fields: [f('exitType', 'Exit type'), f('lastWorkingDate', 'Last working day', 'date')], link: (p) => `/exits/${p.exitId}` },
  { key: 'exit.clearance.completed', label: 'All exit clearances are signed', group: 'Exits', person: true, fields: [], link: (p) => `/exits/${p.exitId}` },
  { key: 'exit.cancelled', label: 'An exit is cancelled', group: 'Exits', person: true, fields: [f('reason', 'Reason')], link: (p) => `/exits/${p.exitId}` },
  { key: 'fnf.paid', label: 'A final settlement is paid', group: 'Exits', person: true, fields: [f('netPayable', 'Net payable', 'number'), f('currency', 'Currency')], link: (p) => `/exits/${p.exitId}` },
  { key: 'payroll.cycle.disbursed', label: 'A payroll run is paid', group: 'Payroll', person: false, fields: [], link: (p) => `/payroll/cycles/${p.payrollCycleId}` },
  { key: 'payslip.released', label: 'A payslip is released', group: 'Payroll', person: true, fields: [f('netPay', 'Net pay', 'number'), f('currency', 'Currency')], link: () => '/payroll' },
  { key: 'policy.published', label: 'A policy is published', group: 'Workplace', person: false, fields: [f('version', 'Version', 'number')], link: (p) => `/policies/${p.policyId}` },
  { key: 'announcement.published', label: 'An announcement is published', group: 'Workplace', person: false, fields: [], link: () => '/announcements' },
  // Never carries who raised it: anonymity holds for automations and webhooks too
  { key: 'grievance.raised', label: 'A grievance is raised', group: 'Workplace', person: false, fields: [], link: (p) => `/grievances/${p.grievanceId}` },
]
export const TRIGGER = Object.fromEntries(TRIGGERS.map((t) => [t.key, t]))

export const OPS = ['eq', 'neq', 'in', 'contains', 'gt', 'gte', 'lt', 'lte', 'set', 'not_set'] as const
export const RECIPIENTS = ['employee', 'manager', 'hr_admin', 'payroll_admin', 'system_admin'] as const

import type { IconName } from '../components/ui/Icon'

// Installable apps (mirrors apps/api company.catalog APP_KEYS). People, approvals, activities and settings are core.
export type AppKey = 'leave' | 'attendance' | 'payroll' | 'expenses' | 'exits'

export interface AppDef { key: AppKey; name: string; icon: IconName; tagline: string; features: string[]; tint: string }

export const APPS: AppDef[] = [
  { key: 'attendance', name: 'Attendance', icon: 'clock', tint: '#f6c343', tagline: 'Clock in, timesheets, overtime and fixes for missed punches.', features: ['Web clock-in with location', 'Monthly timesheets', 'Overtime and regularisation approvals', 'Nightly absence marking'] },
  { key: 'leave', name: 'Leave', icon: 'leaf', tint: '#cfd9c4', tagline: 'Leave types, balances, requests and approvals.', features: ['Accrual and carry-forward rules', 'Team calendar', 'Approval SLAs with escalation', 'Half days and attachments'] },
  { key: 'payroll', name: 'Payroll', icon: 'wallet', tint: '#e9c9a1', tagline: 'Salary structures, payroll runs, payslips and bank files.', features: ['Formula-based salary rules', 'HR and finance sign-off', 'Payslip PDFs', 'Bank file and GL export'] },
  { key: 'expenses', name: 'Expenses', icon: 'receipt', tint: '#c7dbe6', tagline: 'Claims, per diems and reimbursement through payroll.', features: ['Receipts and limits per category', 'Manager and finance approval', 'Multi-currency with FX', 'Paid with the next payroll'] },
  { key: 'exits', name: 'Exits', icon: 'door', tint: '#d9cbe6', tagline: 'Resignations, clearance and full & final settlement.', features: ['Notice period tracking', 'Department clearance', 'Full & final computation', 'Maker-checker payment'] },
]

export const appByKey = (k: string) => APPS.find((a) => a.key === k)

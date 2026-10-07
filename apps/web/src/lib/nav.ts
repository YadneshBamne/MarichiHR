import type { IconName } from '../components/ui/Icon'
import type { AppKey } from './apps'

// The product map. `soon` modules are on the roadmap: they show in navigation with a "Soon" tag and open a preview page.
export interface NavItem {
  label: string
  path: string
  icon: IconName
  roles?: string[] // any of these role names; omitted = everyone
  app?: AppKey // hidden unless the company installed this app
  soon?: { phase: string; blurb: string; features: string[] }
  keywords?: string
}
export interface NavSection { key: string; label: string; icon: IconName; items: NavItem[] }

const HR = ['hr_admin', 'system_admin']
const STAFF = ['hr_admin', 'payroll_admin', 'compliance_officer']

export const SECTIONS: NavSection[] = [
  { key: 'overview', label: 'Overview', icon: 'home', items: [{ label: 'Dashboard', path: '/dashboard', icon: 'home', keywords: 'home today' }] },
  {
    key: 'people', label: 'People', icon: 'users', items: [
      { label: 'Directory', path: '/employees', icon: 'users', roles: HR, keywords: 'employees staff team' },
      { label: 'Exits', path: '/exits', icon: 'door', app: 'exits', keywords: 'offboarding resignation full and final settlement' },
      { label: 'Org chart', path: '/soon/org-chart', icon: 'layers', soon: { phase: 'Phase 5', blurb: 'See the whole organisation as an interactive tree, from board to every team.', features: ['Drag to explore departments and reporting lines', 'Open counts and vacancies per unit', 'Export as PDF for board packs'] } },
      { label: 'Recruitment', path: '/soon/recruitment', icon: 'briefcase', roles: HR, soon: { phase: 'Later', blurb: 'Requisitions, candidates and offers that flow straight into onboarding.', features: ['Job requisitions with approval', 'Candidate pipeline and interview kits', 'Offer letters that create the employee record'] } },
    ],
  },
  {
    key: 'time', label: 'Time', icon: 'clock', items: [
      { label: 'Leave', path: '/leave', icon: 'leaf', app: 'leave', keywords: 'holiday vacation time off balance' },
      { label: 'Attendance', path: '/attendance', icon: 'clock', app: 'attendance', keywords: 'clock in out regularisation overtime' },
      { label: 'Leave types', path: '/leave-types', icon: 'sliders', roles: ['hr_admin'], app: 'leave', keywords: 'leave policy accrual configuration' },
      { label: 'Holidays', path: '/soon/holidays', icon: 'calendar', soon: { phase: 'Phase 3', blurb: 'Country holiday calendars that drive leave, attendance and payroll.', features: ['Calendars per country and location', 'Optional holidays with quotas', 'Import official lists each year'] } },
    ],
  },
  {
    key: 'pay', label: 'Pay', icon: 'wallet', items: [
      { label: 'Payroll', path: '/payroll', icon: 'wallet', app: 'payroll', keywords: 'payslips salary cycles bank file' },
      { label: 'Expenses', path: '/expenses', icon: 'receipt', app: 'expenses', keywords: 'claims reimbursements per diem' },
      { label: 'Compensation', path: '/compensation', icon: 'sliders', roles: STAFF, app: 'payroll', keywords: 'salary structures rules grade bands contracts' },
      { label: 'Tax & compliance', path: '/soon/tax', icon: 'scale', soon: { phase: 'Phase 3', blurb: 'Versioned statutory tables and filings for every country you employ in.', features: ['Zambia PAYE, NAPSA and NHIMA tables by effective date', 'India TDS (cumulative), Kenya and Nigeria', 'Tax declarations, certificates and statutory filing exports'] } },
      { label: 'Incentives', path: '/soon/incentives', icon: 'gift', soon: { phase: 'Phase 4', blurb: 'Bonuses, commissions and recognition paid through payroll.', features: ['Nominations with approval', 'Commission plans and targets', 'Payouts posted as payroll inputs'] } },
    ],
  },
  {
    key: 'work', label: 'Work', icon: 'checkCircle', items: [
      { label: 'Approvals', path: '/approvals', icon: 'checkCircle', roles: ['manager', ...HR], keywords: 'pending requests inbox' },
      { label: 'Activities', path: '/activities', icon: 'list', keywords: 'tasks to do follow ups' },
      { label: 'Policies', path: '/soon/policies', icon: 'book', soon: { phase: 'Phase 4', blurb: 'Publish handbooks and policies, and track who has read and accepted them.', features: ['Versioned policies with publish workflow', 'Read and accept tracking', 'Reminders for pending acknowledgements'] } },
      { label: 'Grievances', path: '/soon/grievances', icon: 'flag', soon: { phase: 'Phase 4', blurb: 'A confidential way to raise and resolve concerns.', features: ['Anonymous or named submissions', 'Case handling with restricted access', 'Resolution timelines and audit'] } },
      { label: 'Forums', path: '/soon/forums', icon: 'message', soon: { phase: 'Phase 4', blurb: 'Company-wide discussions and announcements.', features: ['Channels by team or topic', 'Announcements with read receipts', 'Moderation tools'] } },
    ],
  },
  {
    key: 'insights', label: 'Insights', icon: 'chart', items: [
      { label: 'Reports', path: '/soon/reports', icon: 'chart', roles: [...HR, 'payroll_admin'], soon: { phase: 'Phase 5', blurb: 'Headcount, attrition, leave and payroll analytics with exports.', features: ['Ready-made people and payroll reports', 'Filters by unit, location and period', 'Scheduled exports to CSV and PDF'] } },
      { label: 'Audit log', path: '/soon/audit', icon: 'audit', roles: [...HR, 'compliance_officer'], soon: { phase: 'Phase 5', blurb: 'Every sensitive change, who made it and when, searchable.', features: ['Filter by person, record and action', 'Before and after values', 'Export for auditors'] } },
    ],
  },
]

export const SETTINGS_PATH = '/settings'
export const ALL_ITEMS = SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, section: s })))

export const canSee = (item: NavItem, roleNames: string[], apps?: string[]) =>
  (!item.roles || item.roles.some((r) => roleNames.includes(r))) && (!item.app || !apps || apps.includes(item.app))

export function visibleSections(roleNames: string[], apps?: string[]) {
  return SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => canSee(i, roleNames, apps)) })).filter((s) => s.items.length)
}

export function sectionFor(pathname: string) {
  const p = pathname === '/' ? '/dashboard' : pathname
  return SECTIONS.find((s) => s.items.some((i) => p === i.path || p.startsWith(i.path + '/'))) ?? null
}

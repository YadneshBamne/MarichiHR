// Notification categories people can tune. The bell always keeps every notification; email and WhatsApp follow the
// person's choice per category. Mandatory categories (pay, policies to acknowledge) always go out.
export const CATEGORIES = [
  { key: 'approvals', label: 'Approvals and requests', hint: 'Leave, attendance, expenses and pre-approvals waiting for you or decided', prefixes: ['approval.', 'leave.', 'attendance.', 'expense', 'pre_approval.', 'overtime'], mandatory: false },
  { key: 'pay', label: 'Pay', hint: 'Payslips, salary revisions, awards and final settlements', prefixes: ['payslip.', 'salary.', 'payroll.', 'incentive.', 'fnf.'], mandatory: true },
  { key: 'performance', label: 'Goals and reviews', hint: 'Goals to accept, reviews and acknowledgements', prefixes: ['performance.'], mandatory: false },
  { key: 'people', label: 'People and records', hint: 'Profile requests, documents, contracts, hiring and exits', prefixes: ['profile.', 'document.', 'contract.', 'recruitment.', 'exit.'], mandatory: false },
  { key: 'policies', label: 'Policies', hint: 'New policies to read and acknowledge', prefixes: ['policy.'], mandatory: true },
  { key: 'workplace', label: 'Workplace', hint: 'Announcements, grievances, forums and recognition', prefixes: ['announcement', 'grievance.', 'forum.', 'kudos.'], mandatory: false },
  { key: 'other', label: 'Everything else', hint: 'Reminders and automation alerts', prefixes: [], mandatory: false },
] as const

export type CategoryKey = (typeof CATEGORIES)[number]['key']
export type Prefs = Partial<Record<CategoryKey, { email?: boolean; whatsapp?: boolean }>>

export const categoryOf = (type: string): (typeof CATEGORIES)[number] =>
  CATEGORIES.find((c) => c.prefixes.some((p) => type.startsWith(p))) ?? CATEGORIES[CATEGORIES.length - 1]

// Channels default to on: people opt out
export function wants(prefs: unknown, type: string, channel: 'email' | 'whatsapp') {
  const c = categoryOf(type)
  if (c.mandatory) return true
  return (prefs as Prefs | null)?.[c.key]?.[channel] !== false
}

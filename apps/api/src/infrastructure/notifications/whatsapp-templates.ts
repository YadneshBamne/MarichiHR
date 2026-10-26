// WhatsApp message templates (Meta Cloud API). Business-started messages must use a template Meta has approved, so
// every notification type maps to one of these. Each body has {{1}} = the person's first name and {{2}} = a one-line
// detail (the notification title); the button opens the notification's page in the app.
// Submit them in Meta Business Manager › WhatsApp Manager › Message templates exactly as written here (category
// Utility, language English), then set WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and add "whatsapp" to NOTIFY_CHANNELS.

export interface WaTemplate { name: string; body: string; example: [string, string]; types: string[] }

export const WA_TEMPLATES: WaTemplate[] = [
  { name: 'marichihr_approval_waiting', body: 'Hello {{1}}, a request is waiting for your approval in MarichiHR: {{2}}. Please review it in the app.', example: ['Mwila', 'Leave request from Ellen Banda, 3 days'],
    types: ['approval.', 'leave.approval.', 'pre_approval.for_finance', 'payroll.signoff', 'tax.override_requested', 'incentive.nominated', 'profile.submitted', 'recruitment.opening_requested', 'privacy.erasure_requested'] },
  { name: 'marichihr_leave_update', body: 'Hello {{1}}, there is an update on your leave in MarichiHR: {{2}}.', example: ['Ellen', 'Your annual leave for 9 to 11 November was approved'],
    types: ['leave.'] },
  { name: 'marichihr_payslip_ready', body: 'Hello {{1}}, {{2}}. You can view and download it in MarichiHR under My payslips.', example: ['Ellen', 'Your payslip for October 2026 is ready'],
    types: ['payslip.released'] },
  { name: 'marichihr_pay_update', body: 'Hello {{1}}, there is an update about pay in MarichiHR: {{2}}.', example: ['Ellen', 'Your tax declaration is verified'],
    types: ['payroll.', 'salary.', 'incentive.', 'tax.', 'fnf.'] },
  { name: 'marichihr_attendance_alert', body: 'Hello {{1}}, please check your attendance in MarichiHR: {{2}}.', example: ['Ellen', 'You were marked absent on 23 October'],
    types: ['attendance.'] },
  { name: 'marichihr_policy_action', body: 'Hello {{1}}, {{2}}. Please read it in MarichiHR and accept it if you are asked to.', example: ['Ellen', 'A new policy was published: Site safety rules'],
    types: ['policy.'] },
  { name: 'marichihr_task_assigned', body: 'Hello {{1}}, you have something to do in MarichiHR: {{2}}.', example: ['Mwila', 'Please complete your profile details'],
    types: ['activity.', 'automation:', 'profile.', 'document.', 'leave.mismatch', 'performance.'] },
  { name: 'marichihr_company_news', body: 'Hello {{1}}, there is news from your company on MarichiHR: {{2}}.', example: ['Ellen', 'Q4 townhall on Friday at 10:00'],
    types: ['announcement', 'forum.pinned', 'forum.event', 'kudos.'] },
  // Grievances are confidential: only the case number goes out, never the subject
  { name: 'marichihr_case_update', body: 'Hello {{1}}, there is an update on your case {{2}} in MarichiHR. Please open the app to read it.', example: ['Ellen', 'GRV-0012'],
    types: ['grievance.'] },
  { name: 'marichihr_general_update', body: 'Hello {{1}}, you have a new notification in MarichiHR: {{2}}.', example: ['Ellen', 'Your expense claim was paid'],
    types: [] },
]

export const templateFor = (type: string) => WA_TEMPLATES.find((t) => t.types.some((p) => type.startsWith(p))) ?? WA_TEMPLATES[WA_TEMPLATES.length - 1]

// Meta refuses variables with new lines, tabs or more than four spaces in a row
export const waVar = (s: string, max = 200) => s.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, max) || '-'

// The detail sent for a notification; grievances send only their case number
export function detailFor(type: string, title: string) {
  if (type.startsWith('grievance.')) return title.match(/[A-Z]{2,}-\d{3,}(-\d+)?/)?.[0] ?? 'your case'
  return title
}

if (require.main === module) {
  console.assert(templateFor('leave.approval.requested').name === 'marichihr_approval_waiting', 'approvals win over leave updates')
  console.assert(templateFor('leave.returned').name === 'marichihr_leave_update')
  console.assert(templateFor('grievance.reply').name === 'marichihr_case_update' && detailFor('grievance.reply', 'New message on GRV-0012') === 'GRV-0012', 'no grievance details')
  console.assert(templateFor('something.new').name === 'marichihr_general_update')
  console.assert(waVar('a\nb c     d') === 'a b c   d', 'no new lines, at most three spaces')
  console.log('whatsapp templates ok')
}

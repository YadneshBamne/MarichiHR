// Every company-editable choice list, with the values each company starts with. Codes are stable and stored on
// records; companies rename labels, reorder, retire values and add their own. `meta` carries behaviour for logic
// (e.g. which side ends employment for an exit type). Lists with their own tables and screens (departments,
// positions, locations, grades, leave types, holidays, expense categories, pay components) are linked from the
// Masters page instead.

export interface MasterDefault { code: string; label: string; meta?: Record<string, unknown> }
export interface MasterList { key: string; name: string; group: 'People' | 'Identity & documents' | 'Organisation' | 'Hiring & exits' | 'Finance' | 'Time'; description: string; values: MasterDefault[] }

const v = (code: string, label: string, meta?: Record<string, unknown>): MasterDefault => ({ code, label, ...(meta && { meta }) })

export const MASTER_LISTS: MasterList[] = [
  // ─── People ────────────────────────────────────────────────
  { key: 'title', name: 'Title', group: 'People', description: 'Salutation before a name', values: [v('mr', 'Mr'), v('ms', 'Ms'), v('mrs', 'Mrs'), v('miss', 'Miss'), v('dr', 'Dr')] },
  { key: 'gender', name: 'Gender', group: 'People', description: 'Shown on the profile and used in reports', values: [v('male', 'Male'), v('female', 'Female'), v('non_binary', 'Non-binary'), v('prefer_not_to_say', 'Prefer not to say')] },
  { key: 'marital_status', name: 'Marital status', group: 'People', description: '', values: [v('single', 'Single'), v('married', 'Married'), v('divorced', 'Divorced'), v('widowed', 'Widowed'), v('separated', 'Separated')] },
  { key: 'blood_group', name: 'Blood group', group: 'People', description: 'For emergencies', values: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((g) => v(g.replace('+', '_pos').replace('-', '_neg').toLowerCase(), g)) },
  { key: 'nationality', name: 'Nationality', group: 'People', description: 'Codes are ISO country codes', values: [
    v('ZM', 'Zambian'), v('IN', 'Indian'), v('ZW', 'Zimbabwean'), v('MW', 'Malawian'), v('ZA', 'South African'), v('TZ', 'Tanzanian'), v('KE', 'Kenyan'),
    v('NG', 'Nigerian'), v('CD', 'Congolese (DRC)'), v('BW', 'Motswana'), v('NA', 'Namibian'), v('MZ', 'Mozambican'), v('AO', 'Angolan'), v('UG', 'Ugandan'),
    v('GB', 'British'), v('US', 'American'), v('CN', 'Chinese'), v('AE', 'Emirati'),
  ] },
  { key: 'language', name: 'Language', group: 'People', description: 'Languages a person speaks', values: [v('english', 'English'), v('bemba', 'Bemba'), v('nyanja', 'Nyanja'), v('tonga', 'Tonga'), v('lozi', 'Lozi'), v('hindi', 'Hindi'), v('marathi', 'Marathi'), v('french', 'French')] },
  { key: 'religion', name: 'Religion', group: 'People', description: 'Optional; only if your company records it', values: [v('christian', 'Christian'), v('muslim', 'Muslim'), v('hindu', 'Hindu'), v('sikh', 'Sikh'), v('buddhist', 'Buddhist'), v('jain', 'Jain'), v('other', 'Other'), v('prefer_not_to_say', 'Prefer not to say')] },
  { key: 'relationship', name: 'Relationship', group: 'People', description: 'Family members, nominees and emergency contacts', values: [
    v('spouse', 'Spouse'), v('father', 'Father'), v('mother', 'Mother'), v('son', 'Son'), v('daughter', 'Daughter'), v('brother', 'Brother'), v('sister', 'Sister'), v('guardian', 'Guardian'), v('friend', 'Friend'), v('other', 'Other'),
  ] },
  { key: 'qualification', name: 'Qualification', group: 'People', description: 'Highest or each completed level of education', values: [
    v('secondary', 'Secondary school'), v('higher_secondary', 'Higher secondary / Grade 12'), v('certificate', 'Certificate'), v('diploma', 'Diploma'),
    v('bachelors', "Bachelor's degree"), v('masters', "Master's degree"), v('doctorate', 'Doctorate'), v('professional', 'Professional qualification'),
  ] },

  // ─── Identity & documents ──────────────────────────────────
  { key: 'identity_document', name: 'Identity document type', group: 'Identity & documents', description: 'Kinds of ID recorded for a person; expiry ones get reminders', values: [
    v('passport', 'Passport', { hasExpiry: true }), v('national_id', 'National ID (NRC)', { hasExpiry: false }), v('driving_licence', 'Driving licence', { hasExpiry: true }),
    v('work_permit', 'Work permit', { hasExpiry: true }), v('visa', 'Visa', { hasExpiry: true }), v('tpin', 'Tax PIN (TPIN)', { hasExpiry: false }),
    v('aadhaar', 'Aadhaar', { hasExpiry: false }), v('pan', 'PAN', { hasExpiry: false }), v('voter_id', 'Voter ID', { hasExpiry: false }),
  ] },
  { key: 'document_category', name: 'Document category', group: 'Identity & documents', description: 'Folders for files on a person', values: [
    v('cv', 'CV / résumé'), v('identity', 'Identity'), v('offer_letter', 'Offer letter'), v('appointment_letter', 'Appointment letter'), v('contract', 'Contract'),
    v('certificate', 'Certificate'), v('experience_letter', 'Experience letter'), v('medical', 'Medical'), v('other', 'Other'),
  ] },

  // ─── Organisation ──────────────────────────────────────────
  { key: 'employment_type', name: 'Employment type', group: 'Organisation', description: 'Type of engagement', values: [v('full_time', 'Full time'), v('part_time', 'Part time'), v('contractor', 'Contractor'), v('intern', 'Intern')] },
  { key: 'employee_category', name: 'Employee category', group: 'Organisation', description: 'Groups people for policies and reports', values: [v('staff', 'Staff'), v('management', 'Management'), v('worker', 'Worker'), v('trainee', 'Trainee')] },
  { key: 'cost_centre', name: 'Cost centre', group: 'Organisation', description: 'For costing payroll in accounts', values: [] },
  { key: 'holiday_type', name: 'Holiday type', group: 'Time', description: 'Kinds of holiday on the calendar', values: [v('national', 'National'), v('regional', 'Regional'), v('religious', 'Religious'), v('company', 'Company')] },

  // ─── Hiring & exits ────────────────────────────────────────
  { key: 'source_of_hire', name: 'Source of hire', group: 'Hiring & exits', description: 'Where a candidate or new joiner came from', values: [
    v('direct', 'Direct'), v('referral', 'Employee referral'), v('job_board', 'Job board'), v('careers', 'Careers page'), v('agency', 'Agency'), v('campus', 'Campus'), v('other', 'Other'),
  ] },
  { key: 'rejection_reason', name: 'Candidate rejection reason', group: 'Hiring & exits', description: '', values: [
    v('skills', 'Skills do not match'), v('experience', 'Not enough experience'), v('salary', 'Salary expectation'), v('culture', 'Not a fit for the team'), v('no_show', 'Did not attend'), v('filled', 'Position filled'), v('other', 'Other'),
  ] },
  { key: 'exit_type', name: 'Exit type', group: 'Hiring & exits', description: 'Who ended employment decides notice-shortfall handling', values: [
    v('resignation', 'Resignation', { endedBy: 'employee' }), v('termination', 'Termination', { endedBy: 'employer' }), v('retirement', 'Retirement', { endedBy: 'employer' }),
    v('end_of_contract', 'End of contract', { endedBy: 'employer' }), v('mutual_separation', 'Mutual separation', { endedBy: 'employer' }),
    v('death', 'Death in service', { endedBy: 'employer' }), v('disablement', 'Disablement', { endedBy: 'employer' }),
  ] },
  { key: 'exit_reason', name: 'Exit reason', group: 'Hiring & exits', description: 'Why someone left; feeds attrition reports', values: [
    v('better_opportunity', 'Better opportunity'), v('compensation', 'Compensation'), v('higher_studies', 'Higher studies'), v('relocation', 'Relocation'), v('personal', 'Personal reasons'),
    v('health', 'Health'), v('performance', 'Performance'), v('conduct', 'Conduct'), v('redundancy', 'Redundancy'), v('other', 'Other'),
  ] },

  // ─── Finance ───────────────────────────────────────────────
  { key: 'bank_account_type', name: 'Bank account type', group: 'Finance', description: '', values: [v('savings', 'Savings'), v('current', 'Current'), v('salary', 'Salary')] },
  { key: 'bank', name: 'Bank', group: 'Finance', description: 'Banks salaries are paid into; edit to match your country', values: [
    v('zanaco', 'Zanaco'), v('stanbic', 'Stanbic Bank'), v('fnb_zm', 'First National Bank Zambia'), v('absa_zm', 'Absa Bank Zambia'), v('stanchart_zm', 'Standard Chartered Zambia'),
    v('access_zm', 'Access Bank Zambia'), v('indo_zambia', 'Indo Zambia Bank'), v('ecobank_zm', 'Ecobank Zambia'), v('first_capital', 'First Capital Bank'),
    v('sbi', 'State Bank of India'), v('hdfc', 'HDFC Bank'), v('icici', 'ICICI Bank'), v('axis', 'Axis Bank'), v('kotak', 'Kotak Mahindra Bank'),
  ] },
]

export const LIST_KEYS = MASTER_LISTS.map((l) => l.key)
export const listByKey = new Map(MASTER_LISTS.map((l) => [l.key, l]))

// The standard employee record, field by field and section by section, as the form builder sees it. A company
// sets each one to display, mandatory or hidden and decides whether employees may edit it themselves; `locked`
// fields are always shown and required. `sensitive` items are visible only to the person and HR.

export type FieldMode = 'display' | 'mandatory' | 'hidden'
export interface RecordField {
  key: string
  label: string
  section: 'personal' | 'contact' | 'job' | 'addresses' | 'family' | 'emergencyContacts' | 'education' | 'previousEmployment' | 'identities'
  kind: 'text' | 'date' | 'master' | 'masters' | 'email' | 'phone' | 'country' | 'section'
  master?: string
  mode: FieldMode
  employeeCanEdit: boolean
  locked?: boolean
  sensitive?: boolean
}

const f = (key: string, label: string, section: RecordField['section'], kind: RecordField['kind'], extra: Partial<RecordField> = {}): RecordField =>
  ({ key, label, section, kind, mode: 'display', employeeCanEdit: false, ...extra })

export const RECORD_FIELDS: RecordField[] = [
  // Personal
  f('title', 'Title', 'personal', 'master', { master: 'title', employeeCanEdit: true }),
  f('firstName', 'First name', 'personal', 'text', { mode: 'mandatory', locked: true }),
  f('middleName', 'Middle name', 'personal', 'text', { employeeCanEdit: true }),
  f('lastName', 'Last name', 'personal', 'text', { mode: 'mandatory', locked: true }),
  f('preferredName', 'Preferred name', 'personal', 'text', { employeeCanEdit: true }),
  f('dateOfBirth', 'Date of birth', 'personal', 'date', { sensitive: true }),
  f('gender', 'Gender', 'personal', 'master', { master: 'gender' }),
  f('maritalStatus', 'Marital status', 'personal', 'master', { master: 'marital_status', employeeCanEdit: true, sensitive: true }),
  f('marriageDate', 'Marriage date', 'personal', 'date', { employeeCanEdit: true, sensitive: true, mode: 'hidden' }),
  f('bloodGroup', 'Blood group', 'personal', 'master', { master: 'blood_group', employeeCanEdit: true }),
  f('nationality', 'Nationality', 'personal', 'master', { master: 'nationality' }),
  f('religion', 'Religion', 'personal', 'master', { master: 'religion', mode: 'hidden', employeeCanEdit: true, sensitive: true }),
  f('languages', 'Languages', 'personal', 'masters', { master: 'language', employeeCanEdit: true }),
  // Contact
  f('workEmail', 'Work email', 'contact', 'email', { mode: 'mandatory', locked: true }),
  f('personalEmail', 'Personal email', 'contact', 'email', { employeeCanEdit: true, sensitive: true }),
  f('mobilePersonal', 'Personal mobile', 'contact', 'phone', { employeeCanEdit: true, sensitive: true }),
  f('mobileWork', 'Work mobile', 'contact', 'phone'),
  // Job (department, position, manager, location, type and category change through position history)
  f('hireDate', 'Joining date', 'job', 'date', { mode: 'mandatory', locked: true }),
  f('employmentType', 'Employment type', 'job', 'master', { master: 'employment_type', mode: 'mandatory', locked: true }),
  f('employeeCategory', 'Employee category', 'job', 'master', { master: 'employee_category' }),
  f('costCentre', 'Cost centre', 'job', 'master', { master: 'cost_centre' }),
  f('sourceOfHire', 'Source of hire', 'job', 'master', { master: 'source_of_hire' }),
  f('probationEndDate', 'Probation ends', 'job', 'date'),
  f('confirmationDate', 'Confirmed on', 'job', 'date'),
  f('taxJurisdiction', 'Tax country', 'job', 'country'),
  // Sections (lists of entries)
  f('addresses', 'Addresses', 'addresses', 'section', { employeeCanEdit: true, sensitive: true }),
  f('family', 'Family & nominees', 'family', 'section', { employeeCanEdit: true, sensitive: true }),
  f('emergencyContacts', 'Emergency contacts', 'emergencyContacts', 'section', { employeeCanEdit: true, mode: 'mandatory' }),
  f('education', 'Education', 'education', 'section', { employeeCanEdit: true }),
  f('previousEmployment', 'Previous employment', 'previousEmployment', 'section', { employeeCanEdit: true, sensitive: true }),
  f('identities', 'Identity documents', 'identities', 'section', { employeeCanEdit: true, sensitive: true }),
]

export const fieldByKey = new Map(RECORD_FIELDS.map((x) => [x.key, x]))
// Scalar columns on employees that the record's personal/contact/job forms write directly
export const SCALAR_FIELDS = RECORD_FIELDS.filter((x) => x.kind !== 'section').map((x) => x.key)
export const DATE_FIELDS = new Set(RECORD_FIELDS.filter((x) => x.kind === 'date').map((x) => x.key))

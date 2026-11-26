import { z } from 'zod'

export const CreateOrgUnitSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    type: z.enum(['entity', 'division', 'department', 'team', 'location']),
    parentId: z.string().uuid().optional(),
    countryCode: z.string().length(2).optional(),
    currencyCode: z.string().length(3).optional(),
    costCenter: z.string().optional(),
  }),
})

export const CreateJobPositionSchema = z.object({
  body: z.object({
    orgUnitId: z.string().uuid(),
    title: z.string().min(1),
    code: z.string().optional(),
    gradeBand: z.string().optional(),
    description: z.string().optional(),
  }),
})

export const CreateWorkLocationSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    address: z.string().optional(),
    city: z.string().optional(),
    countryCode: z.string().length(2).optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    geoFenceRadiusMeters: z.number().int().positive().optional(),
  }),
})

export const CreateEmployeeSchema = z.object({
  body: z.object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    workEmail: z.string().trim().email().max(200),
    orgUnitId: z.string().uuid(),
    jobPositionId: z.string().uuid().optional(),
    managerId: z.string().uuid().optional(),
    resourceCalendarId: z.string().uuid().optional(),
    workLocationId: z.string().uuid().optional(),
    legalEntityId: z.string().uuid().optional(),
    payGroupId: z.string().uuid().optional(),
    hireDate: z.string().min(1).max(30), // checked as a real date in the service (a bad one is a clear 400)
    employmentType: z.string().trim().min(1).max(40), // a code from the employment_type master
    taxJurisdiction: z.string().length(2).optional(),
    dateOfBirth: z.string().max(30).optional(),
    gender: z.string().trim().max(40).optional(),
    nationality: z.string().trim().max(40).optional(),
    personalEmail: z.string().trim().email().max(200).optional(),
    mobilePersonal: z.string().trim().max(40).optional(),
    mobileWork: z.string().trim().max(40).optional(),
    emergencyContactName: z.string().trim().max(120).optional(),
    emergencyContactPhone: z.string().trim().max(40).optional(),
    emergencyContactRelation: z.string().trim().max(40).optional(),
  }),
})

export const AccessSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    roles: z.array(z.enum(['employee', 'manager', 'hr_admin', 'payroll_admin', 'compliance_officer', 'system_admin'])).max(6).optional(),
    loginEnabled: z.boolean().optional(),
    password: z.union([z.literal('generate'), z.string().min(10).max(200)]).optional(),
    hrScopeUnitIds: z.array(z.string().uuid()).max(50).optional(),
  }).strict(),
})

export const UpdateEmployeeSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    orgUnitId: z.string().uuid().optional(),
    jobPositionId: z.string().uuid().optional(),
    managerId: z.string().uuid().optional(),
    resourceCalendarId: z.string().uuid().optional(),
    workLocationId: z.string().uuid().optional(),
    legalEntityId: z.string().uuid().nullable().optional(),
    payGroupId: z.string().uuid().nullable().optional(),
    taxJurisdiction: z.string().length(2).optional(),
    dateOfBirth: z.string().max(30).optional(),
    employmentType: z.string().trim().min(1).max(40).optional(),
    gender: z.string().trim().max(40).optional(),
    nationality: z.string().trim().max(40).optional(),
    personalEmail: z.string().trim().email().max(200).optional(),
    mobilePersonal: z.string().trim().max(40).optional(),
    mobileWork: z.string().trim().max(40).optional(),
    emergencyContactName: z.string().trim().max(120).optional(),
    emergencyContactPhone: z.string().trim().max(40).optional(),
    emergencyContactRelation: z.string().trim().max(40).optional(),
    // the status is never typed in: it changes through Terminate, Reinstate, Confirmation or an exit
    employmentStatus: z.any().refine((v) => v === undefined, 'Status changes through Terminate, Reinstate or Confirmation, not by editing the record').optional(),
    probationEndDate: z.string().max(30).optional(),
    confirmationDate: z.string().max(30).optional(),
  }),
})

export const AddSkillSchema = z.object({
  body: z.object({
    skillId: z.string().uuid(),
    skillLevelId: z.string().uuid().optional(),
    justification: z.string().optional(),
  }),
})

export const AddResumeLineSchema = z.object({
  body: z.object({
    lineType: z.enum(['experience', 'education', 'certification', 'award']),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000).optional(),
    dateStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form 2026-03-31').optional(),
    dateEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form 2026-03-31').optional(),
    organisation: z.string().trim().max(160).optional(),
  }),
})

export const ArchiveSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    reason: z.string().trim().min(1, 'Archive reason is required').max(500),
    // who the people reporting to this person move to (required when there are any), and their last day (default today)
    newManagerId: z.string().uuid().optional(),
    lastWorkingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form 2026-03-31').optional(),
  }),
})

export const ReinstateSchema = z.object({ params: z.object({ id: z.string().uuid() }) })

export const ListQuerySchema = z.object({
  query: z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
    search: z.string().optional(),
    orgUnitId: z.string().uuid().optional(),
    employmentType: z.string().optional(),
    employmentStatus: z.string().optional(),
    showArchived: z.string().optional(),
    status: z.enum(['active', 'archived', 'all']).optional(),
    sort: z.enum(['name', 'hireDate', 'department', 'code']).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    subUnits: z.enum(['0', '1']).optional(), // 0 = only people directly in the chosen department
  }),
})

export const BankDetailsSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    bankName: z.string().min(1).max(100),
    bankAccountNo: z.string().regex(/^\d{6,34}$/, 'Account number must be 6 to 34 digits'),
    bankIfscSwift: z.string().max(20).optional(),
  }),
})

// Update schemas are strict: unknown keys (tenantId, id, active, *By columns...) are rejected with 400
export const UpdateOrgUnitSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: CreateOrgUnitSchema.shape.body.partial().strict(),
})

export const UpdateJobPositionSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: CreateJobPositionSchema.shape.body.partial().strict(),
})

export const UpdateWorkLocationSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: CreateWorkLocationSchema.shape.body.partial().strict(),
})

export const UpdateResumeLineSchema = z.object({
  params: z.object({ id: z.string().uuid(), lineId: z.string().uuid() }),
  body: AddResumeLineSchema.shape.body.partial().strict(),
})

const ymdDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

export const CreateContractSchema = z.object({
  body: z.object({
    employeeId: z.string().uuid(),
    ctcAnnual: z.number().nonnegative(),
    wageMonthly: z.number().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
    variablePayPercent: z.number().min(0).max(100).optional(),
    // per-person fixed pay amounts a salary rule can read as contract.comp.<CODE> (e.g. TRANSPORT, LUNCH)
    components: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,24}$/), z.number().min(0).max(100000000)).optional(),
    noticePeriodDays: z.number().int().min(0).max(365).optional(),
    effectiveFrom: ymdDate,
    effectiveUntil: ymdDate.optional(),
    salaryStructureId: z.string().uuid().optional(),
    gradeBandId: z.string().uuid().optional(),
    revisionReason: z.string().trim().max(500).optional(),
  }).strict().refine((b) => !b.effectiveUntil || b.effectiveUntil >= b.effectiveFrom, 'effectiveUntil must be on or after effectiveFrom'),
})

export const ContractTransitionSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason: z.string().trim().max(500).optional() }).strict().default({}),
})

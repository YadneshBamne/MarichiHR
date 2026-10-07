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
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    workEmail: z.string().email(),
    orgUnitId: z.string().uuid(),
    jobPositionId: z.string().uuid().optional(),
    managerId: z.string().uuid().optional(),
    resourceCalendarId: z.string().uuid().optional(),
    workLocationId: z.string().uuid().optional(),
    hireDate: z.string().min(1),
    employmentType: z.enum(['full_time', 'part_time', 'contractor', 'intern']),
    taxJurisdiction: z.string().length(2).optional(),
    dateOfBirth: z.string().optional(),
    gender: z.string().optional(),
    nationality: z.string().optional(),
    personalEmail: z.string().email().optional(),
    mobilePersonal: z.string().optional(),
    mobileWork: z.string().optional(),
    emergencyContactName: z.string().optional(),
    emergencyContactPhone: z.string().optional(),
    emergencyContactRelation: z.string().optional(),
  }),
})

export const UpdateEmployeeSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    orgUnitId: z.string().uuid().optional(),
    jobPositionId: z.string().uuid().optional(),
    managerId: z.string().uuid().optional(),
    resourceCalendarId: z.string().uuid().optional(),
    workLocationId: z.string().uuid().optional(),
    taxJurisdiction: z.string().length(2).optional(),
    dateOfBirth: z.string().optional(),
    gender: z.string().optional(),
    nationality: z.string().optional(),
    personalEmail: z.string().email().optional(),
    mobilePersonal: z.string().optional(),
    mobileWork: z.string().optional(),
    emergencyContactName: z.string().optional(),
    emergencyContactPhone: z.string().optional(),
    emergencyContactRelation: z.string().optional(),
    employmentStatus: z.string().optional(),
    probationEndDate: z.string().optional(),
    confirmationDate: z.string().optional(),
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
    name: z.string().min(1),
    description: z.string().optional(),
    dateStart: z.string().optional(),
    dateEnd: z.string().optional(),
    organisation: z.string().optional(),
  }),
})

export const ArchiveSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    reason: z.string().min(1, 'Archive reason is required'),
  }),
})

export const ListQuerySchema = z.object({
  query: z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
    search: z.string().optional(),
    orgUnitId: z.string().uuid().optional(),
    employmentType: z.string().optional(),
    employmentStatus: z.string().optional(),
    showArchived: z.string().optional(),
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

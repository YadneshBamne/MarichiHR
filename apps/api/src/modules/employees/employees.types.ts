export interface CreateOrgUnitDto {
  name: string
  type: 'entity' | 'division' | 'department' | 'team' | 'location'
  parentId?: string
  countryCode?: string
  currencyCode?: string
  costCenter?: string
}

export interface CreateJobPositionDto {
  orgUnitId: string
  title: string
  code?: string
  gradeBand?: string
  description?: string
}

export interface CreateWorkLocationDto {
  name: string
  address?: string
  city?: string
  countryCode?: string
  latitude?: number
  longitude?: number
  geoFenceRadiusMeters?: number
}

export interface CreateEmployeeDto {
  firstName: string
  lastName: string
  workEmail: string
  orgUnitId: string
  jobPositionId?: string
  managerId?: string
  resourceCalendarId?: string
  workLocationId?: string
  hireDate: string
  employmentType: 'full_time' | 'part_time' | 'contractor' | 'intern'
  taxJurisdiction?: string
  dateOfBirth?: string
  gender?: string
  nationality?: string
  personalEmail?: string
  mobilePersonal?: string
  mobileWork?: string
  emergencyContactName?: string
  emergencyContactPhone?: string
  emergencyContactRelation?: string
}

export interface UpdateEmployeeDto {
  firstName?: string
  lastName?: string
  orgUnitId?: string
  jobPositionId?: string
  managerId?: string
  resourceCalendarId?: string
  workLocationId?: string
  taxJurisdiction?: string
  dateOfBirth?: string
  gender?: string
  nationality?: string
  personalEmail?: string
  mobilePersonal?: string
  mobileWork?: string
  emergencyContactName?: string
  emergencyContactPhone?: string
  emergencyContactRelation?: string
  employmentStatus?: string
  probationEndDate?: string
  confirmationDate?: string
}

export interface AddSkillDto {
  skillId: string
  skillLevelId?: string
  justification?: string
}

export interface AddResumeLineDto {
  lineType: 'experience' | 'education' | 'certification' | 'award'
  name: string
  description?: string
  dateStart?: string
  dateEnd?: string
  organisation?: string
}

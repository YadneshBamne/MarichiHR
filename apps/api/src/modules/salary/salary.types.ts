export interface CreateSalaryStructureTypeDto {
  name: string
  wageType?: 'monthly' | 'hourly'
}

export interface CreateSalaryStructureDto {
  structureTypeId: string
  name: string
  code: string
  countryCode?: string
  description?: string
}

export interface CreateSalaryRuleDto {
  salaryStructureId: string
  categoryId: string
  name: string
  code: string
  sequence: number
  amountType: 'fixed' | 'percentage' | 'python_code'
  amountFixed?: number
  amountPercentage?: number
  amountPercentageBase?: string
  pythonCode?: string
  conditionSelect?: 'always' | 'python_expression'
  conditionExpr?: string
  appearsOnPayslip?: boolean
}

export interface CreateGradeBandDto {
  code: string
  name: string
  salaryMin: number
  salaryMid: number
  salaryMax: number
  currency: string
}

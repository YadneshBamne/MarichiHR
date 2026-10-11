-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "bloodGroup" TEXT,
ADD COLUMN     "costCentre" TEXT,
ADD COLUMN     "customFields" JSONB,
ADD COLUMN     "employeeCategory" TEXT,
ADD COLUMN     "languages" JSONB,
ADD COLUMN     "maritalStatus" TEXT,
ADD COLUMN     "marriageDate" DATE,
ADD COLUMN     "middleName" TEXT,
ADD COLUMN     "preferredName" TEXT,
ADD COLUMN     "religion" TEXT,
ADD COLUMN     "sourceOfHire" TEXT,
ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "employee_addresses" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_family_members" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "dateOfBirth" DATE,
    "gender" TEXT,
    "bloodGroup" TEXT,
    "nationality" TEXT,
    "profession" TEXT,
    "phone" TEXT,
    "isDependent" BOOLEAN NOT NULL DEFAULT false,
    "nomineeShare" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_family_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_emergency_contacts" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "altPhone" TEXT,
    "email" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_emergency_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_educations" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "qualification" TEXT NOT NULL,
    "institute" TEXT NOT NULL,
    "specialisation" TEXT,
    "startYear" INTEGER,
    "endYear" INTEGER,
    "grade" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_educations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_previous_employment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "designation" TEXT,
    "fromDate" DATE,
    "toDate" DATE,
    "reasonForLeaving" TEXT,
    "lastSalary" DECIMAL(18,2),
    "currency" TEXT,
    "pfMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_previous_employment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_identities" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "numberEnc" TEXT NOT NULL,
    "numberHash" TEXT NOT NULL,
    "numberLast4" TEXT NOT NULL,
    "issueDate" DATE,
    "expiryDate" DATE,
    "issuingCountry" TEXT,
    "details" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_position_history" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "orgUnitId" TEXT,
    "jobPositionId" TEXT,
    "managerId" TEXT,
    "workLocationId" TEXT,
    "employmentType" TEXT,
    "employeeCategory" TEXT,
    "reason" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_position_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "section" TEXT NOT NULL DEFAULT 'custom',
    "type" TEXT NOT NULL,
    "masterList" TEXT,
    "options" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_field_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "employeeCanEdit" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "employee_field_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_addresses_employeeId_kind_key" ON "employee_addresses"("employeeId", "kind");

-- CreateIndex
CREATE INDEX "employee_family_members_employeeId_idx" ON "employee_family_members"("employeeId");

-- CreateIndex
CREATE INDEX "employee_emergency_contacts_employeeId_idx" ON "employee_emergency_contacts"("employeeId");

-- CreateIndex
CREATE INDEX "employee_educations_employeeId_idx" ON "employee_educations"("employeeId");

-- CreateIndex
CREATE INDEX "employee_previous_employment_employeeId_idx" ON "employee_previous_employment"("employeeId");

-- CreateIndex
CREATE INDEX "employee_identities_tenantId_documentType_numberHash_idx" ON "employee_identities"("tenantId", "documentType", "numberHash");

-- CreateIndex
CREATE UNIQUE INDEX "employee_identities_employeeId_documentType_key" ON "employee_identities"("employeeId", "documentType");

-- CreateIndex
CREATE INDEX "employee_position_history_employeeId_effectiveFrom_idx" ON "employee_position_history"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_tenantId_key_key" ON "custom_field_definitions"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "employee_field_settings_tenantId_field_key" ON "employee_field_settings"("tenantId", "field");

-- AddForeignKey
ALTER TABLE "employee_addresses" ADD CONSTRAINT "employee_addresses_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_family_members" ADD CONSTRAINT "employee_family_members_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_emergency_contacts" ADD CONSTRAINT "employee_emergency_contacts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_educations" ADD CONSTRAINT "employee_educations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_previous_employment" ADD CONSTRAINT "employee_previous_employment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_identities" ADD CONSTRAINT "employee_identities_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_position_history" ADD CONSTRAINT "employee_position_history_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_field_settings" ADD CONSTRAINT "employee_field_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Every existing employee starts their position history with where they sit today, from their hire date
INSERT INTO "employee_position_history" ("id", "employeeId", "effectiveFrom", "orgUnitId", "jobPositionId", "managerId", "workLocationId", "employmentType", "reason", "appliedAt", "createdBy")
SELECT gen_random_uuid()::text, e."id", e."hireDate"::date, e."orgUnitId", e."jobPositionId", e."managerId", e."workLocationId", e."employmentType", 'Starting position', now(), 'system'
FROM "employees" e;

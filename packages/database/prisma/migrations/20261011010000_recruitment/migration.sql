-- Recruitment: openings, candidates, interviews, offers
-- CreateTable
CREATE TABLE "job_openings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "orgUnitId" TEXT NOT NULL,
    "jobPositionId" TEXT,
    "workLocationId" TEXT,
    "employmentType" TEXT NOT NULL DEFAULT 'full_time',
    "openings" INTEGER NOT NULL DEFAULT 1,
    "salaryMin" DECIMAL(18,2),
    "salaryMax" DECIMAL(18,2),
    "currency" TEXT NOT NULL,
    "hiringManagerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closedReason" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_openings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "openingId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "source" TEXT NOT NULL DEFAULT 'direct',
    "resumeUrl" TEXT,
    "summary" TEXT,
    "referredByEmployeeId" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'applied',
    "rating" INTEGER,
    "rejectionReason" TEXT,
    "offerCtcAnnual" DECIMAL(18,2),
    "offerJoiningDate" DATE,
    "offerStatus" TEXT,
    "offerNote" TEXT,
    "hiredEmployeeId" TEXT,
    "hiredAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "interviewerUserId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'video',
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "rating" INTEGER,
    "recommendation" TEXT,
    "feedback" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_openings_tenantId_status_idx" ON "job_openings"("tenantId", "status");

-- CreateIndex
CREATE INDEX "candidates_tenantId_openingId_stage_idx" ON "candidates"("tenantId", "openingId", "stage");

-- CreateIndex
CREATE INDEX "interviews_interviewerUserId_status_idx" ON "interviews"("interviewerUserId", "status");

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_openingId_fkey" FOREIGN KEY ("openingId") REFERENCES "job_openings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CreateTable
CREATE TABLE "profile_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "dueDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'open',
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "profile_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_request_sections" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewNote" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "profile_request_sections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "profile_requests_tenantId_status_idx" ON "profile_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "profile_requests_employeeId_status_idx" ON "profile_requests"("employeeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "profile_request_sections_requestId_section_key" ON "profile_request_sections"("requestId", "section");

-- AddForeignKey
ALTER TABLE "profile_requests" ADD CONSTRAINT "profile_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_request_sections" ADD CONSTRAINT "profile_request_sections_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "profile_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


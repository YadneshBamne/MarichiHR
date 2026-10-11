-- CreateTable
CREATE TABLE "employee_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "expiryDate" DATE,
    "visibility" TEXT NOT NULL DEFAULT 'employee',
    "uploadedBy" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archivedBy" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_documents_tenantId_employeeId_active_idx" ON "employee_documents"("tenantId", "employeeId", "active");

-- CreateIndex
CREATE INDEX "employee_documents_tenantId_expiryDate_idx" ON "employee_documents"("tenantId", "expiryDate");

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


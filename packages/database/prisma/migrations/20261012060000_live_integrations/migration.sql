-- CreateTable
CREATE TABLE "attendance_devices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "workLocationId" TEXT,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_punches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "employeeId" TEXT,
    "badge" TEXT NOT NULL,
    "punchedAt" TIMESTAMP(3) NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_punches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "channels" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId","category")
);

-- CreateTable
CREATE TABLE "statutory_filings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payrollCycleId" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "package" JSONB NOT NULL,
    "totals" JSONB NOT NULL,
    "reference" TEXT,
    "error" TEXT,
    "preparedBy" TEXT NOT NULL,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "statutory_filings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_integrations" (
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'off',
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets" TEXT,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_integrations_pkey" PRIMARY KEY ("tenantId","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_devices_keyHash_key" ON "attendance_devices"("keyHash");

-- CreateIndex
CREATE INDEX "attendance_devices_tenantId_idx" ON "attendance_devices"("tenantId");

-- CreateIndex
CREATE INDEX "device_punches_tenantId_punchedAt_idx" ON "device_punches"("tenantId", "punchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "device_punches_deviceId_externalId_key" ON "device_punches"("deviceId", "externalId");

-- CreateIndex
CREATE INDEX "statutory_filings_tenantId_idx" ON "statutory_filings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "statutory_filings_payrollCycleId_jurisdiction_key" ON "statutory_filings"("payrollCycleId", "jurisdiction");


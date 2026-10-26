-- CreateTable
CREATE TABLE "accounting_settings" (
    "tenantId" TEXT NOT NULL,
    "accounts" JSONB NOT NULL DEFAULT '{}',
    "deductionAccounts" JSONB NOT NULL DEFAULT '{}',
    "splitBy" TEXT NOT NULL DEFAULT 'none',
    "webhookUrl" TEXT,
    "webhookSecret" TEXT,
    "autoPush" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_settings_pkey" PRIMARY KEY ("tenantId")
);


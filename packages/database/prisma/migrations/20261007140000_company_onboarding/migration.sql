-- Self-serve companies: profile, installed apps, owner, onboarding state; forced password change for HR-issued credentials
ALTER TABLE "tenants"
  ADD COLUMN "legalName" TEXT,
  ADD COLUMN "industry" TEXT,
  ADD COLUMN "companySize" TEXT,
  ADD COLUMN "primaryCountry" TEXT,
  ADD COLUMN "modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "ownerUserId" TEXT,
  ADD COLUMN "onboardedAt" TIMESTAMP(3);

-- Existing companies already use every app and are past onboarding
UPDATE "tenants" SET "modules" = ARRAY['leave','attendance','payroll','expenses','exits','activities'], "onboardedAt" = CURRENT_TIMESTAMP;

ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

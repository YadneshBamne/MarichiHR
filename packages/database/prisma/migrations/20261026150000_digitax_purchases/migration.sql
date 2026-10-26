-- AlterTable
ALTER TABLE "expense_categories" ADD COLUMN     "digitaxItemId" TEXT;

-- AlterTable
ALTER TABLE "reimbursement_claims" ADD COLUMN     "digitax" JSONB;


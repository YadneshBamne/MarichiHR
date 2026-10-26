-- AlterTable
ALTER TABLE "bank_file_formats" ADD COLUMN     "preamble" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "trailer" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "vars" JSONB NOT NULL DEFAULT '{}';


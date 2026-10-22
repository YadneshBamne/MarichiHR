-- AlterTable
ALTER TABLE "users" ADD COLUMN     "notifyPrefs" JSONB NOT NULL DEFAULT '{}';


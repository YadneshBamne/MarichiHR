-- First-login product tour: when the user finished or skipped it (null = show it)
ALTER TABLE "users" ADD COLUMN "tourDoneAt" TIMESTAMP(3);

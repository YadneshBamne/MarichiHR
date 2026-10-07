-- Running session start, so the time tracker resumes from the server and a day can have several check-in/out pairs
ALTER TABLE "attendance_records" ADD COLUMN "openSince" TIMESTAMP(3);

-- Records clocked in but not out are running sessions that started at their check-in
UPDATE "attendance_records" SET "openSince" = "checkInTime" WHERE "checkInTime" IS NOT NULL AND "checkOutTime" IS NULL;

-- Holiday calendars can target a work location and be archived; holidays can be archived
ALTER TABLE "holiday_calendars" ADD COLUMN "workLocationId" TEXT;
ALTER TABLE "holiday_calendars" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "holidays" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "holiday_calendars_tenantId_year_idx" ON "holiday_calendars"("tenantId", "year");
CREATE INDEX "holidays_calendarId_date_idx" ON "holidays"("calendarId", "date");

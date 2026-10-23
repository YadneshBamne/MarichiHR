-- AlterTable
ALTER TABLE "forum_comments" ADD COLUMN     "attachments" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "forum_spaces" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'company',
ADD COLUMN     "moderatorUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "orgUnitId" TEXT,
ADD COLUMN     "ownerEmployeeId" TEXT;

-- AlterTable
ALTER TABLE "forum_threads" ADD COLUMN     "attachments" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "forum_attachments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forum_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_follows" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forum_follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_settings" (
    "tenantId" TEXT NOT NULL,
    "blockedWords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoNews" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "forum_settings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "forum_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'townhall',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "location" TEXT NOT NULL DEFAULT '',
    "spaceId" TEXT,
    "createdBy" TEXT NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forum_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_event_rsvps" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "forum_event_rsvps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forum_attachments_tenantId_idx" ON "forum_attachments"("tenantId");

-- CreateIndex
CREATE INDEX "forum_follows_tenantId_kind_key_idx" ON "forum_follows"("tenantId", "kind", "key");

-- CreateIndex
CREATE UNIQUE INDEX "forum_follows_tenantId_userId_kind_key_key" ON "forum_follows"("tenantId", "userId", "kind", "key");

-- CreateIndex
CREATE INDEX "forum_events_tenantId_startsAt_idx" ON "forum_events"("tenantId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "forum_event_rsvps_eventId_userId_key" ON "forum_event_rsvps"("eventId", "userId");

-- AddForeignKey
ALTER TABLE "forum_event_rsvps" ADD CONSTRAINT "forum_event_rsvps_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "forum_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;


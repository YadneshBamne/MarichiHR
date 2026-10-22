-- CreateTable
CREATE TABLE "forum_spaces" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forum_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_threads" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forum_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_comments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forum_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_polls" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "multi" BOOLEAN NOT NULL DEFAULT false,
    "closesAt" TIMESTAMP(3),

    CONSTRAINT "forum_polls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_votes" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "optionIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forum_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kudos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toEmployeeId" TEXT NOT NULL,
    "badge" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kudos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_reports" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reporterUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forum_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "forum_spaces_tenantId_name_key" ON "forum_spaces"("tenantId", "name");

-- CreateIndex
CREATE INDEX "forum_threads_tenantId_spaceId_lastActivityAt_idx" ON "forum_threads"("tenantId", "spaceId", "lastActivityAt");

-- CreateIndex
CREATE INDEX "forum_comments_threadId_createdAt_idx" ON "forum_comments"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "forum_polls_threadId_key" ON "forum_polls"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "forum_votes_pollId_userId_key" ON "forum_votes"("pollId", "userId");

-- CreateIndex
CREATE INDEX "kudos_tenantId_createdAt_idx" ON "kudos"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "forum_reports_tenantId_status_idx" ON "forum_reports"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "forum_spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forum_comments" ADD CONSTRAINT "forum_comments_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "forum_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forum_polls" ADD CONSTRAINT "forum_polls_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "forum_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forum_votes" ADD CONSTRAINT "forum_votes_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "forum_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;


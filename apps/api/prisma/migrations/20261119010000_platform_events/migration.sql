-- Platform Interconnect (2026-11-19): the durable cross-platform
-- event feed. Additive only — one brand-new table, no existing record
-- changes meaning. appendEvent() (data/store.js) writes one row per
-- platform event at the flow's existing success point so the feed
-- survives serverless instance turnover; GET /platform/events and the
-- Platform Interconnect console read it back for staff.

-- CreateTable
CREATE TABLE "PlatformEvent" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT,
    "actor" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "referenceCode" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformEvent_createdAt_idx" ON "PlatformEvent"("createdAt");

-- CreateIndex
CREATE INDEX "PlatformEvent_type_createdAt_idx" ON "PlatformEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformEvent_source_createdAt_idx" ON "PlatformEvent"("source", "createdAt");

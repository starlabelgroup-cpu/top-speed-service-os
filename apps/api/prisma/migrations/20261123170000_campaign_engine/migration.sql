-- Top Speed Campaign Engine (2026-11-23): the perpetual campaign
-- registry. Additive only — two new tables and one enum; nothing
-- existing is altered. Hand-written in the generated style (the
-- facebook_os_manager / sales_os precedent). The registry is
-- seeded by the deploy-time seed (Phase 5) and the daily batch
-- endpoint; records are born DRAFT/QUEUED/STAGED and nothing in
-- this schema can express spend — funding stays the owner's
-- per-campaign call in the platforms themselves.

-- CreateEnum
CREATE TYPE "CampaignRecordStatus" AS ENUM ('DRAFT', 'QUEUED', 'STAGED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "CampaignRecord" (
    "id" UUID NOT NULL,
    "campaignKey" TEXT NOT NULL,
    "batchKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "division" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "audience" TEXT,
    "audienceNote" TEXT,
    "angle" TEXT NOT NULL,
    "subject" TEXT,
    "copy" TEXT NOT NULL,
    "creativeSpec" JSONB,
    "landingUrl" TEXT NOT NULL,
    "sourceTag" TEXT NOT NULL,
    "status" "CampaignRecordStatus" NOT NULL DEFAULT 'DRAFT',
    "linkedRef" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignBatch" (
    "id" UUID NOT NULL,
    "batchKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "campaignCount" INTEGER NOT NULL DEFAULT 0,
    "socialQueued" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecord_campaignKey_key" ON "CampaignRecord"("campaignKey");

-- CreateIndex
CREATE INDEX "CampaignRecord_division_surface_idx" ON "CampaignRecord"("division", "surface");

-- CreateIndex
CREATE INDEX "CampaignRecord_batchKey_idx" ON "CampaignRecord"("batchKey");

-- CreateIndex
CREATE INDEX "CampaignRecord_status_idx" ON "CampaignRecord"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignBatch_batchKey_key" ON "CampaignBatch"("batchKey");

-- CreateIndex
CREATE INDEX "CampaignBatch_kind_generatedAt_idx" ON "CampaignBatch"("kind", "generatedAt");

-- Advertiser & studio growth (2026-11-20): E3 advertiser creative
-- uploads + E4 Page Studio A/B tests. Additive only — two brand-new
-- tables and one nullable column on AdCampaign. No existing row is
-- touched: campaigns without an uploaded creative keep resolving
-- their image exactly as before (creativeUploadId NULL), and pages
-- without an experiment render exactly as before.

CREATE TABLE "AdvertiserCreative" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvertiserCreative_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdvertiserCreative_ownerId_createdAt_idx" ON "AdvertiserCreative"("ownerId", "createdAt");

CREATE TABLE "PageExperiment" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "splitB" INTEGER NOT NULL DEFAULT 50,
    "sectionsB" JSONB NOT NULL DEFAULT '[]',
    "viewsA" INTEGER NOT NULL DEFAULT 0,
    "viewsB" INTEGER NOT NULL DEFAULT 0,
    "winner" TEXT,
    "createdBy" TEXT,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageExperiment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PageExperiment_pageId_status_idx" ON "PageExperiment"("pageId", "status");

ALTER TABLE "AdCampaign" ADD COLUMN "creativeUploadId" UUID;

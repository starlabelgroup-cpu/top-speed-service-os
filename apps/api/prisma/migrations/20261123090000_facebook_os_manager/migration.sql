-- Top Speed Facebook OS Manager (2026-11-23): streaming posts +
-- advertisements system. Additive only — three new tables and their
-- enums; nothing existing is altered. Hand-written in the generated
-- style (the seller_channel_status_fulfillment precedent).

-- CreateEnum
CREATE TYPE "FacebookStreamPostStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'POSTED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FacebookStreamFormat" AS ENUM ('REPAIR_SPOTLIGHT', 'SPEEDY_TIP', 'REWARDS_SAVINGS', 'CITY_SPOTLIGHT', 'QUICK_TIP', 'REVIEW_INVITE', 'AD_IDEA', 'ANNOUNCEMENT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "FacebookAdDraftStatus" AS ENUM ('DRAFT', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FacebookSyndicationStatus" AS ENUM ('PLANNED', 'LIVE', 'REMOVED');

-- CreateTable
CREATE TABLE "FacebookStreamPost" (
    "id" UUID NOT NULL,
    "seriesKey" TEXT,
    "seriesWeek" INTEGER,
    "format" "FacebookStreamFormat" NOT NULL DEFAULT 'CUSTOM',
    "title" TEXT NOT NULL,
    "copy" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "mediaKind" TEXT,
    "linkUrl" TEXT,
    "pageId" TEXT NOT NULL DEFAULT '1437372132795817',
    "pageName" TEXT NOT NULL DEFAULT 'Top Speed Appliance Repair and Installation',
    "status" "FacebookStreamPostStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledFor" TIMESTAMP(3),
    "facebookUrl" TEXT,
    "facebookPostId" TEXT,
    "postedAt" TIMESTAMP(3),
    "statusNote" TEXT,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookStreamPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacebookAdDraft" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "audience" TEXT,
    "headline" TEXT,
    "copy" TEXT,
    "ctaText" TEXT,
    "creativeRef" TEXT,
    "destinationUrl" TEXT,
    "budgetCents" INTEGER,
    "recordedSpendCents" INTEGER,
    "status" "FacebookAdDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "metaCampaignId" TEXT,
    "metaDeepLink" TEXT,
    "streamPostId" UUID,
    "notes" TEXT,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookAdDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacebookSyndication" (
    "id" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "surface" TEXT NOT NULL,
    "deepLink" TEXT NOT NULL,
    "status" "FacebookSyndicationStatus" NOT NULL DEFAULT 'PLANNED',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookSyndication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FacebookStreamPost_status_scheduledFor_idx" ON "FacebookStreamPost"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "FacebookStreamPost_seriesKey_seriesWeek_idx" ON "FacebookStreamPost"("seriesKey", "seriesWeek");

-- CreateIndex
CREATE INDEX "FacebookStreamPost_status_postedAt_idx" ON "FacebookStreamPost"("status", "postedAt");

-- CreateIndex
CREATE INDEX "FacebookAdDraft_status_createdAt_idx" ON "FacebookAdDraft"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FacebookSyndication_postId_surface_key" ON "FacebookSyndication"("postId", "surface");

-- CreateIndex
CREATE INDEX "FacebookSyndication_surface_status_idx" ON "FacebookSyndication"("surface", "status");

-- CreateIndex
CREATE INDEX "FacebookSyndication_postId_idx" ON "FacebookSyndication"("postId");

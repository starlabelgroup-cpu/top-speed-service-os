-- Ads Library (2026-11-24): the creative registry behind the
-- Flywheel streaming system. Additive only — two enums and one new
-- table; nothing existing is altered. Hand-written in the
-- generated style (the campaign_engine precedent). The registry is
-- seeded on first hydration from the real house creative set
-- (data/adCreativeSeeds.js); served/clicked start at zero and only
-- ever move by real slot serves and clicks — nothing in this
-- schema can express spend.

-- CreateEnum
CREATE TYPE "AdCreativeKind" AS ENUM ('IMAGE', 'TEXT');

-- CreateEnum
CREATE TYPE "AdCreativeStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateTable
CREATE TABLE "AdCreative" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "AdCreativeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "headline" TEXT,
    "subline" TEXT,
    "ctaText" TEXT,
    "serviceTag" TEXT,
    "cityTag" TEXT,
    "assetKind" TEXT NOT NULL DEFAULT 'NONE',
    "assetRef" TEXT,
    "formats" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "destinationUrl" TEXT NOT NULL,
    "claimStatus" TEXT NOT NULL DEFAULT 'CLEAN',
    "status" "AdCreativeStatus" NOT NULL DEFAULT 'ACTIVE',
    "served" INTEGER NOT NULL DEFAULT 0,
    "clicked" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCreative_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdCreative_key_key" ON "AdCreative"("key");

-- CreateIndex
CREATE INDEX "AdCreative_status_kind_idx" ON "AdCreative"("status", "kind");

-- CreateIndex
CREATE INDEX "AdCreative_serviceTag_idx" ON "AdCreative"("serviceTag");

-- CreateIndex
CREATE INDEX "AdCreative_cityTag_idx" ON "AdCreative"("cityTag");

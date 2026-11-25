-- Advertiser tracked links + public advertiser pages (2026-11-24):
-- Ramone's directive — every advertiser account gets tracked links,
-- and an ad click lands on the advertiser's own page on the platform
-- (details + links) instead of leaving straight away. Additive only:
-- three new tables and two enums; nothing existing is altered.
-- Backfill happens in code (db/advertiserLinksRepo hydration), from
-- the advertisers' own real records — no data is invented here.

-- CreateEnum
CREATE TYPE "AdvertiserLinkKind" AS ENUM ('MASTER', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "AdvertiserLinkDirection" AS ENUM ('IN', 'OUT');

-- CreateTable
CREATE TABLE "AdvertiserProfile" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "businessName" TEXT,
    "about" TEXT,
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serviceArea" TEXT,
    "phone" TEXT,
    "websiteUrl" TEXT,
    "links" JSONB NOT NULL DEFAULT '[]',
    "logoCreativeId" UUID,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvertiserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvertiserLink" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "advertiserUserId" UUID NOT NULL,
    "kind" "AdvertiserLinkKind" NOT NULL,
    "campaignId" UUID,
    "label" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "clickOuts" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvertiserLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvertiserLinkClick" (
    "id" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "advertiserUserId" UUID NOT NULL,
    "direction" "AdvertiserLinkDirection" NOT NULL DEFAULT 'IN',
    "target" TEXT,
    "surface" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvertiserLinkClick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdvertiserProfile_userId_key" ON "AdvertiserProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvertiserProfile_slug_key" ON "AdvertiserProfile"("slug");

-- CreateIndex
CREATE INDEX "AdvertiserProfile_slug_idx" ON "AdvertiserProfile"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "AdvertiserLink_code_key" ON "AdvertiserLink"("code");

-- CreateIndex
CREATE INDEX "AdvertiserLink_advertiserUserId_idx" ON "AdvertiserLink"("advertiserUserId");

-- CreateIndex
CREATE INDEX "AdvertiserLink_campaignId_idx" ON "AdvertiserLink"("campaignId");

-- CreateIndex
CREATE INDEX "AdvertiserLinkClick_linkId_createdAt_idx" ON "AdvertiserLinkClick"("linkId", "createdAt");

-- CreateIndex
CREATE INDEX "AdvertiserLinkClick_advertiserUserId_createdAt_idx" ON "AdvertiserLinkClick"("advertiserUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "AdvertiserProfile" ADD CONSTRAINT "AdvertiserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvertiserLink" ADD CONSTRAINT "AdvertiserLink_advertiserUserId_fkey" FOREIGN KEY ("advertiserUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvertiserLinkClick" ADD CONSTRAINT "AdvertiserLinkClick_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "AdvertiserLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvertiserLinkClick" ADD CONSTRAINT "AdvertiserLinkClick_advertiserUserId_fkey" FOREIGN KEY ("advertiserUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

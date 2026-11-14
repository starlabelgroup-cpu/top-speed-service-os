-- CreateEnum
CREATE TYPE "MediaContentType" AS ENUM ('VIDEO', 'ARTICLE', 'SOCIAL_POST', 'LIVE', 'IMAGE');

-- CreateEnum
CREATE TYPE "MediaContentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MediaDivision" AS ENUM ('VIDEOS', 'PUBLISHING', 'NEWS', 'SOCIAL', 'LIVE');

-- CreateEnum
CREATE TYPE "MediaAssetRightsStatus" AS ENUM ('OWNED', 'LICENSED', 'PENDING_REVIEW');

-- CreateTable
CREATE TABLE "MediaContent" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "MediaContentType" NOT NULL,
    "division" "MediaDivision" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assetUrl" TEXT,
    "thumbnailUrl" TEXT,
    "durationSec" INTEGER,
    "transcript" TEXT,
    "destinationUrl" TEXT,
    "status" "MediaContentStatus" NOT NULL DEFAULT 'DRAFT',
    "publishAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "contentId" UUID,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "rightsStatus" "MediaAssetRightsStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "rightsNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaContent_slug_key" ON "MediaContent"("slug");

-- CreateIndex
CREATE INDEX "MediaContent_status_division_idx" ON "MediaContent"("status", "division");

-- CreateIndex
CREATE INDEX "MediaContent_division_publishedAt_idx" ON "MediaContent"("division", "publishedAt");

-- CreateIndex
CREATE INDEX "MediaAsset_contentId_idx" ON "MediaAsset"("contentId");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "MediaContent"("id") ON DELETE SET NULL ON UPDATE CASCADE;


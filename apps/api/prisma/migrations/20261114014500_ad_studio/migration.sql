-- Ad Studio (in-house advertising system, 2026-11-14): additive only —
-- one new table plus its enums; no existing table is altered.

-- CreateEnum
CREATE TYPE "AdBusinessLine" AS ENUM ('TOP_SPEED', 'CLEANOUT_VENTS', 'COCOCANE');

-- CreateEnum
CREATE TYPE "AdCampaignStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "AdPlacement" AS ENUM ('BANNER', 'NONE');

-- CreateTable
CREATE TABLE "AdCampaign" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "businessLine" "AdBusinessLine" NOT NULL,
    "objective" TEXT NOT NULL,
    "status" "AdCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "creativeId" UUID,
    "destinationUrl" TEXT NOT NULL,
    "sourceTag" TEXT NOT NULL,
    "placement" "AdPlacement" NOT NULL DEFAULT 'NONE',
    "bannerId" UUID,
    "notes" TEXT,
    "createdById" UUID,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdCampaign_sourceTag_key" ON "AdCampaign"("sourceTag");

-- CreateIndex
CREATE INDEX "AdCampaign_status_idx" ON "AdCampaign"("status");

-- CreateIndex
CREATE INDEX "AdCampaign_businessLine_status_idx" ON "AdCampaign"("businessLine", "status");

-- AddForeignKey
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "MediaContent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Flywheel Advertising (2026-11-16): advertiser-owned campaigns in Ad
-- Studio. Additive only — one new enum value and six nullable columns
-- on AdCampaign. House campaigns are untouched (their advertiser fields
-- stay NULL and resolve from businessLine + creative as before).

-- AlterEnum
ALTER TYPE "AdBusinessLine" ADD VALUE IF NOT EXISTS 'EXTERNAL';

-- AlterTable
ALTER TABLE "AdCampaign" ADD COLUMN "advertiserName" TEXT;
ALTER TABLE "AdCampaign" ADD COLUMN "offering" TEXT;
ALTER TABLE "AdCampaign" ADD COLUMN "headline" TEXT;
ALTER TABLE "AdCampaign" ADD COLUMN "copy" TEXT;
ALTER TABLE "AdCampaign" ADD COLUMN "ctaText" TEXT;
ALTER TABLE "AdCampaign" ADD COLUMN "category" TEXT;

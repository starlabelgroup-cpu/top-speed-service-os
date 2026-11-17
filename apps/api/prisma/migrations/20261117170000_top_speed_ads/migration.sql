-- Top Speed Ads — Flywheel in-house ads upgrade (2026-11-17):
-- first-touch attribution gains the platform click IDs (Google
-- gclid, Meta fbclid, Microsoft msclkid) beside the existing UTM
-- columns on ServiceRequest, and AdCampaign gains the creative
-- picker's house image URL. Additive only: four nullable columns,
-- no defaults to backfill, no existing column touched.

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN "gclid" TEXT,
ADD COLUMN "fbclid" TEXT,
ADD COLUMN "msclkid" TEXT;

-- AlterTable (the shared attribution layer flattens onto both
-- intake tables, so Connection carries the same three columns)
ALTER TABLE "Connection" ADD COLUMN "gclid" TEXT,
ADD COLUMN "fbclid" TEXT,
ADD COLUMN "msclkid" TEXT;

-- AlterTable
ALTER TABLE "AdCampaign" ADD COLUMN "imageUrl" TEXT;

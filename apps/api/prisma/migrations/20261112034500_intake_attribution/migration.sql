-- Intake attribution (2026-11-12, Fusion absorb Stage 3): bookings and
-- connection records gain the landing page, the [via:] surface tag, and
-- the UTM campaign fields the Fusion lead form already collected but the
-- Service OS intake schemas silently stripped. All columns nullable —
-- existing rows and clients that send nothing are unaffected.
ALTER TABLE "ServiceRequest" ADD COLUMN "sourcePage" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN "viaTag" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN "utmSource" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN "utmMedium" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN "utmCampaign" TEXT;

ALTER TABLE "Connection" ADD COLUMN "sourcePage" TEXT;
ALTER TABLE "Connection" ADD COLUMN "viaTag" TEXT;
ALTER TABLE "Connection" ADD COLUMN "utmSource" TEXT;
ALTER TABLE "Connection" ADD COLUMN "utmMedium" TEXT;
ALTER TABLE "Connection" ADD COLUMN "utmCampaign" TEXT;

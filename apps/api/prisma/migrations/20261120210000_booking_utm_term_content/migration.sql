-- Conversion tracking completion (2026-11-20, Ramone: "Setup now" +
-- "Do it for all platforms"): bookings and connection records gain
-- the last two UTM fields — utmTerm (the keyword) and utmContent
-- (the creative variant) — so every booking carries the full ad
-- campaign fingerprint beside the platform click IDs (gclid /
-- fbclid / msclkid) that the offline-conversion export matches paid
-- jobs back to. All columns nullable — existing rows and clients
-- that send nothing are unaffected.
ALTER TABLE "ServiceRequest" ADD COLUMN "utmTerm" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN "utmContent" TEXT;

ALTER TABLE "Connection" ADD COLUMN "utmTerm" TEXT;
ALTER TABLE "Connection" ADD COLUMN "utmContent" TEXT;

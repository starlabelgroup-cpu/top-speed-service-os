-- Book by Location (2026-11-23): device-verified location fields on
-- the booking record. Additive only — four nullable columns; every
-- existing row and every booking made without the location tap
-- carries NULLs and behaves exactly as before. Hand-written in the
-- generated style (the intake_attribution precedent).
ALTER TABLE "ServiceRequest" ADD COLUMN "geoCity" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN "geoTier" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN "geoLat" DOUBLE PRECISION;
ALTER TABLE "ServiceRequest" ADD COLUMN "geoLng" DOUBLE PRECISION;

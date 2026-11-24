-- Google Maps enrichment (2026-11-23): provenance for the booking's
-- stored coordinates. Additive only — two nullable columns; every
-- existing row and every booking the Maps geocode did not touch
-- carries NULLs and behaves exactly as before. Hand-written in the
-- generated style (the booking_geo_fields precedent).
ALTER TABLE "ServiceRequest" ADD COLUMN "geoPlaceId" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN "geoSource" TEXT;

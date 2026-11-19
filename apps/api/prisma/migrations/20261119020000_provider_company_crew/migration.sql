-- Two tech systems (2026-11-19): mark Top Speed's own field team as
-- the company crew. Every other provider defaults to the Service
-- Network (companyCrew = false).
ALTER TABLE "Provider" ADD COLUMN "companyCrew" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Provider" SET "companyCrew" = true WHERE "id" = '30000000-0000-4000-8000-000000000003';
-- Tech settings (Directive 6): per-account field-tech settings on the
-- account's own User record (vehicle, notification preferences, a
-- company tech's personal areas/appliances).
ALTER TABLE "User" ADD COLUMN "techSettings" JSONB;

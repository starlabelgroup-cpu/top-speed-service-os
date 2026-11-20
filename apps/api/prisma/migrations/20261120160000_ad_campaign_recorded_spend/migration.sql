-- Recorded spend for cost-per-won (2026-11-20, Local OS loop fix 2).
-- Additive only: one nullable column on AdCampaign. Campaigns without
-- a recorded figure keep reading "No cost recorded" exactly as before.
ALTER TABLE "AdCampaign" ADD COLUMN "recordedSpendCents" INTEGER;

-- ApplianceReferral Phase 2 (2026-11-12): partner/business referral
-- track. One program and one settings row — the track only separates
-- reporting and staff filtering. CUSTOMER = household referrers;
-- PARTNER = business / property-manager referrers (codes issued from
-- commercial bookings, or staff-flagged in Book OS). Journeys snapshot
-- the code's track at creation so re-flagging never rewrites history.

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN "track" TEXT NOT NULL DEFAULT 'CUSTOMER';

-- AlterTable
ALTER TABLE "ReferralJourney" ADD COLUMN "track" TEXT NOT NULL DEFAULT 'CUSTOMER';

-- Index for track-filtered staff reporting.
CREATE INDEX "ReferralJourney_companyId_track_status_idx" ON "ReferralJourney"("companyId", "track", "status");

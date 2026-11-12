-- ApplianceReferral approved economics (Ramone approved 2026-11-12,
-- blueprint section 3): insert the program settings row for the platform
-- company with exactly the approved values —
--   base service credit per completed referral: $25 (2500 cents)
--   Tier 2 "Connector" (5-9 completed):         $35 (3500 cents)
--   Tier 3 "Ambassador" (10+ completed):        $50 (5000 cents)
--   milestone bonuses: $100 at 10, $250 at 25 lifetime referrals
--   credit expiry: 12 months from issuance (365 days)
-- monthlyCapPerReferrer stays NULL on purpose: the blueprint
-- deliberately left the cap number for the owner to set later
-- (blueprint open decision #3), so no figure is invented here.
--
-- Guards:
--  * the row is inserted only when the platform company exists
--    (SELECT ... FROM "Company"), so a fresh database that migrates
--    before it seeds is not broken by the foreign key;
--  * ON CONFLICT ("companyId") DO NOTHING — if the owner has already
--    saved settings (Book OS), this migration never overwrites them,
--    and re-applying this SQL by hand is a no-op.

INSERT INTO "ReferralProgramSetting" (
  "id", "companyId", "enabled",
  "rewardAmountCents",
  "tier2Threshold", "tier2AmountCents",
  "tier3Threshold", "tier3AmountCents",
  "milestoneBonuses", "monthlyCapPerReferrer", "rewardExpiryDays",
  "updatedBy", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  c."id",
  true,
  2500,
  5, 3500,
  10, 5000,
  '[{"at": 10, "amountCents": 10000}, {"at": 25, "amountCents": 25000}]'::jsonb,
  NULL,
  365,
  'owner-approved-2026-11-12',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Company" c
WHERE c."id" = '10000000-0000-4000-8000-000000000001'
ON CONFLICT ("companyId") DO NOTHING;

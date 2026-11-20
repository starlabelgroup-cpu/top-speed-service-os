-- Ad Specialist account class (2026-11-19, Ramone's directive): a new
-- staff-class role for the people who RUN Top Speed advertising,
-- fully separate from the advertiser marketplace roles
-- (ADVERTISER / MARKETING_MANAGER / DEVELOPER, which stay self-serve).
-- Enum-only change: role membership lives in gates in
-- src/config/security.js + the route requireRole lists.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'AD_SPECIALIST';

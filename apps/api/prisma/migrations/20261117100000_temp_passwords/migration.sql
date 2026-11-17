-- Temporary passwords (2026-11-17): the office (Master, via Work Time
-- Account Access) issues a temporary password for any account —
-- employees, contractors, customers and vendors alike. The holder
-- signs in with it, passes the usual gates (Speedy Verify, then
-- Layer 2), and must set their own password before any session is
-- issued; the temporary password dies at that moment.
--
-- tempPasswordHash is a scrypt hash (services/passwords format) — the
-- plain temporary password is shown to the Master once at issue and
-- never stored. tempFailedAttempts / tempLockedUntil give the
-- temporary credential the platform lockout discipline (5 wrong
-- attempts → 15-minute lock, mirroring Speedy Verify). tempChangeJti
-- is the single-use id of the live password-change token.
-- tempIssuedAt / tempIssuedById / passwordChangedAt are the office's
-- audit trail. The Master account (COMPANY_OWNER) is exempt by
-- construction (Rule Zero) — issuance to it is refused in the API.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "tempPasswordHash" TEXT;
ALTER TABLE "User" ADD COLUMN "tempPasswordExpiresAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "tempIssuedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "tempIssuedById" UUID;
ALTER TABLE "User" ADD COLUMN "tempFailedAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "tempLockedUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "tempChangeJti" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);

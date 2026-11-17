-- Work Time Account Access (2026-11-17): permanent employee numbers.
-- 'TS-' + sequential number starting at TS-1001, unique, never reused.
-- Employee accounts only: Service Setters (DISPATCHER), Managers
-- (COMPANY_ADMIN), platform staff (PLATFORM_ADMIN), Providers/Techs
-- (PROVIDER_OWNER / PROVIDER_TECH / TECHNICIAN). The Master account
-- (COMPANY_OWNER) never carries a number — it displays "MASTER".

-- AlterTable
ALTER TABLE "User" ADD COLUMN "employeeNumber" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_employeeNumber_key" ON "User"("employeeNumber");

-- Backfill: existing employee accounts, oldest account first, so the
-- current team is numbered in the order their accounts were created.
WITH staff AS (
  SELECT "id",
         ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC) AS rn
  FROM "User"
  WHERE "employeeNumber" IS NULL
    AND NOT ("roles" @> ARRAY['COMPANY_OWNER']::"Role"[])
    AND (
      "roles" @> ARRAY['DISPATCHER']::"Role"[]
      OR "roles" @> ARRAY['COMPANY_ADMIN']::"Role"[]
      OR "roles" @> ARRAY['PLATFORM_ADMIN']::"Role"[]
      OR "roles" @> ARRAY['PROVIDER_OWNER']::"Role"[]
      OR "roles" @> ARRAY['PROVIDER_TECH']::"Role"[]
      OR "roles" @> ARRAY['TECHNICIAN']::"Role"[]
    )
)
UPDATE "User" AS u
SET "employeeNumber" = 'TS-' || (1000 + staff.rn)::text
FROM staff
WHERE u."id" = staff."id";

-- Pepper — Systems Manager console (2026-11-18): the PepperReport log
-- behind the /pepper duty post in the Workstation. Additive only — one
-- brand-new table and one enum type; no existing record changes
-- meaning. createdByUserId is SetNull so a report outlives the account
-- that filed it (same discipline as AdProviderAudit's actor).

-- CreateEnum
CREATE TYPE "PepperReportCategory" AS ENUM ('STATUS', 'ACTION_TAKEN', 'NEEDS_OWNER', 'INCIDENT');

-- CreateTable
CREATE TABLE "PepperReport" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "PepperReportCategory" NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PepperReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PepperReport_createdAt_idx" ON "PepperReport"("createdAt");

-- CreateIndex
CREATE INDEX "PepperReport_createdByUserId_createdAt_idx" ON "PepperReport"("createdByUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "PepperReport" ADD CONSTRAINT "PepperReport_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

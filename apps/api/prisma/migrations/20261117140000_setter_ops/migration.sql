-- Service Setters operations build (2026-11-17, Operations Blueprint
-- §§3/5/7/12): a staff-set priority tier on the booking, and the
-- office's capacity-planning settings table. Additive only — the
-- priority column is nullable (unset tiers derive at read time) and
-- the settings table starts empty (a missing row = blueprint
-- defaults), so no existing record changes meaning.

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN "priorityTier" TEXT;

-- CreateTable
CREATE TABLE "DispatchSetting" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "bufferPercent" INTEGER NOT NULL DEFAULT 25,
    "minutesPerJob" INTEGER NOT NULL DEFAULT 120,
    "workingHoursPerDay" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DispatchSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DispatchSetting_companyId_key" ON "DispatchSetting"("companyId");

-- AddForeignKey
ALTER TABLE "DispatchSetting" ADD CONSTRAINT "DispatchSetting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

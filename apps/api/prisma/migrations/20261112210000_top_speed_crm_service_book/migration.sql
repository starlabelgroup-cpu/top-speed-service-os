-- Top Speed CRM / Service Book (2026-11-12): bookings gain the resolved
-- service area (book-by-area model), its resolution status, and a
-- per-job service-address snapshot; staff gain a notes table for the
-- CRM customer 360. All new booking columns are nullable / defaulted —
-- rows created before this change hydrate with an area derived from
-- their city (see db/bookingsRepo.js), so nothing existing changes
-- meaning. areaStatus defaults to IN_AREA to match that derivation.
ALTER TABLE "ServiceRequest" ADD COLUMN "area" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN "areaStatus" TEXT NOT NULL DEFAULT 'IN_AREA';
ALTER TABLE "ServiceRequest" ADD COLUMN "serviceAddress" TEXT;

CREATE INDEX "ServiceRequest_companyId_area_idx" ON "ServiceRequest"("companyId", "area");
CREATE INDEX "ServiceRequest_companyId_areaStatus_idx" ON "ServiceRequest"("companyId", "areaStatus");

CREATE TABLE "CrmNote" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmNote_customerId_createdAt_idx" ON "CrmNote"("customerId", "createdAt");
CREATE INDEX "CrmNote_companyId_idx" ON "CrmNote"("companyId");

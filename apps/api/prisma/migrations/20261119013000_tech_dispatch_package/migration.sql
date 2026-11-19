-- Tech App dispatch package (2026-11-19): the record types the
-- platform did not have for Ramone's full-package Tech App rebuild,
-- shaped by the "Top Speed Service OS Enterprise" blueprint —
-- Property (a customer's service location + access notes as its own
-- record), Warranty (coverage for one job's appliance, looked up by
-- appliance in the consolidated job view) and WarrantyClaim (a
-- first-class, searchable warranty claim filed against a job).
-- Additive only — three brand-new tables, plain id columns in the
-- CrmNote / InboxMessage style (no foreign keys: the working set is
-- the in-memory store with write-through persistence). The Invoice
-- table already exists and gains its creation path in the API in
-- the same build; no change to it here.

-- CreateTable
CREATE TABLE "Property" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "label" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "unit" TEXT,
    "accessNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warranty" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "serviceRequestId" UUID NOT NULL,
    "customerId" UUID,
    "applianceType" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "serial" TEXT,
    "provider" TEXT NOT NULL,
    "coverage" TEXT,
    "policyNumber" TEXT,
    "expiresAt" TIMESTAMP(3),
    "claimStatus" TEXT NOT NULL DEFAULT 'Not Filed',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warranty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarrantyClaim" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "serviceRequestId" UUID NOT NULL,
    "assignmentId" UUID,
    "customerId" UUID,
    "warrantyId" UUID,
    "claimNumber" TEXT,
    "warrantyProvider" TEXT,
    "authorization" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL,
    "notes" TEXT,
    "amountCents" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarrantyClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Property_companyId_idx" ON "Property"("companyId");

-- CreateIndex
CREATE INDEX "Property_customerId_idx" ON "Property"("customerId");

-- CreateIndex
CREATE INDEX "Warranty_companyId_idx" ON "Warranty"("companyId");

-- CreateIndex
CREATE INDEX "Warranty_serviceRequestId_idx" ON "Warranty"("serviceRequestId");

-- CreateIndex
CREATE INDEX "Warranty_serial_idx" ON "Warranty"("serial");

-- CreateIndex
CREATE INDEX "WarrantyClaim_companyId_status_idx" ON "WarrantyClaim"("companyId", "status");

-- CreateIndex
CREATE INDEX "WarrantyClaim_serviceRequestId_idx" ON "WarrantyClaim"("serviceRequestId");

-- CreateIndex
CREATE INDEX "WarrantyClaim_warrantyId_idx" ON "WarrantyClaim"("warrantyId");

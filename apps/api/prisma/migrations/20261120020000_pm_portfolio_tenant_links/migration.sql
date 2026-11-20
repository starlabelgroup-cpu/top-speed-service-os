-- Connect Pro — PM Portfolio + Tenant Request Links (2026-11-20, B5 + B6).
-- Plain reference columns (PlatformEvent style): ownerId is the PM's
-- User id; no foreign keys, so the portfolio never entangles the
-- account tables. Tenant link tokens and tenant status tokens are
-- stored ONLY as SHA-256 hashes.

-- CreateTable
CREATE TABLE "PmProperty" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PmProperty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmUnit" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "tenantName" TEXT,
    "tenantPhone" TEXT,
    "tenantEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PmUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmTenantLink" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PmTenantLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmServiceRequest" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "unitId" UUID,
    "origin" TEXT NOT NULL,
    "batchReference" TEXT,
    "reference" TEXT NOT NULL,
    "tenantName" TEXT,
    "tenantPhone" TEXT,
    "tenantEmail" TEXT,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "appliance" TEXT NOT NULL,
    "issue" TEXT NOT NULL,
    "urgency" TEXT NOT NULL DEFAULT 'standard',
    "accessNotes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "statusTokenHash" TEXT,
    "connectionId" UUID,
    "connectionReference" TEXT,
    "bookingId" UUID,
    "bookingReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PmServiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PmProperty_companyId_ownerId_idx" ON "PmProperty"("companyId", "ownerId");

-- CreateIndex
CREATE INDEX "PmUnit_propertyId_idx" ON "PmUnit"("propertyId");

-- CreateIndex
CREATE INDEX "PmUnit_companyId_ownerId_idx" ON "PmUnit"("companyId", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "PmTenantLink_propertyId_key" ON "PmTenantLink"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "PmTenantLink_tokenHash_key" ON "PmTenantLink"("tokenHash");

-- CreateIndex
CREATE INDEX "PmTenantLink_companyId_ownerId_idx" ON "PmTenantLink"("companyId", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "PmServiceRequest_reference_key" ON "PmServiceRequest"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "PmServiceRequest_statusTokenHash_key" ON "PmServiceRequest"("statusTokenHash");

-- CreateIndex
CREATE INDEX "PmServiceRequest_companyId_ownerId_status_idx" ON "PmServiceRequest"("companyId", "ownerId", "status");

-- CreateIndex
CREATE INDEX "PmServiceRequest_propertyId_idx" ON "PmServiceRequest"("propertyId");

-- CreateIndex
CREATE INDEX "PmServiceRequest_unitId_idx" ON "PmServiceRequest"("unitId");

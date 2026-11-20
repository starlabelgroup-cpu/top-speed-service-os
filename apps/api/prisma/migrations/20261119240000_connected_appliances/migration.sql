-- Connected-appliance foundation (2026-11-19, Ramone's order — the
-- Smart Home Connect takeaway): the registry of manufacturer-network
-- connections a customer consents to for a garage appliance, plus the
-- event table brand fault/status events will land in once a real
-- integration exists. Additive only — two brand-new tables, no
-- existing record changes meaning. A REGISTERED row records consent
-- only: externalId stays NULL and NO row may be LINKED until a real
-- manufacturer link exists. REVOKED is the end state for a row;
-- re-registering creates a fresh row.

-- CreateTable
CREATE TABLE "ApplianceConnection" (
    "id" UUID NOT NULL,
    "applianceId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REGISTERED',
    "consentAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplianceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplianceEvent" (
    "id" UUID NOT NULL,
    "applianceId" UUID NOT NULL,
    "connectionId" UUID,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payload" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplianceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApplianceConnection_applianceId_idx" ON "ApplianceConnection"("applianceId");

-- CreateIndex
CREATE INDEX "ApplianceConnection_provider_status_idx" ON "ApplianceConnection"("provider", "status");

-- CreateIndex
CREATE INDEX "ApplianceEvent_applianceId_idx" ON "ApplianceEvent"("applianceId");

-- CreateIndex
CREATE INDEX "ApplianceEvent_connectionId_idx" ON "ApplianceEvent"("connectionId");

-- One ACTIVE (non-revoked) connection per appliance + provider:
-- a customer can re-register after revoking (a fresh row), but can
-- never hold two live registrations for the same network.
CREATE UNIQUE INDEX "ApplianceConnection_active_provider_key" ON "ApplianceConnection"("applianceId", "provider") WHERE "status" <> 'REVOKED';

-- AddForeignKey
ALTER TABLE "ApplianceConnection" ADD CONSTRAINT "ApplianceConnection_applianceId_fkey" FOREIGN KEY ("applianceId") REFERENCES "CustomerAppliance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplianceEvent" ADD CONSTRAINT "ApplianceEvent_applianceId_fkey" FOREIGN KEY ("applianceId") REFERENCES "CustomerAppliance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplianceEvent" ADD CONSTRAINT "ApplianceEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ApplianceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AdStream Providers (2026-11-18, Phase 1): the platform-level
-- ad-serving provider registry (AdProviderConnection) + its audit log
-- (AdProviderAudit). Additive only — two brand-new tables and two
-- enum types; no existing record changes meaning. Phase 1 stores no
-- third-party credentials; a row reads CONNECTED only after a real
-- completed connect flow (see routes/adProviders.js).

-- CreateEnum
CREATE TYPE "AdServingProvider" AS ENUM ('KEVEL', 'ADBUTLER', 'GOOGLE_AD_MANAGER', 'SPRINGSERVE', 'FREEWHEEL');

-- CreateEnum
CREATE TYPE "AdProviderConnectionStatus" AS ENUM ('NOT_CONNECTED', 'PENDING', 'CONNECTED', 'ERROR', 'REVOKED');

-- CreateTable
CREATE TABLE "AdProviderConnection" (
    "id" UUID NOT NULL,
    "provider" "AdServingProvider" NOT NULL,
    "status" "AdProviderConnectionStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "externalAccountLabel" TEXT,
    "connectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdProviderAudit" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdProviderAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdProviderConnection_provider_key" ON "AdProviderConnection"("provider");

-- CreateIndex
CREATE INDEX "AdProviderConnection_status_idx" ON "AdProviderConnection"("status");

-- CreateIndex
CREATE INDEX "AdProviderAudit_connectionId_createdAt_idx" ON "AdProviderAudit"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "AdProviderAudit_actorUserId_createdAt_idx" ON "AdProviderAudit"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "AdProviderAudit" ADD CONSTRAINT "AdProviderAudit_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AdProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdProviderAudit" ADD CONSTRAINT "AdProviderAudit_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


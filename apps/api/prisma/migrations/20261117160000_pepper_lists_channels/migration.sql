-- Pepper Lists Channel Connections (2026-11-17, Phase 1): the seller
-- channel registry (SellerChannelConnection) + its audit log
-- (SellerChannelAudit). Additive only — two brand-new tables and three
-- enum types; no existing record changes meaning. Phase 1 stores no
-- third-party tokens; a row reads CONNECTED only after a real
-- completed connect flow (see routes/pepperListsChannels.js).

-- CreateEnum
CREATE TYPE "SellerChannel" AS ENUM ('FACEBOOK', 'GOOGLE_SHOPPING', 'EBAY', 'ETSY', 'WALMART', 'TIKTOK', 'YOUTUBE', 'INSTAGRAM', 'X', 'LINKEDIN');

-- CreateEnum
CREATE TYPE "SellerChannelKind" AS ENUM ('SELL', 'POST');

-- CreateEnum
CREATE TYPE "SellerChannelStatus" AS ENUM ('NOT_CONNECTED', 'PENDING', 'CONNECTED', 'ERROR', 'REVOKED');

-- CreateTable
CREATE TABLE "SellerChannelConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "SellerChannel" NOT NULL,
    "kind" "SellerChannelKind" NOT NULL,
    "status" "SellerChannelStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "externalAccountLabel" TEXT,
    "agentAccessGranted" BOOLEAN NOT NULL DEFAULT false,
    "connectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerChannelAudit" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerChannelAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerChannelConnection_userId_channel_key" ON "SellerChannelConnection"("userId", "channel");

-- CreateIndex
CREATE INDEX "SellerChannelConnection_status_idx" ON "SellerChannelConnection"("status");

-- CreateIndex
CREATE INDEX "SellerChannelAudit_connectionId_createdAt_idx" ON "SellerChannelAudit"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "SellerChannelAudit_userId_createdAt_idx" ON "SellerChannelAudit"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "SellerChannelConnection" ADD CONSTRAINT "SellerChannelConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerChannelAudit" ADD CONSTRAINT "SellerChannelAudit_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SellerChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerChannelAudit" ADD CONSTRAINT "SellerChannelAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

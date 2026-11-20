-- Pepper Lists — Phase 2 syndication + buyer–seller messaging
-- (2026-11-20, recommendations program C16 + C18).
-- Additive only: three brand-new tables and three enum types; no
-- existing record changes meaning. A syndication row is QUEUED when
-- a seller asks for a listing to be syndicated to eBay or Google
-- Shopping, and reaches POSTED only when staff record the real
-- outcome (the real eBay listing URL, or the real Merchant Center
-- product id/link) — the server never writes to eBay or Google
-- itself (see routes/pepperListsGrowth.js). A message thread holds
-- the on-platform conversation between one buyer and a listing's
-- seller; only the two parties can read or post in it, staff reach
-- it through the moderation lanes, and a thread is never a lead.

-- CreateEnum
CREATE TYPE "PepperListsSyndicationChannel" AS ENUM ('EBAY', 'GOOGLE_SHOPPING');

-- CreateEnum
CREATE TYPE "PepperListsSyndicationStatus" AS ENUM ('QUEUED', 'POSTED', 'FAILED');

-- CreateEnum
CREATE TYPE "PepperListsThreadStatus" AS ENUM ('OPEN', 'REPORTED', 'CLOSED');

-- CreateTable
CREATE TABLE "PepperListsSyndication" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "listingReference" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "PepperListsSyndicationChannel" NOT NULL,
    "status" "PepperListsSyndicationStatus" NOT NULL DEFAULT 'QUEUED',
    "externalId" TEXT,
    "externalUrl" TEXT,
    "error" TEXT,
    "outcomeById" UUID,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PepperListsSyndication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PepperListsThread" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "listingReference" TEXT NOT NULL,
    "sellerUserId" UUID NOT NULL,
    "buyerUserId" UUID NOT NULL,
    "status" "PepperListsThreadStatus" NOT NULL DEFAULT 'OPEN',
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PepperListsThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PepperListsMessage" (
    "id" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "senderUserId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PepperListsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PepperListsSyndication_connectionId_channel_status_idx" ON "PepperListsSyndication"("connectionId", "channel", "status");

-- CreateIndex
CREATE INDEX "PepperListsSyndication_status_createdAt_idx" ON "PepperListsSyndication"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsSyndication_userId_createdAt_idx" ON "PepperListsSyndication"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PepperListsThread_connectionId_buyerUserId_key" ON "PepperListsThread"("connectionId", "buyerUserId");

-- CreateIndex
CREATE INDEX "PepperListsThread_sellerUserId_lastMessageAt_idx" ON "PepperListsThread"("sellerUserId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "PepperListsThread_buyerUserId_lastMessageAt_idx" ON "PepperListsThread"("buyerUserId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "PepperListsThread_status_updatedAt_idx" ON "PepperListsThread"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "PepperListsMessage_threadId_createdAt_idx" ON "PepperListsMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsMessage_threadId_readAt_idx" ON "PepperListsMessage"("threadId", "readAt");

-- Pepper Lists — Facebook cross-post queue (2026-11-20, Phase A).
-- Additive only: one brand-new table and two enum types; no existing
-- record changes meaning. A row is QUEUED when a seller asks for a
-- listing to be posted to Facebook, and reaches POSTED only when
-- staff record the real outcome (with the real Facebook listing
-- URL) after Pepper posts it through the owner's connected Facebook
-- account behind Ramone's per-listing approval — the server never
-- writes to Facebook itself (see routes/pepperListsFacebook.js).

-- CreateEnum
CREATE TYPE "PepperListsCrossPostTarget" AS ENUM ('MARKETPLACE', 'PAGE');

-- CreateEnum
CREATE TYPE "PepperListsCrossPostStatus" AS ENUM ('QUEUED', 'POSTED', 'FAILED');

-- CreateTable
CREATE TABLE "PepperListsCrossPost" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "listingReference" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "target" "PepperListsCrossPostTarget" NOT NULL,
    "pageId" TEXT,
    "status" "PepperListsCrossPostStatus" NOT NULL DEFAULT 'QUEUED',
    "externalId" TEXT,
    "externalUrl" TEXT,
    "error" TEXT,
    "outcomeById" UUID,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PepperListsCrossPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PepperListsCrossPost_connectionId_target_status_idx" ON "PepperListsCrossPost"("connectionId", "target", "status");

-- CreateIndex
CREATE INDEX "PepperListsCrossPost_status_createdAt_idx" ON "PepperListsCrossPost"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsCrossPost_userId_createdAt_idx" ON "PepperListsCrossPost"("userId", "createdAt");

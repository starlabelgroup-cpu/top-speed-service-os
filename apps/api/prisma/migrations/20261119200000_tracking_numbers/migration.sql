-- Satellite Website Tracking Number System (2026-11-19): the registry
-- of per-surface phone numbers and email addresses plus the inbound
-- contact log the Twilio webhooks write (fail-open, after the TwiML
-- response is computed). Additive only — two brand-new tables, no
-- existing record changes meaning. A PLANNED registry row carries a
-- NULL value: the surface has no dedicated number yet. Registry rows
-- are never deleted; RETIRED is the end state.

-- CreateTable
CREATE TABLE "TrackingNumber" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT,
    "label" TEXT NOT NULL,
    "surfaceKey" TEXT NOT NULL,
    "channels" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "seedKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackingNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactEvent" (
    "id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "trackingNumberId" UUID,
    "surfaceKey" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "externalSid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackingNumber_seedKey_key" ON "TrackingNumber"("seedKey");

-- CreateIndex
CREATE INDEX "TrackingNumber_surfaceKey_idx" ON "TrackingNumber"("surfaceKey");

-- CreateIndex
CREATE INDEX "TrackingNumber_status_idx" ON "TrackingNumber"("status");

-- CreateIndex
CREATE INDEX "TrackingNumber_kind_value_idx" ON "TrackingNumber"("kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ContactEvent_externalSid_key" ON "ContactEvent"("externalSid");

-- CreateIndex
CREATE INDEX "ContactEvent_createdAt_idx" ON "ContactEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ContactEvent_trackingNumberId_createdAt_idx" ON "ContactEvent"("trackingNumberId", "createdAt");

-- CreateIndex
CREATE INDEX "ContactEvent_surfaceKey_createdAt_idx" ON "ContactEvent"("surfaceKey", "createdAt");

-- AddForeignKey
ALTER TABLE "ContactEvent" ADD CONSTRAINT "ContactEvent_trackingNumberId_fkey" FOREIGN KEY ("trackingNumberId") REFERENCES "TrackingNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

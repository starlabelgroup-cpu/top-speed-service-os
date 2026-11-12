-- Unified notifications system (2026-11-11): outbox entries gain an
-- idempotency event key, an event type, and a GATED reason; staff
-- notification toggles get their own settings table.
ALTER TABLE "NotificationOutbox" ADD COLUMN "eventKey" TEXT;
ALTER TABLE "NotificationOutbox" ADD COLUMN "eventType" TEXT;
ALTER TABLE "NotificationOutbox" ADD COLUMN "reason" TEXT;

CREATE UNIQUE INDEX "NotificationOutbox_eventKey_key" ON "NotificationOutbox"("eventKey");

CREATE TABLE "NotificationSetting" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationSetting_key_key" ON "NotificationSetting"("key");

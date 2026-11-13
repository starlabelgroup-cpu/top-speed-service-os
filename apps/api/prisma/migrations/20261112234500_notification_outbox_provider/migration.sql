-- Fallback provider routing: record which provider delivered an outbox entry.
ALTER TABLE "NotificationOutbox" ADD COLUMN "provider" TEXT;

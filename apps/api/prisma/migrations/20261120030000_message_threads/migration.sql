-- Setter–customer message threads (2026-11-20, Wave 1 setter comms):
-- the two-way conversation record behind the Book OS + CRM composer
-- (staff-composed SMS/email, automated appointment reminders, and the
-- customer's inbound replies in one thread per booking/customer).
-- Outbound rows carry the notification-outbox entry id and the
-- delivery state exactly as the provider recorded it — a message is
-- SENT only when the provider accepted it. Additive only — two
-- brand-new tables, no existing table is touched.
CREATE TABLE "MessageThread" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID,
    "bookingId" UUID,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3),

    CONSTRAINT "MessageThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ThreadMessage" (
    "id" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MESSAGE',
    "body" TEXT NOT NULL,
    "subject" TEXT,
    "author" TEXT,
    "outboxEntryId" UUID,
    "deliveryStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
    "deliveryError" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MessageThread_companyId_customerId_idx" ON "MessageThread"("companyId", "customerId");

CREATE INDEX "MessageThread_companyId_bookingId_idx" ON "MessageThread"("companyId", "bookingId");

CREATE UNIQUE INDEX "ThreadMessage_externalId_key" ON "ThreadMessage"("externalId");

CREATE INDEX "ThreadMessage_threadId_createdAt_idx" ON "ThreadMessage"("threadId", "createdAt");

CREATE INDEX "ThreadMessage_companyId_createdAt_idx" ON "ThreadMessage"("companyId", "createdAt");

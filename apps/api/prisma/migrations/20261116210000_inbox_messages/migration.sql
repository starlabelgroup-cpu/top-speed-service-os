-- Book OS Inbox (2026-11-16): inbound email received through the
-- Resend webhook (service@ forwards a copy of every message to the
-- Resend receiving address on the verified updates subdomain), plus
-- the staff replies sent back out through Resend. Additive only —
-- one new table, nothing existing is touched. Plain columns in the
-- CrmNote style; customerId / connectionId are nullable so mail from
-- an unknown sender still queues instead of being dropped.

-- CreateTable
CREATE TABLE "InboxMessage" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'INBOUND',
    "providerEmailId" TEXT,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "toEmail" TEXT NOT NULL,
    "mailbox" TEXT,
    "subject" TEXT NOT NULL,
    "textBody" TEXT,
    "htmlBody" TEXT,
    "snippet" TEXT,
    "customerId" UUID,
    "connectionId" UUID,
    "threadRootId" UUID,
    "messageIdHeader" TEXT,
    "inReplyToHeader" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNREAD',
    "author" TEXT,
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboxMessage_providerEmailId_key" ON "InboxMessage"("providerEmailId");

-- CreateIndex
CREATE INDEX "InboxMessage_companyId_status_createdAt_idx" ON "InboxMessage"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "InboxMessage_companyId_mailbox_createdAt_idx" ON "InboxMessage"("companyId", "mailbox", "createdAt");

-- CreateIndex
CREATE INDEX "InboxMessage_customerId_createdAt_idx" ON "InboxMessage"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "InboxMessage_threadRootId_idx" ON "InboxMessage"("threadRootId");

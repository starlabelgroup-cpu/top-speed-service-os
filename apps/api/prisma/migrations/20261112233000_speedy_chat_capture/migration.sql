-- Speedy chat capture (2026-11-12): every customer conversation with
-- Speedy is stored for staff analysis (Chat Insights). New tables only —
-- nothing existing changes meaning. Capture is best-effort at runtime:
-- if these tables are missing mid-deploy the chat still answers and the
-- capture for that exchange is skipped (see services/chatCapture.js).
CREATE TABLE "SpeedyChatSession" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "userId" UUID,
    "source" TEXT NOT NULL DEFAULT 'unknown',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "hadDiagnosis" BOOLEAN NOT NULL DEFAULT false,
    "convertedBookingReference" TEXT,
    "hasUnanswered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpeedyChatSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SpeedyChatMessage" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpeedyChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SpeedyChatSession_companyId_startedAt_idx" ON "SpeedyChatSession"("companyId", "startedAt");
CREATE INDEX "SpeedyChatSession_companyId_source_startedAt_idx" ON "SpeedyChatSession"("companyId", "source", "startedAt");
CREATE INDEX "SpeedyChatMessage_sessionId_createdAt_idx" ON "SpeedyChatMessage"("sessionId", "createdAt");

ALTER TABLE "SpeedyChatMessage" ADD CONSTRAINT "SpeedyChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SpeedyChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

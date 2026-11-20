-- Call recordings + transcripts (2026-11-20, D8 — SHIPS DARK).
-- Additive only — one brand-new table. Rows can only be created by
-- the Twilio call-recording callbacks, which can only fire when the
-- CALL_RECORDING_ENABLED flag is on; the flag defaults OFF (Florida
-- is a two-party-consent state and the owner's consent policy is
-- pending), so deploying this migration records nothing. Distinct
-- from the voicemail flow, which is unchanged.

-- CreateTable
CREATE TABLE "CallRecording" (
    "id" UUID NOT NULL,
    "callSid" TEXT NOT NULL,
    "recordingSid" TEXT,
    "fromNumber" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "recordingUrl" TEXT,
    "durationSec" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "transcript" TEXT,
    "transcriptStatus" TEXT NOT NULL DEFAULT 'NONE',
    "consentAnnouncementPlayed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallRecording_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallRecording_callSid_key" ON "CallRecording"("callSid");

-- CreateIndex
CREATE UNIQUE INDEX "CallRecording_recordingSid_key" ON "CallRecording"("recordingSid");

-- CreateIndex
CREATE INDEX "CallRecording_fromNumber_createdAt_idx" ON "CallRecording"("fromNumber", "createdAt");

-- CreateIndex
CREATE INDEX "CallRecording_toNumber_createdAt_idx" ON "CallRecording"("toNumber", "createdAt");

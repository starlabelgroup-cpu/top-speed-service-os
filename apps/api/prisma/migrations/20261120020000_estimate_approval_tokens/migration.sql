-- Estimate approval links (2026-11-20, Wave 1 D3): the
-- customer-facing approval page for a saved estimate. Only the
-- SHA-256 hash of the link token is stored; the raw token travels
-- only in the link staff send through the Link Center. The row
-- records which estimate the link was minted for, the customer's
-- single decision (claimed atomically), and supersession when a
-- newer estimate replaces it. Links live 7 days. The decision of
-- record lives on the booking's history (ESTIMATE_APPROVED /
-- ESTIMATE_DECLINED via the shared job-money recorder) — this table
-- only proves which link carried it. Additive only — one brand-new
-- table.
CREATE TABLE "EstimateApprovalToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "bookingId" UUID NOT NULL,
    "estimateId" TEXT NOT NULL,
    "decision" TEXT,
    "declineNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateApprovalToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EstimateApprovalToken_tokenHash_key" ON "EstimateApprovalToken"("tokenHash");

CREATE INDEX "EstimateApprovalToken_bookingId_idx" ON "EstimateApprovalToken"("bookingId");

CREATE INDEX "EstimateApprovalToken_expiresAt_idx" ON "EstimateApprovalToken"("expiresAt");

ALTER TABLE "EstimateApprovalToken" ADD CONSTRAINT "EstimateApprovalToken_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "ServiceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

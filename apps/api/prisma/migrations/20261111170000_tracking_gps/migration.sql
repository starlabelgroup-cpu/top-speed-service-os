-- Track My Tech live GPS + secure per-job tracking links (2026-11-11).
ALTER TABLE "DispatchAssignment" ADD COLUMN "lastLat" DOUBLE PRECISION;
ALTER TABLE "DispatchAssignment" ADD COLUMN "lastLng" DOUBLE PRECISION;
ALTER TABLE "DispatchAssignment" ADD COLUMN "lastLocationAt" TIMESTAMP(3);

CREATE TABLE "TrackingToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "bookingId" UUID NOT NULL,
    "issuedBy" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrackingToken_tokenHash_key" ON "TrackingToken"("tokenHash");
CREATE INDEX "TrackingToken_bookingId_idx" ON "TrackingToken"("bookingId");

ALTER TABLE "TrackingToken" ADD CONSTRAINT "TrackingToken_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "ServiceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

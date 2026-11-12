-- Super Apps cross-site sign-in handoff (2026-11-12).
-- One-time, audience-bound, five-minute sign-in tokens exchanged between
-- the flagship, the customer app, Connect Pro, and Appliance Pro. Only
-- SHA-256 hashes are stored.
CREATE TABLE "AuthHandoff" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "audience" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthHandoff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthHandoff_tokenHash_key" ON "AuthHandoff"("tokenHash");

CREATE INDEX "AuthHandoff_userId_idx" ON "AuthHandoff"("userId");

CREATE INDEX "AuthHandoff_expiresAt_idx" ON "AuthHandoff"("expiresAt");

ALTER TABLE "AuthHandoff" ADD CONSTRAINT "AuthHandoff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

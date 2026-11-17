-- Multi-account session handoffs (2026-11-17): one-time, 60-second,
-- hash-only cross-host sign-in codes (see the SessionHandoff model).
-- Additive only — a brand-new table; no existing record changes meaning.

-- CreateTable
CREATE TABLE "SessionHandoff" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "sv" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionHandoff_codeHash_key" ON "SessionHandoff"("codeHash");

-- CreateIndex
CREATE INDEX "SessionHandoff_userId_idx" ON "SessionHandoff"("userId");

-- CreateIndex
CREATE INDEX "SessionHandoff_expiresAt_idx" ON "SessionHandoff"("expiresAt");

-- AddForeignKey
ALTER TABLE "SessionHandoff" ADD CONSTRAINT "SessionHandoff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

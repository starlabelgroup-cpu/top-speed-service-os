-- Username (email) change tokens (2026-11-20): the self-serve
-- email-change flow. Only the SHA-256 hash of the emailed token is
-- stored; the raw token travels only in the confirmation link sent
-- to the NEW address. The row records the requested newEmail so the
-- exchange can re-check it is still free at confirm time. Tokens
-- live 30 minutes, are single-use, and issuing a new one supersedes
-- every still-unused token for the account (the PasswordResetToken
-- discipline). Additive only — one brand-new table.
CREATE TABLE "EmailChangeToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "newEmail" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailChangeToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailChangeToken_tokenHash_key" ON "EmailChangeToken"("tokenHash");

CREATE INDEX "EmailChangeToken_userId_idx" ON "EmailChangeToken"("userId");

CREATE INDEX "EmailChangeToken_expiresAt_idx" ON "EmailChangeToken"("expiresAt");

ALTER TABLE "EmailChangeToken" ADD CONSTRAINT "EmailChangeToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

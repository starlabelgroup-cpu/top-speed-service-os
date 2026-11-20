-- Email sign-in link tokens (2026-11-20): the passwordless sign-in
-- door Ramone approved (email sign-in link replaces the password +
-- access-code steps at sign-in; account issuance stays office-only).
-- Only the SHA-256 hash of the emailed token is stored; the raw token
-- travels only in the sign-in link. Tokens live 30 minutes, are
-- single-use, and issuing a new one supersedes every still-unused
-- token for the account (the PasswordResetToken discipline).
CREATE TABLE "EmailSignInToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSignInToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailSignInToken_tokenHash_key" ON "EmailSignInToken"("tokenHash");

CREATE INDEX "EmailSignInToken_userId_idx" ON "EmailSignInToken"("userId");

CREATE INDEX "EmailSignInToken_expiresAt_idx" ON "EmailSignInToken"("expiresAt");

ALTER TABLE "EmailSignInToken" ADD CONSTRAINT "EmailSignInToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

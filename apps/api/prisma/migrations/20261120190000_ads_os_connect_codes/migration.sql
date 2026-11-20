-- Ads OS connect codes (2026-11-20): the "Sign in with Top Speed
-- Service OS" door for the Top Speed Ads OS console. Only the
-- SHA-256 hash of the one-time code is stored; the raw code is
-- returned once by the mint response and travels only from the
-- signed-in user's screen to the console. Codes live 10 minutes,
-- are single-use, and issuing a new one supersedes every
-- still-unused code for the account (the EmailSignInToken
-- discipline).
CREATE TABLE "AdsOsConnectCode" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsOsConnectCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdsOsConnectCode_codeHash_key" ON "AdsOsConnectCode"("codeHash");

CREATE INDEX "AdsOsConnectCode_userId_idx" ON "AdsOsConnectCode"("userId");

CREATE INDEX "AdsOsConnectCode_expiresAt_idx" ON "AdsOsConnectCode"("expiresAt");

ALTER TABLE "AdsOsConnectCode" ADD CONSTRAINT "AdsOsConnectCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

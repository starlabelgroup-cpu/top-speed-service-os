-- Offer sign-ups + email verification (2026-11-12): accounts gain
-- email-verification state, signup attribution (source / offer slug /
-- audience), and the profile-completion service address resolved
-- through the Service Book area model. All new User columns are
-- nullable — existing accounts hydrate unchanged (unverified simply
-- means "registered before verification existed" or "not clicked
-- yet"; verification is a soft prompt, never a lockout).
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "signupSource" TEXT;
ALTER TABLE "User" ADD COLUMN "signupOfferSlug" TEXT;
ALTER TABLE "User" ADD COLUMN "signupAudience" TEXT;
ALTER TABLE "User" ADD COLUMN "serviceStreet" TEXT;
ALTER TABLE "User" ADD COLUMN "serviceCity" TEXT;
ALTER TABLE "User" ADD COLUMN "serviceZip" TEXT;
ALTER TABLE "User" ADD COLUMN "serviceArea" TEXT;
ALTER TABLE "User" ADD COLUMN "serviceAreaStatus" TEXT;

CREATE TABLE "EmailVerificationToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

CREATE INDEX "EmailVerificationToken_userId_idx" ON "EmailVerificationToken"("userId");

CREATE INDEX "EmailVerificationToken_expiresAt_idx" ON "EmailVerificationToken"("expiresAt");

ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

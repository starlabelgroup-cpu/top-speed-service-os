-- Legal gate (2026-11-12): typed-name acceptance of the two current
-- legal documents (Top Speed Service OS Terms & Conditions and the
-- Appliance Connect Software Terms of Use, both v1.0 effective
-- 2026-11-12) is recorded per account before access. One row per
-- (user, document, version); a future version bump requires a fresh
-- row, which is how re-acceptance is enforced.
CREATE TABLE "TermsAcceptance" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "document" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "signatureName" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TermsAcceptance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TermsAcceptance_userId_document_version_key" ON "TermsAcceptance"("userId", "document", "version");

CREATE INDEX "TermsAcceptance_userId_idx" ON "TermsAcceptance"("userId");

ALTER TABLE "TermsAcceptance" ADD CONSTRAINT "TermsAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Academy completions (2026-11-20, recommendations D12): one row per
-- curriculum module a trainee completed, recorded by the Academy
-- against a module in the live curriculum. Track certifications are
-- derived from these rows (all of a track's live modules completed),
-- never stored, and never grant roles or credentials. Additive only —
-- one brand-new table.
CREATE TABLE "AcademyCompletion" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "providerId" UUID,
    "moduleSlug" TEXT NOT NULL,
    "moduleNumber" INTEGER NOT NULL,
    "trackName" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademyCompletion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AcademyCompletion_userId_moduleSlug_key" ON "AcademyCompletion"("userId", "moduleSlug");

CREATE INDEX "AcademyCompletion_companyId_userId_idx" ON "AcademyCompletion"("companyId", "userId");

CREATE INDEX "AcademyCompletion_userId_idx" ON "AcademyCompletion"("userId");

CREATE INDEX "AcademyCompletion_providerId_idx" ON "AcademyCompletion"("providerId");

ALTER TABLE "AcademyCompletion" ADD CONSTRAINT "AcademyCompletion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

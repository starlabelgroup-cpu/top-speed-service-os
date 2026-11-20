-- Content Creator / Publisher accounts (2026-11-19, Ramone's order):
-- a new external role for Media OS creators/publishers, plus the
-- per-item owner column their workspace is scoped by. Existing
-- MediaContent rows keep ownerId NULL = staff-owned.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'CONTENT_CREATOR';

-- AlterTable
ALTER TABLE "MediaContent" ADD COLUMN "ownerId" UUID;

-- CreateIndex
CREATE INDEX "MediaContent_ownerId_idx" ON "MediaContent"("ownerId");

-- AddForeignKey
ALTER TABLE "MediaContent" ADD CONSTRAINT "MediaContent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

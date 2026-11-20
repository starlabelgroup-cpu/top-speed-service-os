-- Before/after video factory (2026-11-20, E9): raw MP4 bytes for
-- Media OS content records the factory renders from a completed job's
-- own before/after photos. Additive only — one brand-new table, no
-- existing record changes meaning. The MediaContent record a blob
-- belongs to is always created as a DRAFT by the factory; publishing
-- stays with the human editorial workflow in routes/mediaOs.js.

-- CreateTable
CREATE TABLE "MediaVideoBlob" (
    "id" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaVideoBlob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaVideoBlob_contentId_key" ON "MediaVideoBlob"("contentId");

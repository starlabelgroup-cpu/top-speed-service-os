-- Pepper Lists Speedy Brain (2026-11-16): media a signed-in customer
-- sends to the Service Setters (scan & send photos/videos). Additive
-- only — one new table, nothing existing is touched.

-- CreateTable
CREATE TABLE "SubmissionMedia" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "dataUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubmissionMedia_connectionId_idx" ON "SubmissionMedia"("connectionId");

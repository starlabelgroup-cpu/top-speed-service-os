-- Wave 3 marketing package B (2026-11-20): Public Help Center
-- publishing state (E5) + Media OS → Facebook Page publish queue
-- (E6). Additive only: two brand-new tables and one enum type; no
-- existing record changes meaning.
--
-- HelpArticleState holds ONLY the human publishing decision for a
-- Speedy knowledge entry (the articles live in code, rebuilt from
-- live platform sources): no row = not public; PUBLISHED is set by a
-- staff member, never automatically.
--
-- MediaFacebookPost is a QUEUE, not a poster: a row is born QUEUED
-- when staff publish Media OS content, and reaches POSTED only when
-- staff record the real outcome (with the real facebook.com post
-- URL) after Pepper posts through the owner's connected Facebook
-- account behind Ramone's approval — the server never writes to
-- Facebook itself (see services/mediaFacebook.js).

-- CreateEnum
CREATE TYPE "MediaFacebookPostStatus" AS ENUM ('QUEUED', 'POSTED', 'FAILED');

-- CreateTable
CREATE TABLE "MediaFacebookPost" (
    "id" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "contentSlug" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "pageName" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "linkUrl" TEXT,
    "imageUrl" TEXT,
    "status" "MediaFacebookPostStatus" NOT NULL DEFAULT 'QUEUED',
    "externalId" TEXT,
    "externalUrl" TEXT,
    "error" TEXT,
    "outcomeById" UUID,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaFacebookPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaFacebookPost_contentId_status_idx" ON "MediaFacebookPost"("contentId", "status");

-- CreateIndex
CREATE INDEX "MediaFacebookPost_status_createdAt_idx" ON "MediaFacebookPost"("status", "createdAt");

-- CreateTable
CREATE TABLE "HelpArticleState" (
    "id" UUID NOT NULL,
    "entryId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "updatedById" UUID,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HelpArticleState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HelpArticleState_entryId_key" ON "HelpArticleState"("entryId");

-- CreateIndex
CREATE INDEX "HelpArticleState_status_idx" ON "HelpArticleState"("status");

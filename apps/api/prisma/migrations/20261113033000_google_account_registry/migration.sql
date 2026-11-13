-- Multi-account Google manager registry (2026-11-13): the Service OS
-- record of which Gmail accounts run the Top Speed Google presence
-- (Business Profile, Local Services Ads, Google Ads, Search Console),
-- the role each holds, its lifecycle status, and its linked assets.
-- A registry only — invites happen in Google's own screens; statuses
-- are updated by a human and never auto-flip.
CREATE TABLE "GoogleAccountLink" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MANAGER',
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "assets" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAccountLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleAccountLink_email_key" ON "GoogleAccountLink"("email");

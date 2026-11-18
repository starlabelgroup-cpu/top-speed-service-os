-- Service OS Insights (2026-11-17): PageSpeed Insights snapshots for the
-- portfolio homepages. Additive only — one brand-new table; no existing
-- record changes meaning. Rows are written by the staff-triggered
-- refresh (POST /insights/pagespeed/refresh); failed fetches are stored
-- as status ERROR rows with the failure text, never a fabricated score.

-- CreateTable
CREATE TABLE "InsightsPageSpeedSnapshot" (
    "id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'mobile',
    "status" TEXT NOT NULL DEFAULT 'OK',
    "score" DOUBLE PRECISION,
    "lcpMs" DOUBLE PRECISION,
    "cls" DOUBLE PRECISION,
    "inpMs" DOUBLE PRECISION,
    "error" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsightsPageSpeedSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InsightsPageSpeedSnapshot_url_fetchedAt_idx" ON "InsightsPageSpeedSnapshot"("url", "fetchedAt");

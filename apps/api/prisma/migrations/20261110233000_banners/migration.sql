-- Advertiser banner system: direct-sold creatives with impression/click counters.
CREATE TABLE "Banner" (
    "id" UUID NOT NULL,
    "placement" TEXT NOT NULL DEFAULT 'FOOTER',
    "advertiserName" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "copy" TEXT,
    "imageUrl" TEXT,
    "ctaText" TEXT,
    "ctaUrl" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Banner_pkey" PRIMARY KEY ("id")
);

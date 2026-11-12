-- Top Speed Marketing OS — Phase 1 Foundation (blueprint §3/§4/§7/§12):
-- taxonomy (cities, brands, services, symptoms), landing pages with the
-- §4 canonical URL scheme, and a version snapshot per content save.

-- CreateEnum
CREATE TYPE "LandingPageType" AS ENUM ('CITY', 'BRAND', 'SERVICE', 'BRAND_SERVICE', 'BRAND_SERVICE_CITY');

-- CreateEnum
CREATE TYPE "LandingPageStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'UNPUBLISHED');

-- CreateTable
CREATE TABLE "MarketingCity" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'FL',
    "serviceCovered" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingBrand" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingBrand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingService" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "partOfService" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingSymptom" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingSymptom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandingPage" (
    "id" UUID NOT NULL,
    "type" "LandingPageType" NOT NULL,
    "cityId" UUID,
    "brandId" UUID,
    "serviceId" UUID,
    "slug" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "metaDescription" TEXT,
    "status" "LandingPageStatus" NOT NULL DEFAULT 'DRAFT',
    "sections" JSONB NOT NULL DEFAULT '[]',
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LandingPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageVersion" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCity_name_key" ON "MarketingCity"("name");
CREATE UNIQUE INDEX "MarketingCity_slug_key" ON "MarketingCity"("slug");
CREATE UNIQUE INDEX "MarketingBrand_name_key" ON "MarketingBrand"("name");
CREATE UNIQUE INDEX "MarketingBrand_slug_key" ON "MarketingBrand"("slug");
CREATE UNIQUE INDEX "MarketingService_name_key" ON "MarketingService"("name");
CREATE UNIQUE INDEX "MarketingService_slug_key" ON "MarketingService"("slug");
CREATE UNIQUE INDEX "MarketingSymptom_name_key" ON "MarketingSymptom"("name");
CREATE UNIQUE INDEX "MarketingSymptom_slug_key" ON "MarketingSymptom"("slug");
CREATE UNIQUE INDEX "LandingPage_canonicalUrl_key" ON "LandingPage"("canonicalUrl");
CREATE INDEX "LandingPage_status_type_idx" ON "LandingPage"("status", "type");
CREATE INDEX "LandingPage_cityId_idx" ON "LandingPage"("cityId");
CREATE INDEX "LandingPage_brandId_idx" ON "LandingPage"("brandId");
CREATE INDEX "LandingPage_serviceId_idx" ON "LandingPage"("serviceId");
CREATE UNIQUE INDEX "PageVersion_pageId_version_key" ON "PageVersion"("pageId", "version");
CREATE INDEX "PageVersion_pageId_idx" ON "PageVersion"("pageId");

-- AddForeignKey
ALTER TABLE "LandingPage" ADD CONSTRAINT "LandingPage_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "MarketingCity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LandingPage" ADD CONSTRAINT "LandingPage_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "MarketingBrand"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LandingPage" ADD CONSTRAINT "LandingPage_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "MarketingService"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PageVersion" ADD CONSTRAINT "PageVersion_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "LandingPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

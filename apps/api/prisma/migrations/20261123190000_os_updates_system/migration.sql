-- OS Systems Updating System (2026-11-23): the platform / tech-pack
-- registry and the 6-month update-cycle engine. Additive only —
-- five new tables and four enums; nothing existing is altered.
-- Hand-written in the generated style (the campaign_engine /
-- sales_os precedent). The registry is seeded by the deploy-time
-- seed (Phase 6); cycles prepare and track updates — nothing here
-- applies an update by itself.

-- CreateEnum
CREATE TYPE "OsPlatformKind" AS ENUM ('CONSOLE', 'CUSTOMER_APP', 'WEBSITE', 'SATELLITE_SITE', 'MOBILE_APP', 'SERVICE');

-- CreateEnum
CREATE TYPE "TechPackEcosystem" AS ENUM ('NPM', 'RUNTIME', 'PLATFORM', 'SDK');

-- CreateEnum
CREATE TYPE "UpdateCycleStatus" AS ENUM ('OPEN', 'COMPLETED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "UpdateTaskStatus" AS ENUM ('PENDING', 'PLANNED', 'APPLIED', 'VERIFIED', 'SKIPPED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "DivisionRole" AS ENUM ('MAIN', 'SERVICE', 'RETAIL', 'FUTURE');

-- CreateTable
CREATE TABLE "Division" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "DivisionRole" NOT NULL,
    "parentKey" TEXT,
    "description" TEXT,
    "homeUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Division_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OsPlatform" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "OsPlatformKind" NOT NULL,
    "divisionKey" TEXT NOT NULL DEFAULT 'TOP_SPEED_OS',
    "surface" TEXT,
    "ownerNote" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OsPlatform_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechPack" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ecosystem" "TechPackEcosystem" NOT NULL,
    "registryUrl" TEXT,
    "currentLatestVersion" TEXT,
    "latestCheckedAt" TIMESTAMP(3),
    "latestNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformTechPack" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "techPackId" UUID NOT NULL,
    "installedVersion" TEXT NOT NULL,
    "sourceNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformTechPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdateCycle" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "UpdateCycleStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpdateCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdateTask" (
    "id" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "techPackId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "drift" TEXT NOT NULL,
    "fromVersion" TEXT,
    "toVersion" TEXT,
    "status" "UpdateTaskStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "appliedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpdateTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Division_key_key" ON "Division"("key");

-- CreateIndex
CREATE UNIQUE INDEX "OsPlatform_key_key" ON "OsPlatform"("key");

-- CreateIndex
CREATE INDEX "OsPlatform_kind_idx" ON "OsPlatform"("kind");

-- CreateIndex
CREATE INDEX "OsPlatform_divisionKey_idx" ON "OsPlatform"("divisionKey");

-- CreateIndex
CREATE UNIQUE INDEX "TechPack_key_key" ON "TechPack"("key");

-- CreateIndex
CREATE INDEX "TechPack_ecosystem_idx" ON "TechPack"("ecosystem");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformTechPack_platformId_techPackId_key" ON "PlatformTechPack"("platformId", "techPackId");

-- CreateIndex
CREATE INDEX "PlatformTechPack_techPackId_idx" ON "PlatformTechPack"("techPackId");

-- CreateIndex
CREATE UNIQUE INDEX "UpdateCycle_key_key" ON "UpdateCycle"("key");

-- CreateIndex
CREATE INDEX "UpdateCycle_status_openedAt_idx" ON "UpdateCycle"("status", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UpdateTask_cycleId_platformId_techPackId_key" ON "UpdateTask"("cycleId", "platformId", "techPackId");

-- CreateIndex
CREATE INDEX "UpdateTask_cycleId_status_idx" ON "UpdateTask"("cycleId", "status");

-- CreateIndex
CREATE INDEX "UpdateTask_platformId_idx" ON "UpdateTask"("platformId");

-- AddForeignKey
ALTER TABLE "PlatformTechPack" ADD CONSTRAINT "PlatformTechPack_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "OsPlatform"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformTechPack" ADD CONSTRAINT "PlatformTechPack_techPackId_fkey" FOREIGN KEY ("techPackId") REFERENCES "TechPack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdateTask" ADD CONSTRAINT "UpdateTask_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "UpdateCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdateTask" ADD CONSTRAINT "UpdateTask_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "OsPlatform"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdateTask" ADD CONSTRAINT "UpdateTask_techPackId_fkey" FOREIGN KEY ("techPackId") REFERENCES "TechPack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

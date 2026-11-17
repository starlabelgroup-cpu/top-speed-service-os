-- Flywheel Advertiser Plans (2026-11-17): the paid-plan layer of the
-- Flywheel AI Advertising ecosystem. Additive only — three brand-new
-- tables and one enum type; no existing record changes meaning.
-- Plans seed as STRUCTURE with monthlyPriceCents NULL (services/
-- adPlans.js PLAN_TIERS, seeded lazily by db/adPlansRepo.js): prices
-- are owner-configured in Ad Studio, and a Stripe Product/Price is
-- created only when the owner sets a price. Existing advertiser
-- accounts are grandfathered in services/adPlans.js — this migration
-- touches no account.

-- CreateEnum
CREATE TYPE "AdSubscriptionStatus" AS ENUM ('NONE', 'GRANDFATHERED', 'ACTIVE', 'TRIALING', 'PAST_DUE', 'GRACE', 'SUSPENDED', 'OFFICE_GRANTED');

-- CreateTable
CREATE TABLE "AdPlan" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "monthlyPriceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "features" JSONB NOT NULL DEFAULT '{}',
    "limits" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "stripeProductId" TEXT,
    "stripePriceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvertiserSubscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "planId" UUID,
    "status" "AdSubscriptionStatus" NOT NULL DEFAULT 'NONE',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "pastDueAt" TIMESTAMP(3),
    "pendingPlanId" UUID,
    "pendingEffectiveAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" UUID,
    "grantedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvertiserSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdBillingSetting" (
    "id" TEXT NOT NULL,
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdBillingSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdPlan_key_key" ON "AdPlan"("key");

-- CreateIndex
CREATE INDEX "AdPlan_isActive_sortOrder_idx" ON "AdPlan"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AdvertiserSubscription_userId_key" ON "AdvertiserSubscription"("userId");

-- CreateIndex
CREATE INDEX "AdvertiserSubscription_status_idx" ON "AdvertiserSubscription"("status");

-- CreateIndex
CREATE INDEX "AdvertiserSubscription_stripeSubscriptionId_idx" ON "AdvertiserSubscription"("stripeSubscriptionId");

-- AddForeignKey
ALTER TABLE "AdvertiserSubscription" ADD CONSTRAINT "AdvertiserSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvertiserSubscription" ADD CONSTRAINT "AdvertiserSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AdPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Appliance Care Plan (membership) — B4 (2026-11-20, Ramone approved
-- the recommendations program). Additive only — three brand-new
-- tables and one enum type; no existing record changes meaning.
-- The plan seeds as STRUCTURE with annualPriceCents NULL (services/
-- carePlans.js CARE_PLAN_TIERS, seeded lazily by db/carePlansRepo.js):
-- the price is owner-configured in the admin surface, and a Stripe
-- Product/Price is created only when the owner sets a price. This
-- migration touches no account.

-- CreateEnum
CREATE TYPE "CareSubscriptionStatus" AS ENUM ('NONE', 'ACTIVE', 'TRIALING', 'PAST_DUE', 'GRACE', 'SUSPENDED', 'OFFICE_GRANTED');

-- CreateTable
CREATE TABLE "CarePlan" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "annualPriceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "features" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "stripeProductId" TEXT,
    "stripePriceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareSubscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "planId" UUID,
    "status" "CareSubscriptionStatus" NOT NULL DEFAULT 'NONE',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "pastDueAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "checkupBookedForPeriodEnd" TIMESTAMP(3),
    "checkupBookingRef" TEXT,
    "grantedById" UUID,
    "grantedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareBillingSetting" (
    "id" TEXT NOT NULL,
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareBillingSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CarePlan_key_key" ON "CarePlan"("key");

-- CreateIndex
CREATE INDEX "CarePlan_isActive_sortOrder_idx" ON "CarePlan"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "CareSubscription_userId_key" ON "CareSubscription"("userId");

-- CreateIndex
CREATE INDEX "CareSubscription_status_idx" ON "CareSubscription"("status");

-- CreateIndex
CREATE INDEX "CareSubscription_stripeSubscriptionId_idx" ON "CareSubscription"("stripeSubscriptionId");

-- AddForeignKey
ALTER TABLE "CareSubscription" ADD CONSTRAINT "CareSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareSubscription" ADD CONSTRAINT "CareSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CarePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

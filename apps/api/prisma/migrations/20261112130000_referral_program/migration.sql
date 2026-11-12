-- ApplianceReferral rewards program (2026-11-12, Phase 1): referral
-- journeys (one referred friend's lifecycle), reward credits (the
-- ledger), and per-company program settings with typed amount columns.
-- Reward amounts are NULL by default — unset means no figure exists
-- anywhere until the owner configures one. Existing bookings/customers
-- gain the referral attribution columns so linkage survives rehydration.

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN "clickCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN "referralCode" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN "referredByCustomerId" UUID;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "referredByCode" TEXT;

-- CreateTable
CREATE TABLE "ReferralJourney" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "referralId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "referrerCustomerId" UUID,
    "refereeName" TEXT,
    "refereePhone" TEXT,
    "refereeEmail" TEXT,
    "bookingId" UUID,
    "bookingReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "rewardAmountCents" INTEGER,
    "tierSnapshot" TEXT,
    "staffDecisionBy" TEXT,
    "staffDecisionAt" TIMESTAMP(3),
    "staffNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralJourney_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCredit" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "journeyId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "issuedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "redeemedBookingId" UUID,
    "redeemedReference" TEXT,
    "redeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralProgramSetting" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rewardAmountCents" INTEGER,
    "tier2Threshold" INTEGER,
    "tier2AmountCents" INTEGER,
    "tier3Threshold" INTEGER,
    "tier3AmountCents" INTEGER,
    "milestoneBonuses" JSONB,
    "monthlyCapPerReferrer" INTEGER,
    "rewardExpiryDays" INTEGER,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralProgramSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralJourney_companyId_code_idx" ON "ReferralJourney"("companyId", "code");

-- CreateIndex
CREATE INDEX "ReferralJourney_companyId_status_idx" ON "ReferralJourney"("companyId", "status");

-- CreateIndex
CREATE INDEX "ReferralJourney_companyId_refereePhone_idx" ON "ReferralJourney"("companyId", "refereePhone");

-- CreateIndex
CREATE INDEX "ReferralCredit_companyId_customerId_idx" ON "ReferralCredit"("companyId", "customerId");

-- CreateIndex
CREATE INDEX "ReferralCredit_companyId_status_idx" ON "ReferralCredit"("companyId", "status");

-- CreateIndex
CREATE INDEX "ReferralCredit_journeyId_idx" ON "ReferralCredit"("journeyId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralProgramSetting_companyId_key" ON "ReferralProgramSetting"("companyId");

-- AddForeignKey
ALTER TABLE "ReferralJourney" ADD CONSTRAINT "ReferralJourney_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralJourney" ADD CONSTRAINT "ReferralJourney_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCredit" ADD CONSTRAINT "ReferralCredit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCredit" ADD CONSTRAINT "ReferralCredit_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "ReferralJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralProgramSetting" ADD CONSTRAINT "ReferralProgramSetting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

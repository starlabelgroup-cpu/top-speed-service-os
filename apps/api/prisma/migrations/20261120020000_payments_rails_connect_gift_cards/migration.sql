-- New money rails (2026-11-20, Wave 4): Pepper Lists protected
-- payments (Stripe Connect) + flagship gift cards. Additive only:
-- five brand-new tables; no existing record changes meaning.
-- Everything ships behind owner configuration (PaymentsSetting):
-- Connect defaults OFF (activation on the live Stripe account is
-- the owner's own dashboard step), the Connect fee starts NULL and
-- gift card denominations start empty — with no owner-set numbers,
-- no money can move (the advertiser-plans pricing_not_set rule).

-- CreateTable
CREATE TABLE "PaymentsSetting" (
    "id" TEXT NOT NULL,
    "connectEnabled" BOOLEAN NOT NULL DEFAULT false,
    "connectFeeBps" INTEGER,
    "giftCardDenominationsCents" JSONB NOT NULL DEFAULT '[]',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentsSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerConnectAccount" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stripeAccountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerConnectAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerConnectAccount_userId_key" ON "SellerConnectAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerConnectAccount_stripeAccountId_key" ON "SellerConnectAccount"("stripeAccountId");

-- CreateIndex
CREATE INDEX "SellerConnectAccount_companyId_status_idx" ON "SellerConnectAccount"("companyId", "status");

-- CreateTable
CREATE TABLE "PepperListsOrder" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "listingConnectionId" UUID NOT NULL,
    "listingReference" TEXT NOT NULL,
    "sellerUserId" UUID NOT NULL,
    "buyerUserId" UUID,
    "buyerEmail" TEXT,
    "amountCents" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "stripeSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "checkoutUrl" TEXT,
    "sellerStripeAccountId" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PepperListsOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PepperListsOrder_stripeSessionId_key" ON "PepperListsOrder"("stripeSessionId");

-- CreateIndex
CREATE INDEX "PepperListsOrder_sellerUserId_createdAt_idx" ON "PepperListsOrder"("sellerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsOrder_buyerUserId_createdAt_idx" ON "PepperListsOrder"("buyerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsOrder_listingConnectionId_status_idx" ON "PepperListsOrder"("listingConnectionId", "status");

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeLast4" TEXT NOT NULL,
    "initialAmountCents" INTEGER NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "purchaserUserId" UUID,
    "purchaserEmail" TEXT,
    "recipientEmail" TEXT,
    "stripeSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "checkoutUrl" TEXT,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_codeHash_key" ON "GiftCard"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_stripeSessionId_key" ON "GiftCard"("stripeSessionId");

-- CreateIndex
CREATE INDEX "GiftCard_companyId_status_idx" ON "GiftCard"("companyId", "status");

-- CreateIndex
CREATE INDEX "GiftCard_purchaserUserId_createdAt_idx" ON "GiftCard"("purchaserUserId", "createdAt");

-- CreateTable
CREATE TABLE "GiftCardLedgerEntry" (
    "id" UUID NOT NULL,
    "giftCardId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "bookingId" UUID,
    "paymentId" UUID,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftCardLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GiftCardLedgerEntry_giftCardId_createdAt_idx" ON "GiftCardLedgerEntry"("giftCardId", "createdAt");

-- CreateIndex
CREATE INDEX "GiftCardLedgerEntry_bookingId_idx" ON "GiftCardLedgerEntry"("bookingId");

-- AddForeignKey
ALTER TABLE "GiftCardLedgerEntry" ADD CONSTRAINT "GiftCardLedgerEntry_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

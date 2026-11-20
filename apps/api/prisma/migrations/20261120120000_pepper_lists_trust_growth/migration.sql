-- CreateTable
CREATE TABLE "ListingProfile" (
    "id" UUID NOT NULL,
    "connectionId" TEXT NOT NULL,
    "sellerUserId" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "bumpedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "soldAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingComment" (
    "id" UUID NOT NULL,
    "listingId" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "authorKind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingReport" (
    "id" UUID NOT NULL,
    "listingId" TEXT NOT NULL,
    "reporterId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerSale" (
    "id" UUID NOT NULL,
    "listingId" TEXT NOT NULL,
    "sellerId" UUID NOT NULL,
    "buyerId" UUID,
    "buyerEmail" TEXT,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerReview" (
    "id" UUID NOT NULL,
    "saleId" TEXT NOT NULL,
    "sellerId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingBump" (
    "id" UUID NOT NULL,
    "listingId" TEXT NOT NULL,
    "sellerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingBump_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerPlan" (
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

    CONSTRAINT "SellerPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerSubscription" (
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

    CONSTRAINT "SellerSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ListingProfile_connectionId_key" ON "ListingProfile"("connectionId");

-- CreateIndex
CREATE INDEX "ListingProfile_sellerUserId_status_idx" ON "ListingProfile"("sellerUserId", "status");

-- CreateIndex
CREATE INDEX "ListingProfile_featured_bumpedAt_idx" ON "ListingProfile"("featured", "bumpedAt");

-- CreateIndex
CREATE INDEX "ListingComment_listingId_createdAt_idx" ON "ListingComment"("listingId", "createdAt");

-- CreateIndex
CREATE INDEX "ListingComment_authorId_createdAt_idx" ON "ListingComment"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "ListingReport_status_createdAt_idx" ON "ListingReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ListingReport_listingId_idx" ON "ListingReport"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerSale_listingId_key" ON "SellerSale"("listingId");

-- CreateIndex
CREATE INDEX "SellerSale_sellerId_completedAt_idx" ON "SellerSale"("sellerId", "completedAt");

-- CreateIndex
CREATE INDEX "SellerSale_buyerId_completedAt_idx" ON "SellerSale"("buyerId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SellerReview_saleId_key" ON "SellerReview"("saleId");

-- CreateIndex
CREATE INDEX "SellerReview_sellerId_status_createdAt_idx" ON "SellerReview"("sellerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SellerReview_buyerId_createdAt_idx" ON "SellerReview"("buyerId", "createdAt");

-- CreateIndex
CREATE INDEX "ListingBump_sellerId_createdAt_idx" ON "ListingBump"("sellerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPlan_key_key" ON "SellerPlan"("key");

-- CreateIndex
CREATE INDEX "SellerPlan_isActive_sortOrder_idx" ON "SellerPlan"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SellerSubscription_userId_key" ON "SellerSubscription"("userId");

-- CreateIndex
CREATE INDEX "SellerSubscription_status_idx" ON "SellerSubscription"("status");

-- CreateIndex
CREATE INDEX "SellerSubscription_stripeSubscriptionId_idx" ON "SellerSubscription"("stripeSubscriptionId");

-- AddForeignKey
ALTER TABLE "SellerSubscription" ADD CONSTRAINT "SellerSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerSubscription" ADD CONSTRAINT "SellerSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SellerPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "AdSubscriptionStatus" AS ENUM ('NONE', 'GRANDFATHERED', 'ACTIVE', 'TRIALING', 'PAST_DUE', 'GRACE', 'SUSPENDED', 'OFFICE_GRANTED');

-- CreateEnum
CREATE TYPE "SellerChannel" AS ENUM ('FACEBOOK', 'GOOGLE_SHOPPING', 'EBAY', 'ETSY', 'WALMART', 'TIKTOK', 'YOUTUBE', 'INSTAGRAM', 'X', 'LINKEDIN', 'GOOGLE_BUSINESS', 'BING_PLACES', 'SEARCH_DIRECTORIES');

-- CreateEnum
CREATE TYPE "SellerChannelKind" AS ENUM ('SELL', 'POST');

-- CreateEnum
CREATE TYPE "SellerChannelStatus" AS ENUM ('NOT_CONNECTED', 'PENDING', 'IN_PROGRESS', 'ACTIVE', 'DECLINED', 'CONNECTED', 'ERROR', 'REVOKED');

-- CreateEnum
CREATE TYPE "PepperListsCrossPostTarget" AS ENUM ('MARKETPLACE', 'PAGE');

-- CreateEnum
CREATE TYPE "PepperListsCrossPostStatus" AS ENUM ('QUEUED', 'POSTED', 'FAILED');

-- CreateEnum
CREATE TYPE "PepperListsSyndicationChannel" AS ENUM ('EBAY', 'GOOGLE_SHOPPING');

-- CreateEnum
CREATE TYPE "PepperListsSyndicationStatus" AS ENUM ('QUEUED', 'POSTED', 'FAILED');

-- CreateEnum
CREATE TYPE "PepperListsThreadStatus" AS ENUM ('OPEN', 'REPORTED', 'CLOSED');

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
CREATE TABLE "SavedListing" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "listingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedListing_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "SellerChannelConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "SellerChannel" NOT NULL,
    "kind" "SellerChannelKind" NOT NULL,
    "status" "SellerChannelStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "externalAccountLabel" TEXT,
    "agentAccessGranted" BOOLEAN NOT NULL DEFAULT false,
    "connectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerChannelAudit" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerChannelAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PepperListsCrossPost" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "listingReference" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "target" "PepperListsCrossPostTarget" NOT NULL,
    "pageId" TEXT,
    "status" "PepperListsCrossPostStatus" NOT NULL DEFAULT 'QUEUED',
    "externalId" TEXT,
    "externalUrl" TEXT,
    "error" TEXT,
    "outcomeById" UUID,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PepperListsCrossPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PepperListsSyndication" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "listingReference" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "PepperListsSyndicationChannel" NOT NULL,
    "status" "PepperListsSyndicationStatus" NOT NULL DEFAULT 'QUEUED',
    "externalId" TEXT,
    "externalUrl" TEXT,
    "error" TEXT,
    "outcomeById" UUID,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PepperListsSyndication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PepperListsThread" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "listingReference" TEXT NOT NULL,
    "sellerUserId" UUID NOT NULL,
    "buyerUserId" UUID NOT NULL,
    "status" "PepperListsThreadStatus" NOT NULL DEFAULT 'OPEN',
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PepperListsThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PepperListsMessage" (
    "id" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "senderUserId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PepperListsMessage_pkey" PRIMARY KEY ("id")
);

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
CREATE INDEX "SavedListing_userId_createdAt_idx" ON "SavedListing"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SavedListing_userId_listingId_key" ON "SavedListing"("userId", "listingId");

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

-- CreateIndex
CREATE INDEX "SellerChannelConnection_status_idx" ON "SellerChannelConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SellerChannelConnection_userId_channel_key" ON "SellerChannelConnection"("userId", "channel");

-- CreateIndex
CREATE INDEX "SellerChannelAudit_connectionId_createdAt_idx" ON "SellerChannelAudit"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "SellerChannelAudit_userId_createdAt_idx" ON "SellerChannelAudit"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsCrossPost_connectionId_target_status_idx" ON "PepperListsCrossPost"("connectionId", "target", "status");

-- CreateIndex
CREATE INDEX "PepperListsCrossPost_status_createdAt_idx" ON "PepperListsCrossPost"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsCrossPost_userId_createdAt_idx" ON "PepperListsCrossPost"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsSyndication_connectionId_channel_status_idx" ON "PepperListsSyndication"("connectionId", "channel", "status");

-- CreateIndex
CREATE INDEX "PepperListsSyndication_status_createdAt_idx" ON "PepperListsSyndication"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsSyndication_userId_createdAt_idx" ON "PepperListsSyndication"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsThread_sellerUserId_lastMessageAt_idx" ON "PepperListsThread"("sellerUserId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "PepperListsThread_buyerUserId_lastMessageAt_idx" ON "PepperListsThread"("buyerUserId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "PepperListsThread_status_updatedAt_idx" ON "PepperListsThread"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PepperListsThread_connectionId_buyerUserId_key" ON "PepperListsThread"("connectionId", "buyerUserId");

-- CreateIndex
CREATE INDEX "PepperListsMessage_threadId_createdAt_idx" ON "PepperListsMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsMessage_threadId_readAt_idx" ON "PepperListsMessage"("threadId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "PepperListsOrder_stripeSessionId_key" ON "PepperListsOrder"("stripeSessionId");

-- CreateIndex
CREATE INDEX "PepperListsOrder_sellerUserId_createdAt_idx" ON "PepperListsOrder"("sellerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsOrder_buyerUserId_createdAt_idx" ON "PepperListsOrder"("buyerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "PepperListsOrder_listingConnectionId_status_idx" ON "PepperListsOrder"("listingConnectionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SellerConnectAccount_userId_key" ON "SellerConnectAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerConnectAccount_stripeAccountId_key" ON "SellerConnectAccount"("stripeAccountId");

-- CreateIndex
CREATE INDEX "SellerConnectAccount_companyId_status_idx" ON "SellerConnectAccount"("companyId", "status");

-- AddForeignKey
ALTER TABLE "SellerSubscription" ADD CONSTRAINT "SellerSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SellerPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerChannelAudit" ADD CONSTRAINT "SellerChannelAudit_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SellerChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

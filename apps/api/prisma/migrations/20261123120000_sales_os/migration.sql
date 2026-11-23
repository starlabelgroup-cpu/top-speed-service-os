-- Top Speed Sales OS (2026-11-23): the sales platform's catalog +
-- orders. Additive only — four new tables and their enums; nothing
-- existing is altered. Hand-written in the generated style (the
-- facebook_os_manager precedent). No data is seeded: the catalog
-- launches empty and the single SalesVendor row is resolved lazily
-- by the service layer.

-- CreateEnum
CREATE TYPE "SalesProductCategory" AS ENUM ('REFRIGERATOR', 'WASHER', 'DRYER', 'OVEN_RANGE', 'DISHWASHER', 'FREEZER_ICE_MAKER', 'MICROWAVE', 'GARBAGE_DISPOSAL', 'OTHER');

-- CreateEnum
CREATE TYPE "SalesConditionGrade" AS ENUM ('LIKE_NEW', 'EXCELLENT', 'GOOD', 'FAIR');

-- CreateEnum
CREATE TYPE "SalesProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SOLD', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SalesFulfillment" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "SalesPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'FULFILLING', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "SalesVendor" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesVendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesProduct" (
    "id" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" "SalesProductCategory" NOT NULL,
    "brand" TEXT,
    "modelRef" TEXT,
    "conditionGrade" "SalesConditionGrade" NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "compareAtCents" INTEGER,
    "stockQty" INTEGER NOT NULL DEFAULT 0,
    "status" "SalesProductStatus" NOT NULL DEFAULT 'DRAFT',
    "photos" JSONB NOT NULL DEFAULT '[]',
    "serialRef" TEXT,
    "warrantyDays" INTEGER NOT NULL DEFAULT 0,
    "deliveryAvailable" BOOLEAN NOT NULL DEFAULT false,
    "pickupAvailable" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" UUID NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "vendorId" UUID,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "subtotalCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "fulfillment" "SalesFulfillment" NOT NULL DEFAULT 'PICKUP',
    "paymentStatus" "SalesPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "stripeRef" TEXT,
    "checkoutUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderItem" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SalesOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesVendor_slug_key" ON "SalesVendor"("slug");

-- CreateIndex
CREATE INDEX "SalesProduct_status_category_idx" ON "SalesProduct"("status", "category");

-- CreateIndex
CREATE INDEX "SalesProduct_vendorId_status_idx" ON "SalesProduct"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_orderNumber_key" ON "SalesOrder"("orderNumber");

-- CreateIndex
CREATE INDEX "SalesOrder_status_createdAt_idx" ON "SalesOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SalesOrder_paymentStatus_createdAt_idx" ON "SalesOrder"("paymentStatus", "createdAt");

-- CreateIndex
CREATE INDEX "SalesOrderItem_orderId_idx" ON "SalesOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "SalesOrderItem_productId_idx" ON "SalesOrderItem"("productId");

-- AddForeignKey
ALTER TABLE "SalesProduct" ADD CONSTRAINT "SalesProduct_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "SalesVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "SalesVendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderItem" ADD CONSTRAINT "SalesOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderItem" ADD CONSTRAINT "SalesOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "SalesProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "CocoCaneLocationKind" AS ENUM ('WAREHOUSE', 'SHOP', 'VEHICLE', 'OTHER');

-- CreateEnum
CREATE TYPE "CocoCaneOrderChannel" AS ENUM ('RETAIL', 'WHOLESALE');

-- CreateEnum
CREATE TYPE "CocoCaneOrderMethod" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "CocoCaneOrderStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'READY', 'FULFILLED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CocoCaneMovementType" AS ENUM ('ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'RESERVE', 'RELEASE', 'CONSUME');

-- CreateTable
CREATE TABLE "CocoCaneProduct" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "priceCents" INTEGER,
    "priceLowCents" INTEGER,
    "priceHighCents" INTEGER,
    "lowStockAt" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CocoCaneProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CocoCaneLocation" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "CocoCaneLocationKind" NOT NULL DEFAULT 'OTHER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CocoCaneLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CocoCaneStock" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CocoCaneStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CocoCaneStockMovement" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "type" "CocoCaneMovementType" NOT NULL,
    "onHandDelta" INTEGER NOT NULL DEFAULT 0,
    "reservedDelta" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "orderId" UUID,
    "transferGroup" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CocoCaneStockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CocoCaneOrder" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "channel" "CocoCaneOrderChannel" NOT NULL DEFAULT 'RETAIL',
    "method" "CocoCaneOrderMethod" NOT NULL DEFAULT 'PICKUP',
    "status" "CocoCaneOrderStatus" NOT NULL DEFAULT 'REQUESTED',
    "customerName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "connectionId" UUID,
    "fulfillmentLocationId" UUID,
    "stockReserved" BOOLEAN NOT NULL DEFAULT false,
    "pickupDay" TEXT,
    "pickupTime" TEXT,
    "deliveryAddress" TEXT,
    "notes" TEXT,
    "totalLowCents" INTEGER NOT NULL DEFAULT 0,
    "totalHighCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CocoCaneOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CocoCaneOrderLine" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER,
    "unitPriceLowCents" INTEGER,
    "unitPriceHighCents" INTEGER,

    CONSTRAINT "CocoCaneOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CocoCaneProduct_sku_key" ON "CocoCaneProduct"("sku");

-- CreateIndex
CREATE INDEX "CocoCaneProduct_active_sortOrder_idx" ON "CocoCaneProduct"("active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "CocoCaneLocation_code_key" ON "CocoCaneLocation"("code");

-- CreateIndex
CREATE INDEX "CocoCaneLocation_active_idx" ON "CocoCaneLocation"("active");

-- CreateIndex
CREATE INDEX "CocoCaneStock_locationId_idx" ON "CocoCaneStock"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "CocoCaneStock_productId_locationId_key" ON "CocoCaneStock"("productId", "locationId");

-- CreateIndex
CREATE INDEX "CocoCaneStockMovement_productId_locationId_createdAt_idx" ON "CocoCaneStockMovement"("productId", "locationId", "createdAt");

-- CreateIndex
CREATE INDEX "CocoCaneStockMovement_orderId_idx" ON "CocoCaneStockMovement"("orderId");

-- CreateIndex
CREATE INDEX "CocoCaneStockMovement_transferGroup_idx" ON "CocoCaneStockMovement"("transferGroup");

-- CreateIndex
CREATE UNIQUE INDEX "CocoCaneOrder_reference_key" ON "CocoCaneOrder"("reference");

-- CreateIndex
CREATE INDEX "CocoCaneOrder_status_createdAt_idx" ON "CocoCaneOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CocoCaneOrder_channel_createdAt_idx" ON "CocoCaneOrder"("channel", "createdAt");

-- CreateIndex
CREATE INDEX "CocoCaneOrderLine_orderId_idx" ON "CocoCaneOrderLine"("orderId");

-- AddForeignKey
ALTER TABLE "CocoCaneStock" ADD CONSTRAINT "CocoCaneStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CocoCaneProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CocoCaneStock" ADD CONSTRAINT "CocoCaneStock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "CocoCaneLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CocoCaneStockMovement" ADD CONSTRAINT "CocoCaneStockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CocoCaneProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CocoCaneStockMovement" ADD CONSTRAINT "CocoCaneStockMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "CocoCaneLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CocoCaneStockMovement" ADD CONSTRAINT "CocoCaneStockMovement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CocoCaneOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CocoCaneOrder" ADD CONSTRAINT "CocoCaneOrder_fulfillmentLocationId_fkey" FOREIGN KEY ("fulfillmentLocationId") REFERENCES "CocoCaneLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CocoCaneOrderLine" ADD CONSTRAINT "CocoCaneOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CocoCaneOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CocoCaneOrderLine" ADD CONSTRAINT "CocoCaneOrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CocoCaneProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


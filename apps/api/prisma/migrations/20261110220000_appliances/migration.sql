-- Appliance Connect: the customer's registered appliances (their garage).
CREATE TABLE "CustomerAppliance" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "serial" TEXT,
    "year" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerAppliance_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CustomerAppliance_userId_idx" ON "CustomerAppliance"("userId");

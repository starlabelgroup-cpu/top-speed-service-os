-- Tech Pro van stock (2026-11-17): per-provider on-van part quantities
-- for the Tech App's parts module (Top Speed Tech Pro field guide).
-- Additive only — one new table, nothing existing is touched.

-- CreateTable
CREATE TABLE "VanStock" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "partId" UUID NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VanStock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VanStock_providerId_idx" ON "VanStock"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "VanStock_providerId_partId_key" ON "VanStock"("providerId", "partId");

-- AddForeignKey
ALTER TABLE "VanStock" ADD CONSTRAINT "VanStock_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VanStock" ADD CONSTRAINT "VanStock_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

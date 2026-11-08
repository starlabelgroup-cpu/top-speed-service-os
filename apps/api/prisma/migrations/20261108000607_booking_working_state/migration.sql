-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "source" TEXT,
ADD COLUMN     "userId" UUID;

-- AlterTable
ALTER TABLE "DispatchAssignment" ADD COLUMN     "approvedByName" TEXT,
ADD COLUMN     "providerCompanyId" UUID,
ALTER COLUMN "approvedById" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "appointment" JSONB,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedBy" TEXT,
ADD COLUMN     "dispatch" JSONB,
ADD COLUMN     "history" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "referenceCode" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'WEBSITE';

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequest_referenceCode_key" ON "ServiceRequest"("referenceCode");


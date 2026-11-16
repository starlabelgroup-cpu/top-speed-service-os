-- AlterTable
ALTER TABLE "User" ADD COLUMN     "verifyRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SpeedyVerifyCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "issuedById" UUID,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpeedyVerifyCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpeedyVerifyCode_userId_key" ON "SpeedyVerifyCode"("userId");

-- CreateIndex
CREATE INDEX "SpeedyVerifyCode_status_idx" ON "SpeedyVerifyCode"("status");

-- AddForeignKey
ALTER TABLE "SpeedyVerifyCode" ADD CONSTRAINT "SpeedyVerifyCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

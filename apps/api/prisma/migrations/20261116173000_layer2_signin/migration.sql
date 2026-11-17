-- AlterTable
ALTER TABLE "User" ADD COLUMN     "layer2Required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "layer2Phone" TEXT,
ADD COLUMN     "layer2Channel" TEXT;

-- CreateTable
CREATE TABLE "LoginChallenge" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" TEXT,
    "codeHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sends" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginChallenge_userId_status_idx" ON "LoginChallenge"("userId", "status");

-- AddForeignKey
ALTER TABLE "LoginChallenge" ADD CONSTRAINT "LoginChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

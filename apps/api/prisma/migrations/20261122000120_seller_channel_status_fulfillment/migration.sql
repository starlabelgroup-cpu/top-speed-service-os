-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SellerChannelStatus" ADD VALUE 'IN_PROGRESS';
ALTER TYPE "SellerChannelStatus" ADD VALUE 'ACTIVE';
ALTER TYPE "SellerChannelStatus" ADD VALUE 'DECLINED';

-- NOTE (hand-trimmed): prisma migrate dev also proposed dropping the
-- pre-existing CustomerAppliance_userId_idx drift index. Removed —
-- that drift is a separate owner decision and is deliberately NOT
-- touched here, same as prior builds.

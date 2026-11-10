-- Marketing platform (2026-11-10): advertiser / manager / developer roles
-- plus the ChannelLink connect-system table.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ADVERTISER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MARKETING_MANAGER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'DEVELOPER';

CREATE TABLE IF NOT EXISTS "ChannelLink" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "accountRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_LINK',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChannelLink_userId_channel_key" ON "ChannelLink"("userId", "channel");
CREATE INDEX IF NOT EXISTS "ChannelLink_companyId_status_idx" ON "ChannelLink"("companyId", "status");

DO $$ BEGIN
  ALTER TABLE "ChannelLink" ADD CONSTRAINT "ChannelLink_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ChannelLink" ADD CONSTRAINT "ChannelLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

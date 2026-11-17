-- Streaming Ads channel for Flywheel AI Advertising / Ad Studio
-- (2026-11-17): campaigns gain a STREAMING placement carrying
-- Google-style text/display creative aimed at streaming TV
-- providers (provider names are labels only — no external ad
-- account is connected). Additive only: one new enum value, one
-- new enum, seven nullable/defaulted columns on AdCampaign.

-- CreateEnum
CREATE TYPE "AdStreamingFormat" AS ENUM ('TEXT', 'DISPLAY');

-- AlterEnum
ALTER TYPE "AdPlacement" ADD VALUE 'STREAMING';

-- AlterTable
ALTER TABLE "AdCampaign" ADD COLUMN "streamingFormat" "AdStreamingFormat",
ADD COLUMN "streamingProviders" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "headlines" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "descriptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "displayPath" TEXT,
ADD COLUMN "longHeadline" TEXT,
ADD COLUMN "displaySizes" TEXT[] DEFAULT ARRAY[]::TEXT[];

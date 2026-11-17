-- Pepper Lists search directories (2026-11-17, three-purpose
-- consolidation): the Post purpose gains the seller's search-directory
-- channels — Google Business Profile, Bing Places, and a general
-- search-directories request. Additive only: three new values on the
-- existing SellerChannel enum; no table or record changes meaning.
-- Same Phase 1 rules as every other channel: a connect files a
-- PENDING request the office completes on the platform side, and a
-- row reads CONNECTED only after a real completed flow.

-- AlterEnum
ALTER TYPE "SellerChannel" ADD VALUE IF NOT EXISTS 'GOOGLE_BUSINESS';
ALTER TYPE "SellerChannel" ADD VALUE IF NOT EXISTS 'BING_PLACES';
ALTER TYPE "SellerChannel" ADD VALUE IF NOT EXISTS 'SEARCH_DIRECTORIES';

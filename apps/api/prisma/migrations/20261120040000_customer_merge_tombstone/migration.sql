-- CRM depth D5 (2026-11-20, Ramone approved): duplicate-customer
-- merge tombstone pointer. One additive nullable column on Customer:
-- when staff merge a duplicate into a survivor, the duplicate's row
-- keeps its identifiers (name / phone / email) and points at the
-- survivor via mergedIntoId, so old phones/emails still find the
-- survivor and the merge is never lost. Null on every live record;
-- inert until the CRM merge tool writes it.

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "mergedIntoId" UUID;

-- CreateIndex
CREATE INDEX "Customer_mergedIntoId_idx" ON "Customer"("mergedIntoId");

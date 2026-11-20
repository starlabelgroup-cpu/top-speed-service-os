-- Win-back campaigns (2026-11-20, D6 — Ramone approved all 55
-- recommendations): two additive nullable columns on Customer,
-- nothing else.
--  * marketingOptOutAt — when the customer opted out of marketing
--    messages (win-back offers). Null = not opted out.
--  * marketingOptOutSource — how the opt-out arrived: SMS_STOP
--    (the customer texted STOP to the business line) or STAFF
--    (recorded by staff in the CRM).
-- A customer with marketingOptOutAt set is excluded from every
-- win-back segment, absolutely. No existing column, table, or index
-- changes meaning; both columns are inert until an opt-out lands.

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "marketingOptOutAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN "marketingOptOutSource" TEXT;

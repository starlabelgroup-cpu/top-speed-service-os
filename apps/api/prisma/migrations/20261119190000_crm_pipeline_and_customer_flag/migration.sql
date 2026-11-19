-- Top Speed CRM upgrades (2026-11-19, Ramone approved): two additive
-- nullable columns, nothing else.
--  * Connection.pipelineStage — the staff-set stage for the CRM
--    Leads & Pipeline board (NEW / CONTACTED / ESTIMATE / WON /
--    LOST). Null = derive from the linked booking at read time.
--  * Customer.crmFlag — the staff-set CRM status flag (PRIORITY /
--    FOLLOW_UP). Null = Active.
-- No existing column, table, or index changes meaning; both columns
-- are inert until the CRM console writes them.

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN "pipelineStage" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "crmFlag" TEXT;

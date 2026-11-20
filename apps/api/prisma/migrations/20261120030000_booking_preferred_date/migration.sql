-- Live arrival-window picker (2026-11-20, recommendation A1): the
-- service day (YYYY-MM-DD) a customer picked with their preferred
-- arrival window on the booking form / in the app / with Speedy.
-- A stated preference only — appointments are still set by Service
-- Setters through Book OS. Additive only: one nullable column.
ALTER TABLE "ServiceRequest" ADD COLUMN "preferredDate" TEXT;

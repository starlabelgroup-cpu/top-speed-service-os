-- Parts Supply OS: partnership vendor distributors.
-- Suppliers gain a vendor type so partner distributors (vendors the
-- platform has a partnership with, added the same way for any future
-- independent distributor) are distinguishable from standard suppliers.
-- Additive only: every existing supplier row reads as STANDARD.
CREATE TYPE "SupplierVendorType" AS ENUM ('STANDARD', 'PARTNER_DISTRIBUTOR');

ALTER TABLE "Supplier" ADD COLUMN "vendorType" "SupplierVendorType" NOT NULL DEFAULT 'STANDARD';

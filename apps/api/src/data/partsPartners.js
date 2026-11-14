/**
 * Parts Supply OS — partnership vendor distributors (2026-11-14).
 *
 * Partner distributors are Supplier rows with vendorType
 * PARTNER_DISTRIBUTOR. This module is the single fact source for
 * partner vendors registered by the owner (as opposed to suppliers
 * staff add day-to-day in the Parts console). Seeding is create-only
 * BY ID everywhere it runs (Prisma seed at deploy time, and the
 * boot-time ensure in db/partsRepo's hydrateParts), so a redeploy can
 * never clobber staff edits or duplicate a partner. Any future
 * independent distributor the owner registers as a partnership vendor
 * gets a row here the same way — or staff can flag any supplier as a
 * partner distributor in the Parts console.
 *
 * Appliance Plus Parts Supply — real facts (owner-supplied only):
 * a parts-supply vendor/distributor the owner directed be recorded as
 * a partnership vendor in Parts Supply OS on 2026-11-14.
 * NO contact details exist in the owner's records — no phone, email,
 * address, contact person, account number, or terms — so every such
 * field stays null until the owner supplies them. Never invent any.
 *
 * NOT Appliance Plus Air, LLC: that is a separate company the owner
 * keeps completely off the Top Speed platform. This record is only a
 * supplier entry inside Parts Supply OS procurement; nothing connects
 * it to Appliance Plus Air.
 */

export const APPLIANCE_PLUS_PARTS_SUPPLY_ID = '40000000-0000-4000-8000-000000000001';

export const PARTNER_VENDOR_SUPPLIERS = [
  {
    id: APPLIANCE_PLUS_PARTS_SUPPLY_ID,
    name: 'Appliance Plus Parts Supply',
    contact: null,
    phone: null,
    email: null,
    terms: null,
    vendorType: 'PARTNER_DISTRIBUTOR',
    active: true,
  },
];

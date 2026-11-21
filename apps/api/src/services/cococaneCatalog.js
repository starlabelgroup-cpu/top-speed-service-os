import { db } from '../db/client.js';

/**
 * CocoCane Express — the shared catalog + stock-location defaults
 * (2026-11-21, flex warehouse model).
 *
 * The catalog below is Ramone's LOCKED menu — the exact products and
 * prices already live on the public CocoCane page:
 *   drinks $5 / $15 / $30 · whole coconuts $2–$4 by size · dry coconuts
 *   $2–$3 by size · sugarcane sticks $7 · coconut meat $7.
 * Nothing else is ever seeded: NO MVP/demo products, NO fruit cups or
 * boxes (fresh fruit is not sold except coconuts, avocado and super
 * cane), and NO avocado — it has no locked price, so it stays out of
 * the catalog until Ramone prices it. Stock starts at an honest ZERO
 * everywhere; staff enter real counts in the CocoCane Express console.
 *
 * Both ensures are idempotent and lazy (first catalog/console read):
 * products and locations are DATA, so staff can extend them through
 * the console API afterwards.
 */

export const LOCKED_PRODUCTS = [
  { sku: 'COCO-WATER-12OZ', name: 'Bottled Coconut Water — 12 oz bottle', category: 'Bottled Coconut Water', description: 'One ingredient, poured straight from the coconut. Light, clean, naturally full of electrolytes.', unit: 'bottle', priceCents: 500, sortOrder: 10 },
  { sku: 'COCO-WATER-HGAL', name: 'Bottled Coconut Water — Half gallon', category: 'Bottled Coconut Water', description: 'One ingredient, poured straight from the coconut. Light, clean, naturally full of electrolytes.', unit: 'half gallon', priceCents: 1500, sortOrder: 11 },
  { sku: 'COCO-WATER-GAL', name: 'Bottled Coconut Water — Gallon', category: 'Bottled Coconut Water', description: 'One ingredient, poured straight from the coconut. Light, clean, naturally full of electrolytes.', unit: 'gallon', priceCents: 3000, sortOrder: 12 },
  { sku: 'CANE-JUICE-12OZ', name: 'Bottled Sugarcane Juice — 12 oz bottle', category: 'Bottled Sugarcane Juice', description: 'Super cane, pressed fresh. Naturally sweet the way the cane made it — nothing added.', unit: 'bottle', priceCents: 500, sortOrder: 20 },
  { sku: 'CANE-JUICE-HGAL', name: 'Bottled Sugarcane Juice — Half gallon', category: 'Bottled Sugarcane Juice', description: 'Super cane, pressed fresh. Naturally sweet the way the cane made it — nothing added.', unit: 'half gallon', priceCents: 1500, sortOrder: 21 },
  { sku: 'CANE-JUICE-GAL', name: 'Bottled Sugarcane Juice — Gallon', category: 'Bottled Sugarcane Juice', description: 'Super cane, pressed fresh. Naturally sweet the way the cane made it — nothing added.', unit: 'gallon', priceCents: 3000, sortOrder: 22 },
  { sku: 'COCONUT-WHOLE', name: 'Whole Coconut (each, by size)', category: 'Whole Coconut', description: 'Fresh whole coconuts, priced by size — drink it, jelly and all, or take it home to cook.', unit: 'each', priceLowCents: 200, priceHighCents: 400, sortOrder: 30 },
  { sku: 'COCONUT-DRY', name: 'Whole Dry Coconut (each, by size)', category: 'Whole Dry Coconut', description: 'Mature dry coconuts for grating, milk and cooking — priced by size.', unit: 'each', priceLowCents: 200, priceHighCents: 300, sortOrder: 40 },
  { sku: 'CANE-STICKS', name: 'Sugarcane Sticks (per bundle)', category: 'Sugarcane Sticks', description: 'Cut super cane sticks, ready to chew — sweet, fresh and fibrous, the old-fashioned way.', unit: 'bundle', priceCents: 700, sortOrder: 50 },
  { sku: 'COCO-MEAT', name: 'Coconut Meat (per container)', category: 'Coconut Meat', description: 'Fresh coconut meat, ready to eat or blend — per container.', unit: 'container', priceCents: 700, sortOrder: 60 },
];

export const DEFAULT_LOCATIONS = [
  { code: 'WAREHOUSE', name: 'Warehouse', kind: 'WAREHOUSE' },
  { code: 'SHOP', name: 'CocoCane Juice Shop', kind: 'SHOP' },
  { code: 'VEHICLE', name: 'Market Vehicle', kind: 'VEHICLE' },
];

let ensured = false;

export async function ensureCocoCaneCatalog() {
  const client = db();
  if (!client || ensured) return;
  for (const product of LOCKED_PRODUCTS) {
    await client.cocoCaneProduct.upsert({
      where: { sku: product.sku },
      update: {},
      create: {
        sku: product.sku,
        name: product.name,
        description: product.description,
        category: product.category,
        unit: product.unit,
        priceCents: product.priceCents ?? null,
        priceLowCents: product.priceLowCents ?? null,
        priceHighCents: product.priceHighCents ?? null,
        sortOrder: product.sortOrder,
      },
    });
  }
  for (const location of DEFAULT_LOCATIONS) {
    await client.cocoCaneLocation.upsert({
      where: { code: location.code },
      update: {},
      create: location,
    });
  }
  ensured = true;
}

/**
 * Top Speed Marketing OS — canonical taxonomy (blueprint §3).
 *
 * Pure data, no imports: this module is consumed by the API repo
 * (cold-start seeding), the routes, and prisma/seed.mjs at deploy time.
 * Seeding is idempotent everywhere (upsert by slug, never clobbers
 * admin edits).
 *
 * Cities: the canonical 12 Broward service cities are serviceCovered.
 * The blueprint's §3 list swaps in Hollywood, Deerfield Beach and
 * Coconut Creek — per Ramone's standing direction those three are
 * EXPANSION records only (serviceCovered: false): they exist so the
 * studio can plan around them, but no page may publish for them
 * (enforced in the publish path, blueprint §10 guardrails).
 */

export const MARKETING_CITIES = [
  { name: 'Lauderhill', slug: 'lauderhill', serviceCovered: true },
  { name: 'Plantation', slug: 'plantation', serviceCovered: true },
  { name: 'Sunrise', slug: 'sunrise', serviceCovered: true },
  { name: 'Tamarac', slug: 'tamarac', serviceCovered: true },
  { name: 'Fort Lauderdale', slug: 'fort-lauderdale', serviceCovered: true },
  { name: 'Lauderdale Lakes', slug: 'lauderdale-lakes', serviceCovered: true },
  { name: 'North Lauderdale', slug: 'north-lauderdale', serviceCovered: true },
  { name: 'Davie', slug: 'davie', serviceCovered: true },
  { name: 'Coral Springs', slug: 'coral-springs', serviceCovered: true },
  { name: 'Pompano Beach', slug: 'pompano-beach', serviceCovered: true },
  { name: 'Oakland Park', slug: 'oakland-park', serviceCovered: true },
  { name: 'Margate', slug: 'margate', serviceCovered: true },
  // Blueprint §3 expansion markets — records only, NOT service-covered.
  { name: 'Hollywood', slug: 'hollywood', serviceCovered: false },
  { name: 'Deerfield Beach', slug: 'deerfield-beach', serviceCovered: false },
  { name: 'Coconut Creek', slug: 'coconut-creek', serviceCovered: false },
];

export const MARKETING_BRANDS = [
  { name: 'Samsung', slug: 'samsung' },
  { name: 'LG', slug: 'lg' },
  { name: 'Whirlpool', slug: 'whirlpool' },
  { name: 'GE', slug: 'ge' },
  { name: 'Frigidaire', slug: 'frigidaire' },
  { name: 'Maytag', slug: 'maytag' },
  { name: 'KitchenAid', slug: 'kitchenaid' },
  { name: 'Bosch', slug: 'bosch' },
  { name: 'Electrolux', slug: 'electrolux' },
  { name: 'Kenmore', slug: 'kenmore' },
  { name: 'Sub-Zero', slug: 'sub-zero' },
  { name: 'Wolf', slug: 'wolf' },
  { name: 'Viking', slug: 'viking' },
  { name: 'Miele', slug: 'miele' },
];

/**
 * Services (blueprint §3 + the platform's canonical 9). `slug` is the
 * URL segment used by the §4 scheme (/services/<slug>/). Cooktop is in
 * the blueprint's service list; on this platform cooktop work is
 * scoped inside Oven/Range, so it is seeded as an entry flagged
 * partOfService -> oven-range-repair rather than a standalone line.
 */
export const MARKETING_SERVICES = [
  { name: 'Refrigerator', slug: 'refrigerator-repair', partOfService: null },
  { name: 'Washer', slug: 'washer-repair', partOfService: null },
  { name: 'Dryer', slug: 'dryer-repair', partOfService: null },
  { name: 'Oven/Range', slug: 'oven-range-repair', partOfService: null },
  { name: 'Dishwasher', slug: 'dishwasher-repair', partOfService: null },
  { name: 'Freezer/Ice Maker', slug: 'freezer-ice-maker-repair', partOfService: null },
  { name: 'Microwave', slug: 'microwave-repair', partOfService: null },
  { name: 'Garbage Disposal', slug: 'garbage-disposal-repair', partOfService: null },
  { name: 'Installation', slug: 'appliance-installation', partOfService: null },
  { name: 'Commercial Appliance Repair', slug: 'commercial-appliance-repair', partOfService: null },
  { name: 'Cooktop', slug: 'cooktop-repair', partOfService: 'oven-range-repair' },
];

export const MARKETING_SYMPTOMS = [
  { name: 'Not cooling', slug: 'not-cooling' },
  { name: 'Not draining', slug: 'not-draining' },
  { name: 'Not heating', slug: 'not-heating' },
  { name: 'Leaking', slug: 'leaking' },
  { name: 'Error codes', slug: 'error-codes' },
  { name: 'Unusual noises', slug: 'unusual-noises' },
  { name: 'No ice', slug: 'no-ice' },
];

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

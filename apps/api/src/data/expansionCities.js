/**
 * Top Speed Marketing OS — tri-county expansion, next ring (2026-11-20).
 *
 * The platform's published coverage is the tri-county area — Broward,
 * Palm Beach and Miami-Dade (the Expander's GEO framing and the
 * Service Areas directory's county framing). The first expansion
 * (2026-11-13, run through the Marketing OS Expander staff tool)
 * published 53 cities on top of the original 12: all 31 Broward
 * municipalities (the same list data/networkPartners.js records as
 * the network's Broward coverage), 16 Palm Beach municipalities and
 * 18 Miami-Dade municipalities — 65 cities, 131 published pages.
 *
 * This module is the NEXT RING: the remaining incorporated
 * municipalities of Palm Beach County (23) and Miami-Dade County
 * (16) — every one a real municipality inside the two counties the
 * platform already publishes coverage for. Broward needs no ring:
 * its 31 municipalities are already fully published. With this ring
 * the published map is every municipality in the tri-county area:
 * 104 cities (31 Broward + 39 Palm Beach + 34 Miami-Dade) and 170
 * published pages.
 *
 * Guardrails, identical to the first expansion:
 * - These cities are NOT added to the 12-city booking auto-match
 *   (config/serviceAreas.js is untouched). A booking naming one of
 *   them resolves through the exact same area path as a booking
 *   naming any of the 53 first-expansion cities — recorded, flagged
 *   for the Service Setters, honestly messaged, never auto-matched
 *   and never promised service the office has not confirmed.
 * - Pages are created ONLY through the normal Marketing OS pipeline
 *   (Expander Phase 5: taxonomy record with serviceCovered true →
 *   CITY page → Speedy Booking + Speedy AI booking links on the page
 *   → DRAFT → IN_REVIEW → PUBLISHED). Nothing here publishes a page.
 * - Copy rules match the existing city pages: no invented reviews,
 *   ratings, or statistics.
 *
 * The Expander page (apps/web/marketing-os/expander) carries the
 * same list inline as CITIES_NEXT; the expansion-cities drill suite
 * asserts the two lists are identical so they cannot drift.
 */

export const EXPANSION_RING2_CITIES = [
  // Palm Beach County — the 23 municipalities not yet published.
  { name: 'Atlantis', slug: 'atlantis', county: 'Palm Beach' },
  { name: 'Briny Breezes', slug: 'briny-breezes', county: 'Palm Beach' },
  { name: 'Cloud Lake', slug: 'cloud-lake', county: 'Palm Beach' },
  { name: 'Glen Ridge', slug: 'glen-ridge', county: 'Palm Beach' },
  { name: 'Golf', slug: 'golf', county: 'Palm Beach' },
  { name: 'Gulf Stream', slug: 'gulf-stream', county: 'Palm Beach' },
  { name: 'Haverhill', slug: 'haverhill', county: 'Palm Beach' },
  { name: 'Highland Beach', slug: 'highland-beach', county: 'Palm Beach' },
  { name: 'Hypoluxo', slug: 'hypoluxo', county: 'Palm Beach' },
  { name: 'Juno Beach', slug: 'juno-beach', county: 'Palm Beach' },
  { name: 'Jupiter Inlet Colony', slug: 'jupiter-inlet-colony', county: 'Palm Beach' },
  { name: 'Lake Clarke Shores', slug: 'lake-clarke-shores', county: 'Palm Beach' },
  { name: 'Lantana', slug: 'lantana', county: 'Palm Beach' },
  { name: 'Loxahatchee Groves', slug: 'loxahatchee-groves', county: 'Palm Beach' },
  { name: 'Manalapan', slug: 'manalapan', county: 'Palm Beach' },
  { name: 'Mangonia Park', slug: 'mangonia-park', county: 'Palm Beach' },
  { name: 'Ocean Ridge', slug: 'ocean-ridge', county: 'Palm Beach' },
  { name: 'Pahokee', slug: 'pahokee', county: 'Palm Beach' },
  { name: 'Palm Beach Shores', slug: 'palm-beach-shores', county: 'Palm Beach' },
  { name: 'South Bay', slug: 'south-bay', county: 'Palm Beach' },
  { name: 'South Palm Beach', slug: 'south-palm-beach', county: 'Palm Beach' },
  { name: 'Tequesta', slug: 'tequesta', county: 'Palm Beach' },
  { name: 'Westlake', slug: 'westlake', county: 'Palm Beach' },
  // Miami-Dade County — the 16 municipalities not yet published.
  { name: 'Bay Harbor Islands', slug: 'bay-harbor-islands', county: 'Miami-Dade' },
  { name: 'Biscayne Park', slug: 'biscayne-park', county: 'Miami-Dade' },
  { name: 'El Portal', slug: 'el-portal', county: 'Miami-Dade' },
  { name: 'Golden Beach', slug: 'golden-beach', county: 'Miami-Dade' },
  { name: 'Indian Creek', slug: 'indian-creek', county: 'Miami-Dade' },
  { name: 'Medley', slug: 'medley', county: 'Miami-Dade' },
  { name: 'Miami Lakes', slug: 'miami-lakes', county: 'Miami-Dade' },
  { name: 'Miami Shores', slug: 'miami-shores', county: 'Miami-Dade' },
  { name: 'Miami Springs', slug: 'miami-springs', county: 'Miami-Dade' },
  { name: 'North Bay Village', slug: 'north-bay-village', county: 'Miami-Dade' },
  { name: 'Opa-locka', slug: 'opa-locka', county: 'Miami-Dade' },
  { name: 'Palmetto Bay', slug: 'palmetto-bay', county: 'Miami-Dade' },
  { name: 'Pinecrest', slug: 'pinecrest', county: 'Miami-Dade' },
  { name: 'South Miami', slug: 'south-miami', county: 'Miami-Dade' },
  { name: 'Virginia Gardens', slug: 'virginia-gardens', county: 'Miami-Dade' },
  { name: 'West Miami', slug: 'west-miami', county: 'Miami-Dade' },
];

/** Published totals once this ring has run through the pipeline. */
export const COVERAGE_AFTER_RING2 = {
  citiesBefore: 65,
  pagesBefore: 131,
  ringCities: EXPANSION_RING2_CITIES.length,
  citiesAfter: 65 + EXPANSION_RING2_CITIES.length,
  pagesAfter: 131 + EXPANSION_RING2_CITIES.length,
  byCounty: { Broward: 31, 'Palm Beach': 39, 'Miami-Dade': 34 },
};

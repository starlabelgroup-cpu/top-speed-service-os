/**
 * Top Speed Service Network — vendor partner businesses (2026-11-14).
 *
 * Network businesses live in the SAME Company / Provider tables as
 * every other dispatch participant (see prisma/seed.mjs and the
 * static skeleton in data/store.js): a partner company row (type
 * NETWORK_BUSINESS) plus a provider row the dispatch layer, Book OS
 * network stats and the tracking console all read. This module is the
 * single source for partner businesses added after the original seed
 * trio. Seeding is create-only BY ID everywhere it runs (Prisma seed
 * at deploy time, and the boot-time ensure in db/bookingsRepo), so a
 * redeploy can never clobber edits or duplicate a partner.
 *
 * Cleanout Vents — real facts (owner-supplied, live on its Facebook
 * Page): dryer vent cleaning business run by the same owner, joined
 * the network as a vendor partner on 2026-11-14.
 *   Services: Dryer Vent Cleaning · Full Vent Line Cleanout ·
 *             Lint & Airflow Inspection
 *   Phone: 954-931-7997 · Hours: Mon–Fri 8am–7pm
 *   Address: 6810 N State Rd 7, Suite 341, Coconut Creek, FL 33073
 *   Coverage: Broward County (rides the Service Setters dispatch)
 *   Facebook: https://www.facebook.com/profile.php?id=61596212109545
 *             (setup complete; the Page still displays the old name
 *             "Top Speed Appliance" — the rename is pending)
 * NO prices exist for vent cleaning — none are stored or published.
 * NO rating exists for Cleanout Vents — rating stays null; never
 * invent one. Vent cleaning is NOT one of the canonical 9 residential
 * booking services: the specialties below never match an appliance
 * booking, so the hybrid matcher never proposes this partner for
 * appliance work — vent work routes by phone through Service Setters.
 */

export const CLEANOUT_VENTS_COMPANY_ID = '20000000-0000-4000-8000-000000000004';
export const CLEANOUT_VENTS_PROVIDER_ID = '30000000-0000-4000-8000-000000000004';

// Broward County coverage, in the city-name vocabulary the Provider
// model uses: the canonical 12 network cities plus the Broward cities
// the platform's tri-county expansion publishes coverage for.
const BROWARD_CITIES = [
  'Lauderhill', 'Plantation', 'Sunrise', 'Tamarac', 'Fort Lauderdale',
  'Lauderdale Lakes', 'North Lauderdale', 'Davie', 'Coral Springs',
  'Pompano Beach', 'Oakland Park', 'Margate',
  'Hollywood', 'Pembroke Pines', 'Miramar', 'Deerfield Beach',
  'Coconut Creek', 'Dania Beach', 'Cooper City', 'Weston', 'Parkland',
  'Hallandale Beach', 'Wilton Manors', 'Lighthouse Point',
  'Lauderdale-by-the-Sea', 'Southwest Ranches', 'West Park',
  'Pembroke Park', 'Hillsboro Beach', 'Sea Ranch Lakes', 'Lazy Lake',
];

export const NETWORK_PARTNER_COMPANIES = [
  {
    id: CLEANOUT_VENTS_COMPANY_ID,
    name: 'Cleanout Vents',
    slug: 'cleanout-vents',
    type: 'NETWORK_BUSINESS',
    isPlatformOwner: false,
  },
];

export const NETWORK_PARTNER_PROVIDERS = [
  {
    id: CLEANOUT_VENTS_PROVIDER_ID,
    companyId: CLEANOUT_VENTS_COMPANY_ID,
    businessName: 'Cleanout Vents',
    type: 'NETWORK_BUSINESS',
    specialties: ['Dryer Vent Cleaning', 'Full Vent Line Cleanout', 'Lint & Airflow Inspection'],
    serviceCities: BROWARD_CITIES,
    rating: null,
    active: true,
  },
];

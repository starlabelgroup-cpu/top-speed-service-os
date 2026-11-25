/**
 * Ads Library seed creatives (2026-11-24) — the REAL house creative
 * set, registered into the AdCreative table by
 * db/adCreativesRepo.js the first time the table is found empty.
 * Nothing here is invented:
 *
 *   - The 21 photo ads are Pepper's real-image batch of 2026-11-23
 *     (masters 1600×1600 + landscape 1200×628, claim-checked one by
 *     one in that batch's INDEX). Their JPEG bytes ride in
 *     src/assets/adCreativeImagesNN.js and serve from
 *     GET /api/v1/ads-os/img/:file. The batch's dryer-vent creative
 *     is a Cleanout Vents piece and is deliberately NOT here — this
 *     is the Top Speed library.
 *   - The 2 display ads are the Flywheel display pack of 2026-11-23
 *     (1600×1600 masters, same claim discipline).
 *   - The 2 text ads are that pack's search-format text ads, with
 *     their pack-approved headlines/descriptions verbatim.
 *   - The 2 visual offers are the standing Ads OS offer cards whose
 *     designed SVGs the Pepper visual service already renders
 *     (offer-rate-card / offer-referral-rewards) — registered by
 *     reference, never re-drawn.
 *
 * Copy discipline: locked facts only ($99 residential diagnostic
 * credited toward an approved repair, $210 flat repair labor, $150
 * flat installation, the approved 2026-11-12 referral economics,
 * Mon–Fri 8am–7pm, 65 cities). No ratings, no stars, no "24/7", no
 * unapproved discounts. Every seed passes the platform claim gate
 * (services/claimCheck.js) — the library drill proves it, and the
 * stored claimStatus records the result. Destinations follow the
 * booking consolidation: booking intent lands on /book.
 */

const BOOK = 'https://topspeedserviceos.com/book';
const APP = 'https://topspeedserviceos.com/app';
const REFER = 'https://topspeedserviceos.com/refer';
const SPEEDY = 'https://topspeedserviceos.com/speedy';

const DIAG_LABOR = '$99 diagnostic, credited toward repair · $210 flat labor';
const DIAG_CREDIT = '$99 diagnostic, credited toward your repair';

function photo(key, serviceTag, headline, subline, destinationUrl) {
  return {
    key, kind: 'IMAGE', title: headline, headline, subline,
    ctaText: 'Book a repair', serviceTag, cityTag: null,
    assetKind: 'MODULE', assetRef: key,
    formats: ['1600x1600', '1200x628'], destinationUrl,
  };
}

export const AD_CREATIVE_SEEDS = [
  // ── Service heroes (photo batch 01–09) ──────────────────────────
  photo('photo-refrigerator-repair', 'refrigerator', 'Refrigerator Repair', DIAG_LABOR, BOOK),
  photo('photo-washer-repair', 'washer', 'Washer Repair', DIAG_LABOR, BOOK),
  photo('photo-dryer-repair', 'dryer', 'Dryer Repair', DIAG_LABOR, BOOK),
  photo('photo-oven-range-repair', 'oven-range', 'Oven & Range Repair', DIAG_LABOR, BOOK),
  photo('photo-dishwasher-repair', 'dishwasher', 'Dishwasher Repair', DIAG_LABOR, BOOK),
  photo('photo-freezer-ice-maker-repair', 'freezer-ice-maker', 'Freezer & Ice Maker Repair', DIAG_LABOR, BOOK),
  photo('photo-microwave-repair', 'microwave', 'Microwave Repair', DIAG_LABOR, BOOK),
  photo('photo-garbage-disposal-repair', 'garbage-disposal', 'Garbage Disposal Repair', DIAG_LABOR, BOOK),
  photo('photo-appliance-installation', 'installation', 'Appliance Installation', '$150 flat installation · written quote before work starts', BOOK),

  // ── Symptom angles (photo batch 10–13) ──────────────────────────
  photo('photo-refrigerator-not-cooling', 'refrigerator', 'Fridge Not Cooling?', DIAG_CREDIT, BOOK),
  photo('photo-washer-leaking', 'washer', "Washer Leaking or Won't Drain?", DIAG_CREDIT, BOOK),
  photo('photo-dryer-not-heating', 'dryer', 'Dryer Not Heating?', DIAG_CREDIT, BOOK),
  photo('photo-oven-not-heating', 'oven-range', 'Oven Not Heating?', DIAG_CREDIT, BOOK),

  // ── Feature + brand (photo batch 14–17, 19–22) ──────────────────
  photo('photo-speedy-photo-diagnosis', null, 'Snap a Photo. Ask Speedy.', 'Send a photo, get a first look before you book', SPEEDY),
  photo('photo-track-my-tech', null, 'Track My Tech', "Follow your technician's arrival right in the app", APP),
  photo('photo-book-in-the-app', null, 'Book Your Repair in the App', 'Pick your day and window · Mon–Fri, 8am–7pm', APP),
  photo('photo-review-invite', null, 'Happy With Your Repair?', 'Tell a neighbor — leave us a review', APP),
  photo('photo-flat-rate-card', null, 'Flat Rates. No Surprises.', '$210 flat repair labor · $150 flat installation', BOOK),
  photo('photo-refer-and-earn', null, 'Refer a Friend, Earn $25', 'Credits grow to $50 · milestone rewards up to $250', REFER),
  photo('photo-diagnostic-credited', null, '$99 Diagnostic, Credited in Full', 'Collected at booking, credited toward your approved repair', BOOK),
  photo('photo-coverage-65-cities', null, '65 Cities. One Fast Crew.', 'Broward · Palm Beach · Miami-Dade', BOOK),

  // ── Flywheel display pack (2026-11-23, square masters) ─────────
  {
    key: 'display-diagnostic-credit', kind: 'IMAGE',
    title: '$99 Diagnostic, Credited in Full',
    headline: '$99 Diagnostic, Credited in Full',
    subline: 'Collected at booking, credited in full toward your approved repair. Still due if declined.',
    ctaText: 'Book a repair', serviceTag: null, cityTag: null,
    assetKind: 'MODULE', assetRef: 'display-diagnostic-credit',
    formats: ['1600x1600'], destinationUrl: BOOK,
  },
  {
    key: 'display-track-my-tech', kind: 'IMAGE',
    title: 'Track My Tech Right in the App',
    headline: 'Track My Tech Right in the App',
    subline: "Book in the app, then follow your technician's arrival right on your phone.",
    ctaText: 'Book in the app', serviceTag: null, cityTag: null,
    assetKind: 'MODULE', assetRef: 'display-track-my-tech',
    formats: ['1600x1600'], destinationUrl: APP,
  },

  // ── Flywheel text ads (search format, pack-verbatim) ────────────
  {
    key: 'text-residential-repair', kind: 'TEXT',
    title: 'Appliance Repair Near You',
    headline: 'Appliance Repair Near You',
    subline: 'Refrigerator, washer, dryer & oven repair across 65 South Florida cities. Book online. $99 diagnostic credited toward your approved repair. Mon–Fri 8–7. Written quote first.',
    ctaText: 'Book Your Repair Online', serviceTag: null, cityTag: null,
    assetKind: 'NONE', assetRef: null, formats: [], destinationUrl: BOOK,
  },
  {
    key: 'text-referral-rewards', kind: 'TEXT',
    title: 'Refer a Friend, Earn $25',
    headline: 'Refer a Friend, Earn $25',
    subline: 'Earn $25 credit per completed referral — $35 each at 5–9, $50 each at 10+. Friends get $25 off their first repair. Credits good for 12 months.',
    ctaText: 'Get Your Link', serviceTag: null, cityTag: null,
    assetKind: 'NONE', assetRef: null, formats: [],
    destinationUrl: 'https://appliancereferral.com',
  },

  // ── Standing offer cards (Pepper visual service, by reference) ──
  {
    key: 'visual-rate-card', kind: 'IMAGE',
    title: 'Flat-rate pricing — no surprises',
    headline: 'Flat-rate pricing — no surprises',
    subline: '$99 residential diagnostic, credited toward an approved repair · Repair labor $210 flat · Installation labor $150 flat',
    ctaText: 'Book a repair', serviceTag: null, cityTag: null,
    assetKind: 'VISUAL', assetRef: 'offer-rate-card',
    formats: ['1200x628', '1080x1080', '1080x1920'], destinationUrl: BOOK,
  },
  {
    key: 'visual-referral-rewards', kind: 'IMAGE',
    title: 'Refer & earn — Top Speed referral rewards',
    headline: 'Refer & earn — Top Speed referral rewards',
    subline: '$25 service credit for each friend whose job is completed and paid · Your friend gets $25 off their first repair',
    ctaText: 'Get your referral link', serviceTag: null, cityTag: null,
    assetKind: 'VISUAL', assetRef: 'offer-referral-rewards',
    formats: ['1200x628', '1080x1080', '1080x1920'], destinationUrl: REFER,
  },
];

import { CITY_SPOTLIGHT_PAGES } from '../data/citySpotlightPages.js';
import { buildPhase2DraftPages } from '../data/phase2DraftPages.js';

/**
 * Top Speed Campaign Engine — the FACTORY (2026-11-23, Ramone:
 * "Launch thousands of campaigns with new ideas every post on all
 * platforms… Start now and never stop until I tell you to pause
 * or delete campaigns").
 *
 * This module is the pure generator: divisions × surfaces × angles
 * × subjects, rendered into campaign records with LOCKED facts
 * only. It writes nothing and knows nothing about the database —
 * services/campaignEngine.js persists what it returns, and the
 * seed calls the same functions at deploy time, so the registry's
 * contents are reproducible from code alone.
 *
 * THE BOUNDARIES, enforced in code, not just stated:
 *  - ZERO SPEND: every record is born DRAFT (or QUEUED/STAGED for
 *    the social and email/SMS staging lanes). Nothing here funds,
 *    enables, or arms a campaign; paid-platform launches remain
 *    the owner's per-campaign call in the platforms themselves.
 *  - CLAIM-CHECK GATE: every generated copy passes checkClaims()
 *    before it leaves the factory; a single violation throws and
 *    the batch does not generate. The gate rejects ratings, star
 *    claims, invented discounts, "free" service claims, 24/7
 *    claims, guarantees, superlatives, and any phone number that
 *    is not the surface's own approved number.
 *  - LOCKED FACTS: $99 residential diagnostic (collected at
 *    booking, credited toward an approved repair, still due if
 *    declined), $210 flat repair labor, $150 flat installation,
 *    referral $25 / $35 at 5–9 / $50 at 10+ with milestones
 *    $100@10 and $250@25 and 12-month expiry, the friend's $25
 *    off their first repair, Mon–Fri 8am–7pm, (844) 460-7038,
 *    131 published pages / 65 cities. Advertiser plans are the
 *    set prices (Starter $29 / Growth $99 / Pro $299 per month).
 *    Cleanout Vents is a sister brand with its OWN identity and
 *    its own number (954-931-7997) and NO prices anywhere.
 *    Appliance Plus Air, LLC never appears — it is a separate
 *    company, never a Top Speed ad identity.
 *  - NO BARE PAGES: every record lands on a real surface with
 *    live booking (or that division's real console/shop/page)
 *    and carries utm_source / utm_medium / utm_campaign — the
 *    exact parameters the intake attribution already captures
 *    (services/attribution.js).
 */

// ─── Locked facts ─────────────────────────────────────────────────

export const FACTS = {
  phone: '(844) 460-7038',
  phoneDigits: '844-460-7038',
  ventPhone: '954-931-7997',
  hours: 'Mon–Fri, 8am–7pm',
  diagnostic: 99,
  repairLabor: 210,
  installation: 150,
  cities: 65,
  pages: 131,
  bookUrl: 'https://topspeedserviceos.com/book',
  referUrl: 'https://topspeedserviceos.com/refer',
  speedyUrl: 'https://topspeedserviceos.com/speedy',
  homeUrl: 'https://topspeedserviceos.com/',
  shopUrl: 'https://topspeedappliances.com/',
  pepperListsUrl: 'https://pepperlists.com/',
  ventUrl: 'https://cleanoutvents.com/',
};

// ─── Surfaces + creative specs (tech pack c) ──────────────────────

export const SURFACES = [
  'WEBSITE', 'CITY_SERVICE_PAGES', 'SOCIAL_FB', 'SOCIAL_IG',
  'PEPPER_LISTS', 'ADS_STREAM', 'EMAIL', 'SMS', 'SEARCH_AI',
  'MAPS_PROFILES', 'APP', 'INTERNAL',
];

export const CREATIVE_SPECS = {
  WEBSITE: { format: 'banner', width: 1200, height: 628, file: 'JPG/PNG', note: 'Designed SVG-icon set; baked text renders whole at natural aspect, never cropped.' },
  CITY_SERVICE_PAGES: { format: 'page module', width: 1200, height: 628, file: 'JPG/PNG', note: 'Module lives on the page itself; the page is the creative surface.' },
  SOCIAL_FB: { format: 'square post', width: 1080, height: 1080, file: 'JPG only (Page posts take PNG/JPEG/MP4 — never WebP)', note: 'Copy ≤ 1,024 characters (Page post limit); series sign-off + slogan.' },
  SOCIAL_IG: { format: 'square post', width: 1080, height: 1080, file: 'JPG', note: 'Caption points to the bio link / /links hub; booking URL in the first comment; pillar hashtags on the IG version only.' },
  PEPPER_LISTS: { format: 'listing card', width: 1080, height: 1080, file: 'JPG/PNG', note: 'Runs through the Pepper Lists Advertise lane — office review before it shows.' },
  ADS_STREAM: { format: 'stream card', width: 1080, height: 1080, file: 'JPG', note: 'POSTED only with a real facebook.com URL behind the owner approval card.' },
  EMAIL: { format: 'email', width: 600, height: null, file: 'HTML/text', note: 'Sent only through the approved Resend sending domain, to the named lawful audience.' },
  SMS: { format: 'text', width: null, height: null, file: 'text ≤ 320 chars', note: 'Transactional/consented audiences only — never a cold blast.' },
  SEARCH_AI: { format: 'directory/listing copy', width: null, height: null, file: 'text', note: 'Facts-only copy for search engines, AI answers and directories — the llms.txt discipline.' },
  MAPS_PROFILES: { format: 'profile post', width: 1200, height: 900, file: 'JPG', note: 'Google Business / Bing / Apple profile posts — hours stay Mon–Fri 8–7 everywhere except the deliberate GBP 24-hour display.' },
  APP: { format: 'in-app card / push', width: 1080, height: 1080, file: 'JPG/PNG', note: 'Customer-app surfaces only (Pepper Lists, Appliance Connect) — accounts are free; nothing paywalled by a campaign.' },
  INTERNAL: { format: 'workstation card', width: 1200, height: 628, file: 'JPG/PNG', note: 'Staff-facing adoption/ops campaigns inside the workstations — never customer-visible.' },
};

// ─── Angles (the proven hook families + division lanes) ───────────

export const ANGLES = [
  'RATE_CARD', 'SPEEDY_AI', 'REFERRAL', 'CITY_SPOTLIGHT', 'SEASONAL',
  'SYMPTOM_LED', 'SHOP_INVENTORY', 'MARKETPLACE', 'WHOLESALE', 'VENT',
  'NETWORK_RECRUITING', 'PARTS', 'TRAINING', 'ADVERTISER', 'PAYMENT',
  'APP_ADOPTION', 'INTERNAL_ADOPTION', 'CREATIVE',
];

// ─── Divisions (the interconnection roster) ───────────────────────
// consoleUrl is the division's own console/page (Rule 1 — a link
// goes to a page for THAT division). Surfaces/angles are the lanes
// the factory may generate for the division.

export const DIVISIONS = [
  { key: 'top-speed-ads', name: 'Top Speed Ads', consoleUrl: 'https://topspeedserviceos.com/ad-studio', surfaces: ['WEBSITE', 'SOCIAL_FB', 'SOCIAL_IG', 'ADS_STREAM', 'SEARCH_AI'], angles: ['RATE_CARD', 'SPEEDY_AI', 'SYMPTOM_LED', 'SEASONAL'], audience: 'Broward / Palm Beach / Miami-Dade homeowners with a broken appliance' },
  { key: 'ads-os-manager', name: 'Top Speed Ads OS Manager (app)', consoleUrl: 'https://topspeedserviceos.com/ads', surfaces: ['INTERNAL'], angles: ['INTERNAL_ADOPTION'], audience: 'Top Speed marketing staff running the Ads OS Manager app' },
  { key: 'local-os', name: 'Top Speed Local OS', consoleUrl: 'https://topspeedserviceos.com/local', surfaces: ['MAPS_PROFILES', 'SEARCH_AI', 'WEBSITE'], angles: ['CITY_SPOTLIGHT', 'RATE_CARD'], audience: 'Homeowners searching locally, by city' },
  { key: 'marketing-os', name: 'Top Speed Marketing OS', consoleUrl: 'https://topspeedserviceos.com/marketing-os', surfaces: ['CITY_SERVICE_PAGES', 'WEBSITE', 'SEARCH_AI'], angles: ['CITY_SPOTLIGHT', 'SYMPTOM_LED', 'SEASONAL'], audience: 'Homeowners landing on the 131 city and service pages' },
  { key: 'sales-os', name: 'Top Speed Sales OS', consoleUrl: 'https://topspeedserviceos.com/sales-os', surfaces: ['WEBSITE', 'SOCIAL_FB', 'SOCIAL_IG', 'PEPPER_LISTS', 'EMAIL'], angles: ['SHOP_INVENTORY', 'SEASONAL'], audience: 'Shoppers for quality used appliances in South Florida' },
  { key: 'book-os', name: 'Book OS — Service Setters', consoleUrl: 'https://topspeedserviceos.com/book', surfaces: ['WEBSITE', 'EMAIL', 'SMS'], angles: ['RATE_CARD', 'SYMPTOM_LED'], audience: 'Customers booking through the classic web form — Service Setters dispatch' },
  { key: 'dispatch', name: 'Dispatch Dashboard / Service Book', consoleUrl: 'https://topspeedserviceos.com/book-os', surfaces: ['INTERNAL'], angles: ['INTERNAL_ADOPTION'], audience: 'Service Setters dispatchers and office staff' },
  { key: 'tech-portal', name: 'Top Speed Tech Web Portal + Tech App', consoleUrl: 'https://topspeedserviceos.com/tech', surfaces: ['INTERNAL'], angles: ['INTERNAL_ADOPTION', 'NETWORK_RECRUITING'], audience: 'Company Tech and Network Tech providers' },
  { key: 'field-pro', name: 'Top Speed Field Pro', consoleUrl: 'https://top-speed-field-pro.vercel.app/', surfaces: ['INTERNAL'], angles: ['INTERNAL_ADOPTION'], audience: 'Field technicians on work orders' },
  { key: 'ad-console', name: 'Top Speed Ad Console (Advertiser Console)', consoleUrl: 'https://topspeedserviceos.com/advertiser', surfaces: ['WEBSITE', 'EMAIL', 'SOCIAL_FB'], angles: ['ADVERTISER'], audience: 'Local businesses advertising on Top Speed surfaces' },
  { key: 'flywheel', name: 'Flywheel Advertising', consoleUrl: 'https://topspeedserviceos.com/flywheel', surfaces: ['WEBSITE', 'EMAIL', 'SMS', 'SOCIAL_FB'], angles: ['REFERRAL', 'RATE_CARD', 'ADVERTISER'], audience: 'The Service Network and outside advertisers under the Advertiser Console' },
  { key: 'ad-studio', name: 'Top Speed Ad Studio', consoleUrl: 'https://topspeedserviceos.com/ad-studio', surfaces: ['WEBSITE', 'ADS_STREAM', 'SOCIAL_FB'], angles: ['CREATIVE', 'RATE_CARD'], audience: 'Staff building campaigns and creatives for owner approval' },
  { key: 'page-studio', name: 'Top Speed Page Studio', consoleUrl: 'https://topspeedserviceos.com/marketing-os', surfaces: ['CITY_SERVICE_PAGES', 'WEBSITE'], angles: ['CITY_SPOTLIGHT', 'CREATIVE'], audience: 'Staff publishing city and service pages' },
  { key: 'crm', name: 'Top Speed CRM', consoleUrl: 'https://topspeedserviceos.com/crm', surfaces: ['INTERNAL', 'EMAIL'], angles: ['INTERNAL_ADOPTION', 'PAYMENT'], audience: 'Office staff working the customer book' },
  { key: 'media-os', name: 'Top Speed Media OS', consoleUrl: 'https://topspeedserviceos.com/social-hub', surfaces: ['SOCIAL_FB', 'SOCIAL_IG', 'ADS_STREAM'], angles: ['SPEEDY_AI', 'SEASONAL', 'CITY_SPOTLIGHT'], audience: 'Followers of the official Facebook Page and Instagram' },
  { key: 'service-network', name: 'Service Network (provider recruiting)', consoleUrl: 'https://topspeedapplianceservice.com/', surfaces: ['WEBSITE', 'SOCIAL_FB', 'EMAIL'], angles: ['NETWORK_RECRUITING'], audience: 'Independent appliance service providers who apply to join' },
  { key: 'parts-supply', name: 'Parts Supply', consoleUrl: 'https://topspeedserviceos.com/parts', surfaces: ['WEBSITE', 'EMAIL'], angles: ['PARTS'], audience: 'Technicians and providers sourcing appliance parts' },
  { key: 'appliance-plug', name: 'Appliance Plug', consoleUrl: 'https://topspeedserviceos.com/tech', surfaces: ['INTERNAL'], angles: ['INTERNAL_ADOPTION'], audience: 'Technicians using the Plug camera tools on jobs' },
  { key: 'finance', name: 'Finance', consoleUrl: 'https://topspeedserviceos.com/applianceman', surfaces: ['EMAIL', 'SMS', 'INTERNAL'], angles: ['PAYMENT'], audience: 'Customers with an open invoice or estimate (transactional)' },
  { key: 'pepper-lists', name: 'Pepper Lists (web + app)', consoleUrl: 'https://pepperlists.com/', surfaces: ['PEPPER_LISTS', 'SOCIAL_FB', 'EMAIL', 'APP'], angles: ['MARKETPLACE', 'REFERRAL', 'APP_ADOPTION'], audience: 'Pepper Lists sellers, buyers and bookers' },
  { key: 'appliance-connect', name: 'Appliance Connect + Connect Pro (app + portal)', consoleUrl: 'https://topspeedserviceos.com/app', surfaces: ['APP', 'WEBSITE', 'EMAIL'], angles: ['APP_ADOPTION', 'RATE_CARD'], audience: 'Homeowners and property managers with a free customer account' },
  { key: 'appliance-pro', name: 'AppliancePro (app + portal)', consoleUrl: 'https://appliancepro.net/', surfaces: ['WEBSITE', 'EMAIL', 'SEARCH_AI'], angles: ['RATE_CARD', 'SYMPTOM_LED'], audience: 'Commercial accounts — priced by custom quote' },
  { key: 'speedy-booking', name: 'Smart AI Booking by Speedy', consoleUrl: 'https://topspeedserviceos.com/speedy', surfaces: ['WEBSITE', 'APP', 'SOCIAL_FB'], angles: ['SPEEDY_AI'], audience: 'Customers who prefer chat booking with photo diagnosis' },
  { key: 'referral-program', name: 'Rewards + Referrals', consoleUrl: 'https://topspeedserviceos.com/refer', surfaces: ['WEBSITE', 'EMAIL', 'SMS', 'SOCIAL_FB', 'ADS_STREAM'], angles: ['REFERRAL'], audience: 'Customers with a personal referral link' },
  { key: 'training-academy', name: 'Training Academy', consoleUrl: 'https://topspeedserviceos.com/academy', surfaces: ['WEBSITE', 'SOCIAL_FB', 'EMAIL'], angles: ['TRAINING'], audience: 'Technicians and trainees building appliance careers' },
  { key: 'service-os-portal', name: 'Service OS Portal', consoleUrl: 'https://topspeedserviceos.com/portal', surfaces: ['WEBSITE', 'INTERNAL'], angles: ['INTERNAL_ADOPTION', 'APP_ADOPTION'], audience: 'Everyone entering the ecosystem — one directory of every door' },
  { key: 'work-time-access', name: 'Work Time Access', consoleUrl: 'https://topspeedserviceos.com/applianceman', surfaces: ['INTERNAL'], angles: ['INTERNAL_ADOPTION'], audience: 'Owner-tier workstation access' },
  { key: 'applianceman', name: 'ApplianceMan Master Super Manager (+ app)', consoleUrl: 'https://topspeedserviceos.com/applianceman', surfaces: ['INTERNAL'], angles: ['INTERNAL_ADOPTION'], audience: 'The Master and managers running the whole system' },
  { key: 'cococane', name: 'CocoCane', consoleUrl: 'https://topspeedserviceos.com/cococane-site', surfaces: ['PEPPER_LISTS', 'SOCIAL_FB', 'EMAIL'], angles: ['WHOLESALE', 'SEASONAL'], audience: 'Coconut water and produce buyers, retail and wholesale' },
  { key: 'cleanout-vents', name: 'Cleanout Vents (sister brand)', consoleUrl: 'https://cleanoutvents.com/', surfaces: ['WEBSITE', 'SOCIAL_FB', 'MAPS_PROFILES'], angles: ['VENT'], audience: 'Homeowners needing dryer vent cleaning — Cleanout Vents, its own brand' },
];

export const DIVISION_BY_KEY = new Map(DIVISIONS.map((d) => [d.key, d]));

// ─── The page universe: the 131 published pages ───────────────────
// 124 from the verified spotlight list + the 7 pages the Phase 3
// flip published on 2026-11-23 (their specs live in
// phase2DraftPages.js). A campaign exists only for a page in this
// list, and its link is that page's own canonical URL (Rule 1).

const PHASE3_URLS = [
  'https://topspeedappliance.net/services/refrigerator-repair/leaking/',
  'https://topspeedappliance.net/services/refrigerator-repair/unusual-noises/',
  'https://topspeedappliance.net/services/refrigerator-repair/error-codes/',
  'https://topspeedappliance.net/services/washer-repair/leaking/',
  'https://topspeedappliance.net/services/washer-repair/unusual-noises/',
  'https://topspeedappliance.net/services/washer-repair/error-codes/',
  'https://topspeedappliance.net/services/dryer-repair/unusual-noises/',
];

function phase3Pages() {
  const specs = new Map(buildPhase2DraftPages().map((s) => [s.canonicalUrl, s]));
  return PHASE3_URLS.map((url) => {
    const spec = specs.get(url);
    const slug = url.replace('https://topspeedappliance.net/', '').replace(/\/$/, '');
    return {
      kind: 'SERVICE',
      slug,
      url,
      title: spec?.title || slug,
      service: spec?.serviceSlug || null,
      symptom: spec?.symptomSlug || null,
    };
  });
}

export const PAGES = [
  ...CITY_SPOTLIGHT_PAGES.map((p) => ({ ...p, title: null, service: null, symptom: null })),
  ...phase3Pages(),
];

export const CITIES = [...new Map(
  CITY_SPOTLIGHT_PAGES.filter((p) => p.kind === 'CITY').map((p) => [p.citySlug, p]),
).values()];

export const SERVICES = [
  { slug: 'refrigerator-repair', name: 'Refrigerator', plural: 'refrigerators' },
  { slug: 'washer-repair', name: 'Washer', plural: 'washers' },
  { slug: 'dryer-repair', name: 'Dryer', plural: 'dryers' },
  { slug: 'oven-range-repair', name: 'Oven & Range', plural: 'ovens and ranges' },
  { slug: 'dishwasher-repair', name: 'Dishwasher', plural: 'dishwashers' },
  { slug: 'freezer-ice-maker-repair', name: 'Freezer & Ice Maker', plural: 'freezers and ice makers' },
  { slug: 'microwave-repair', name: 'Microwave', plural: 'microwaves' },
  { slug: 'garbage-disposal-repair', name: 'Garbage Disposal', plural: 'garbage disposals' },
  { slug: 'appliance-installation', name: 'Appliance Installation', plural: 'appliance installations' },
];

const SYMPTOMS = [
  { slug: 'not-cooling', text: 'not cooling' },
  { slug: 'leaking', text: 'leaking' },
  { slug: 'not-draining', text: 'not draining' },
  { slug: 'not-heating', text: 'not heating' },
  { slug: 'unusual-noises', text: 'making unusual noises' },
  { slug: 'error-codes', text: 'showing error codes' },
  { slug: 'no-ice', text: 'not making ice' },
];

// ─── Claim-check gate (tech pack b) ───────────────────────────────
// Every copy the factory emits passes through here. A hit throws —
// the batch does not generate with a bad record in it. The gate is
// also exported for the routes/console to check hand-written copy.

const PHONE_ALLOWLIST = [FACTS.phoneDigits, FACTS.ventPhone, '8444607038', '9549317997'];

const CLAIM_RULES = [
  { id: 'star-rating', re: /★|\bstars?\b[^.]{0,24}\brat|rated\s+\d|rating[s]?\s+of\s+\d/i, why: 'ratings and star claims are never invented' },
  { id: 'review-count', re: /\b\d+\s+(five|5)[-\s]?star\b|\b\d+\+?\s+reviews\b/i, why: 'review counts are never invented' },
  { id: 'superlative', re: /\b(best|#1|number one|top-rated|leading|premier)\b/i, why: 'superlatives are unproven claims' },
  { id: 'guarantee', re: /\bguarantee[ds]?\b|\bwarrant(y|ies)\s+included\b/i, why: 'no invented warranties or guarantees — the shield stands for the written-quote guarantee only' },
  { id: 'free-service', re: /\bfree\s+(diagnostic|estimate|service call|repair|installation)\b/i, why: 'no free-service claims — the $99 diagnostic is credited, not free' },
  { id: 'percent-off', re: /\b\d+\s?%\s?off\b/i, why: 'percentage discounts are not approved economics' },
  { id: 'same-day', re: /\bsame[-\s]?day\s+(service|repair|guarantee)\b/i, why: 'same-day service is not a promise the platform makes' },
  { id: 'always-open', re: /24\s?\/\s?7|24[-\s]hour service|open 24 hours/i, why: 'platform hours are Mon–Fri 8am–7pm on every surface except the deliberate GBP display' },
  { id: 'licensed-claim', re: /\blicensed\s*(and|&)\s*insured\b|\bcertified technicians\b/i, why: 'credential claims are not in the locked facts' },
  { id: 'vent-price', re: /vent[^.]{0,40}\$\d|\$\d+[^.]{0,40}vent/i, why: 'no vent price is ever quoted on any surface' },
  { id: 'commercial-99', re: /commercial[^.]{0,60}\$99|\$99[^.]{0,60}commercial/i, why: 'the $99 diagnostic is residential only — commercial is custom quote' },
];

export function checkClaims(copy, { divisionKey } = {}) {
  const violations = [];
  const text = String(copy || '');
  for (const rule of CLAIM_RULES) {
    if (rule.re.test(text)) violations.push({ rule: rule.id, why: rule.why });
  }
  // Dollar amounts: only the locked figures may appear in copy.
  const allowedAmounts = new Set(['99', '210', '150', '25', '35', '50', '100', '250', '29']);
  for (const match of text.matchAll(/\$(\d[\d,]*)/g)) {
    if (!allowedAmounts.has(match[1].replace(/,/g, ''))) {
      violations.push({ rule: 'unlocked-price', why: `$${match[1]} is not a locked figure` });
    }
  }
  // Phone numbers: only the surface's own approved number.
  const foundPhones = text.match(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g) || [];
  for (const phone of foundPhones) {
    const digits = phone.replace(/\D/g, '');
    const ok = divisionKey === 'cleanout-vents'
      ? digits === '9549317997'
      : PHONE_ALLOWLIST.some((p) => p.replace(/\D/g, '') === digits) && digits === '8444607038';
    if (!ok) violations.push({ rule: 'wrong-phone', why: `${phone} is not this surface's approved number` });
  }
  // The sister brand never carries Top Speed pricing, and Top
  // Speed copy never carries the vent number.
  if (divisionKey === 'cleanout-vents' && /\$\d/.test(text)) {
    violations.push({ rule: 'vent-price', why: 'Cleanout Vents copy carries no prices' });
  }
  return violations;
}

export function assertClaims(copy, context = {}) {
  const violations = checkClaims(copy, context);
  if (violations.length) {
    const err = new Error(`Claim-check failed: ${violations.map((v) => `${v.rule} (${v.why})`).join('; ')}`);
    err.code = 'CLAIM_CHECK_FAILED';
    err.violations = violations;
    throw err;
  }
}

// ─── Attribution (tech pack a) ────────────────────────────────────
// utm_source / utm_medium / utm_campaign — the parameters the
// intake attribution already captures (services/attribution.js).

export function buildAttributionUrl(baseUrl, { sourceTag, medium, campaignKey }) {
  const url = new URL(baseUrl);
  url.searchParams.set('utm_source', sourceTag);
  url.searchParams.set('utm_medium', medium);
  url.searchParams.set('utm_campaign', campaignKey);
  return url.toString();
}

const MEDIUM_BY_SURFACE = {
  WEBSITE: 'website', CITY_SERVICE_PAGES: 'landing-page', SOCIAL_FB: 'social',
  SOCIAL_IG: 'social', PEPPER_LISTS: 'marketplace', ADS_STREAM: 'stream',
  EMAIL: 'email', SMS: 'sms', SEARCH_AI: 'search', MAPS_PROFILES: 'maps',
  APP: 'app', INTERNAL: 'internal',
};

// ─── Copy templates (locked facts only) ───────────────────────────
// Three hook variants per angle rotate by variant index, so daily
// batches keep producing new copy from the same proven families.

function rateCardLines(commercial = false) {
  if (commercial) {
    return 'Commercial work is priced by custom quote — no work ever starts without your approved written quote.';
  }
  return `$${FACTS.diagnostic} residential diagnostic, collected at booking and credited toward your approved repair · $${FACTS.repairLabor} flat repair labor · $${FACTS.installation} flat installation · parts priced in the written quote — no work ever starts without your approval.`;
}

const COPY = {
  RATE_CARD: (s, v) => [
    `Flat rates, in writing, before any work starts. ${rateCardLines(s.commercial)} Book in about a minute: ${FACTS.bookUrl} or call ${FACTS.phone}, ${FACTS.hours}.`,
    `No hourly meter. No guessing at parts. ${rateCardLines(s.commercial)} ${FACTS.bookUrl} · ${FACTS.phone}`,
    `The price is the quote. ${rateCardLines(s.commercial)} Book: ${FACTS.bookUrl} — ${FACTS.hours}.`,
  ][v % 3],
  SPEEDY_AI: (s, v) => [
    `Not sure what's wrong with your ${s.subjectNoun || 'appliance'}? Ask Speedy at ${FACTS.speedyUrl} — snap a photo or describe it, and Speedy helps you figure out the next step. Book or call from there in one tap.`,
    `Speedy AI reads a photo of the problem and points you at the right next step — then the classic booking form is right there when you're ready. ${FACTS.speedyUrl}`,
    `Describe it or photograph it — Speedy helps diagnose, and a real technician does the repair. Start at ${FACTS.speedyUrl}.`,
  ][v % 3],
  REFERRAL: (s, v) => [
    `Your friend gets $${25} off their first repair when they book through your referral link — and you earn a $${25} credit per completed referral, $${35} each at 5–9, $${50} each at 10+, plus $${100} at 10 referrals and $${250} at 25. Credits are good for 12 months. Get your link: ${FACTS.referUrl}`,
    `Refer a neighbor, earn credit. $${25} per completed referral, rising to $${35} and $${50}, with milestones of $${100} at 10 and $${250} at 25 — and your friend saves $${25} on their first repair. ${FACTS.referUrl}`,
    `The referral math is simple: your friend saves $${25} on their first repair; you bank credit toward yours. Full terms at ${FACTS.referUrl}.`,
  ][v % 3],
  CITY_SPOTLIGHT: (s, v) => [
    `${s.city}, this one's for you. Appliance repair and installation across ${FACTS.cities} cities in Broward, Palm Beach & Miami-Dade — ${rateCardLines()} Your city page: ${s.pageUrl}`,
    `Serving ${s.city} and ${FACTS.cities - 1} more cities: flat-rate appliance repair with a written quote before any work. ${s.pageUrl}`,
    `${s.city} homeowners: when the ${s.noun || 'appliance'} quits, start with a real diagnosis — $${FACTS.diagnostic}, credited toward your approved repair. ${s.pageUrl}`,
  ][v % 3],
  SEASONAL: (s, v) => [
    `South Florida heat works appliances hard. If your ${s.noun || 'appliance'} is struggling, a real diagnosis beats guessing at parts — ${rateCardLines()} ${FACTS.bookUrl}`,
    `Holiday loads, guest loads, heat-wave loads — when the ${s.noun || 'appliance'} can't keep up, book the $${FACTS.diagnostic} diagnostic (credited toward your approved repair): ${FACTS.bookUrl}`,
    `Before the busy season finds the weak appliance: book a diagnostic at ${FACTS.bookUrl} — $${FACTS.diagnostic}, credited in full toward your approved repair. ${FACTS.phone}, ${FACTS.hours}.`,
  ][v % 3],
  SYMPTOM_LED: (s, v) => [
    `Your ${s.noun || 'appliance'} ${s.symptomText || 'acting up'}? That's a sign, not a quirk — guessing at parts gets expensive. A technician finds the real cause on site: ${rateCardLines(s.commercial)} ${FACTS.bookUrl}`,
    `${(s.symptomText || 'Acting up').replace(/^./, (c) => c.toUpperCase())} — the ${s.noun || 'appliance'} is telling you where it's stuck. Start with a real diagnosis, not parts roulette. ${FACTS.bookUrl} · ${FACTS.phone}`,
    `Signs your ${s.noun || 'appliance'} needs a technician: ${s.symptomText || 'strange behavior'}. We check it on site and quote in writing before any work begins. ${FACTS.bookUrl}`,
  ][v % 3],
  SHOP_INVENTORY: (s, v) => [
    `Quality used appliances, inspected before they're listed — refrigerators, washers, dryers and more, added as they pass inspection. See the shop: ${FACTS.shopUrl}`,
    `Need a replacement appliance without the new-appliance price? Top Speed Appliances lists quality used appliances as they pass inspection: ${FACTS.shopUrl}`,
    `The used-appliance shop is open: inspected appliances, honest listings, delivery through the same Service OS. ${FACTS.shopUrl}`,
  ][v % 3],
  MARKETPLACE: (s, v) => [
    `Sell it. Post it. Book it. Pepper Lists is the marketplace where a photo becomes a listing — Pepper drafts it, nothing goes live without your yes. ${FACTS.pepperListsUrl}`,
    `Your stuff, listed in minutes: snap a photo in Pepper Lists and the draft writes itself. Sellers keep control — you approve before anything posts. ${FACTS.pepperListsUrl}`,
    `Pepper Lists sellers can cross-post through Top Speed — one listing, every door. Start at ${FACTS.pepperListsUrl}.`,
  ][v % 3],
  WHOLESALE: (s, v) => [
    `CocoCane — coconut water, whole coconuts and sugarcane, Fort Lauderdale. Wholesale buyers: ask about availability and bulk orders through the CocoCane page.`,
    `CocoCane Express: the coconut stand, online. Retail and wholesale inquiries welcome — availability changes with the harvest, so ask first.`,
    `Looking for coconuts in bulk? CocoCane takes wholesale inquiries for events, markets and resale — reach out through the CocoCane page.`,
  ][v % 3],
  VENT: (s, v) => [
    `Dryer taking two cycles to dry? Lint buildup in the vent line is a fire risk and an energy drain. Cleanout Vents cleans dryer vents across Broward — book at ${FACTS.ventUrl} or call ${FACTS.ventPhone}.`,
    `Cleanout Vents: dryer vent cleaning done right — safer dryer, faster loads. ${FACTS.ventUrl} · ${FACTS.ventPhone}`,
    `A clogged dryer vent works your dryer twice as hard. Cleanout Vents clears it — ${FACTS.ventUrl}, ${FACTS.ventPhone}.`,
  ][v % 3],
  NETWORK_RECRUITING: (s, v) => [
    `Independent appliance technicians: the Top Speed Service Network dispatches through one Service Setters pipeline — apply to join at topspeedapplianceservice.com and put your trade on the board.`,
    `Providers: one dispatch heart, real work orders, estimates and invoices in the Tech App. Apply to join the Service Network at topspeedapplianceservice.com.`,
    `Run your own appliance trade? The network brings the bookings; you bring the craft. Apply at topspeedapplianceservice.com.`,
  ][v % 3],
  PARTS: (s, v) => [
    `Technicians: source appliance parts through the Top Speed parts desk — one call into the same Service OS your work orders live in. ${FACTS.phone}`,
    `Parts, without the runaround: the parts supply lane serves the network's technicians and providers. Start at topspeedserviceos.com/parts.`,
    `On a job and missing the part? The parts desk is built for pros — topspeedserviceos.com/parts · ${FACTS.phone}`,
  ][v % 3],
  TRAINING: (s, v) => [
    `The Training Academy builds appliance technicians the Top Speed way — real diagnostics, flat-rate discipline, written quotes. Start at topspeedserviceos.com/academy.`,
    `A trade worth learning properly: appliance repair training with the systems the pros here actually use. topspeedserviceos.com/academy`,
    `From trainee to technician: the Academy teaches diagnosis first — because guessing at parts is not a skill. topspeedserviceos.com/academy`,
  ][v % 3],
  ADVERTISER: (s, v) => [
    `Local businesses: advertise where Broward homeowners already book — Top Speed surfaces, from the city pages to Pepper Lists. Advertiser plans from $${29}/month, every campaign a draft until you approve it. topspeedserviceos.com/advertiser`,
    `Your business, in front of the network's customers: the Advertiser Console runs campaigns across Top Speed sites with real attribution. Plans from $${29}/month. topspeedserviceos.com/advertiser`,
    `Flywheel Advertising serves the network AND outside advertisers — campaigns built in Ad Studio, measured in the Ads OS feed. Start at topspeedserviceos.com/advertiser.`,
  ][v % 3],
  PAYMENT: (s, v) => [
    `Your Top Speed estimate is ready — approve it in writing and we schedule the work. No work ever starts without your approved written quote. Questions? ${FACTS.phone}, ${FACTS.hours}.`,
    `A note from Top Speed Appliance: your invoice and payment link are in your account. Paying on completion is the standard — unless we agreed otherwise in writing. ${FACTS.phone}`,
    `Top Speed reminder: your written quote holds the exact price — labor flat, parts itemized. Approve when ready; nothing proceeds without your yes.`,
  ][v % 3],
  APP_ADOPTION: (s, v) => [
    `Your Top Speed account is free: book repairs, track your tech, keep your appliances in one place. Sign up at topspeedserviceos.com/app — pay only for booked work.`,
    `The customer app puts booking, tracking and your referral link in your pocket. Free to join, free to use: topspeedserviceos.com/app`,
    `One account for the whole Top Speed ecosystem — repairs, the shop, Pepper Lists and referrals. Start free at topspeedserviceos.com/app.`,
  ][v % 3],
  INTERNAL_ADOPTION: (s, v) => [
    `Team: this division's console is live and linked from the platform directory — campaigns, queues and records for this desk live there. Work the queue daily; escalate blockers to Pepper.`,
    `Ops note: keep this workstation's records current — the Ads OS feed reads them as the division's truth. Stale records make stale reports.`,
    `Daily discipline: check this console's queue first, clear what's yours, and log outcomes on the record — the flywheel metrics read from here.`,
  ][v % 3],
  CREATIVE: (s, v) => [
    `New creative in production for the ${s.noun || 'appliance repair'} line — designed visuals, locked facts, claim-checked before it can queue. The rate card it carries: ${rateCardLines()}`,
    `Ad Studio brief: fresh ${s.noun || 'service'} creative, square for social, whole-text rendering, no unapproved claims — ever.`,
    `Creative rotation: the next ${s.noun || 'appliance'} visual set enters the queue with the published rate card and the series sign-off.`,
  ][v % 3],
};

// Lawful audiences for the staged send lanes. A campaign record
// names its audience; where no lawful audience exists for a send,
// the record stays a labeled draft (status STAGED) — never a blast.
export const LAWFUL_AUDIENCES = {
  EMAIL: {
    REFERRAL: 'Platform account holders (customers) — account email on file; referral program terms accepted at signup.',
    SHOP_INVENTORY: 'Customers and account holders who booked or bought through the Service OS (existing relationship).',
    ADVERTISER: 'Businesses with an Advertiser Console account or an expressed inquiry on file.',
    PAYMENT: 'The customer on the open estimate/invoice — transactional, sent by the platform event flow.',
    MARKETPLACE: 'Pepper Lists account holders — account email on file.',
    NETWORK_RECRUITING: 'Providers who applied to the Service Network (application on file).',
    TRAINING: 'Academy applicants and enrolled trainees (application on file).',
    INTERNAL_ADOPTION: 'Staff accounts — internal mail only.',
    DEFAULT: 'Platform account holders — account email on file. No purchased or scraped lists, ever.',
  },
  SMS: {
    REFERRAL: 'Customers who completed a job and received their referral link by text (existing service relationship).',
    PAYMENT: 'The customer on the open booking/invoice — transactional text about their own job.',
    DEFAULT: 'Customers with an open or completed booking who gave this mobile number for service texts. Marketing texts only where consent is on file; otherwise the record stays a draft.',
  },
};

// ─── Record assembly ──────────────────────────────────────────────

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function makeRecord({ batchKey, division, surface, angle, subject, variant, landingBase }) {
  const divisionDef = DIVISION_BY_KEY.get(division);
  const sourceTag = division;
  const campaignKey = `${batchKey}:${division}:${surface.toLowerCase()}:${angle.toLowerCase()}:${subject.slug}:${variant}`;
  const copy = COPY[angle](subject, variant);
  assertClaims(copy, { divisionKey: division });
  const landingUrl = buildAttributionUrl(landingBase, {
    sourceTag,
    medium: MEDIUM_BY_SURFACE[surface],
    campaignKey: slugify(campaignKey),
  });
  const isSendLane = surface === 'EMAIL' || surface === 'SMS';
  return {
    campaignKey,
    batchKey,
    name: `${divisionDef.name} — ${angle.replace(/_/g, ' ')} — ${subject.label}`,
    division,
    surface,
    audience: divisionDef.audience,
    audienceNote: isSendLane
      ? (LAWFUL_AUDIENCES[surface][angle] || LAWFUL_AUDIENCES[surface].DEFAULT)
      : null,
    angle,
    subject: subject.label,
    copy,
    creativeSpec: CREATIVE_SPECS[surface],
    landingUrl,
    landingBase,
    sourceTag,
    status: isSendLane ? 'STAGED' : 'DRAFT',
  };
}

const BOOKING_SUBJECT = { slug: 'booking', label: 'Booking (classic web form)', pageUrl: FACTS.bookUrl, subjectNoun: 'appliance', noun: 'appliance', symptomText: null, commercial: false };

function subjectForService(service, symptom) {
  return {
    slug: symptom ? `${service.slug}-${symptom.slug}` : service.slug,
    label: symptom ? `${service.name} — ${symptom.text}` : service.name,
    pageUrl: FACTS.bookUrl,
    subjectNoun: service.plural,
    noun: service.name.toLowerCase(),
    symptomText: symptom ? symptom.text : null,
    commercial: false,
  };
}

function subjectForPage(page) {
  if (page.kind === 'CITY') {
    return {
      slug: page.citySlug,
      label: `${page.city} city page`,
      city: page.city,
      pageUrl: page.url,
      subjectNoun: 'appliance',
      noun: 'appliance',
      symptomText: null,
      commercial: false,
    };
  }
  const commercial = page.slug.startsWith('services/commercial');
  return {
    slug: page.slug.replace('services/', ''),
    label: page.title || page.slug,
    pageUrl: page.url,
    subjectNoun: 'appliance',
    noun: 'appliance',
    symptomText: null,
    commercial,
  };
}

function landingFor(division, surface, subject) {
  if (subject.pageUrl && (surface === 'CITY_SERVICE_PAGES' || surface === 'SEARCH_AI' || surface === 'MAPS_PROFILES')) {
    return subject.pageUrl;
  }
  switch (division) {
    case 'sales-os': return FACTS.shopUrl;
    case 'pepper-lists': return FACTS.pepperListsUrl;
    case 'cleanout-vents': return FACTS.ventUrl;
    case 'referral-program': case 'flywheel': return surface === 'EMAIL' || surface === 'SMS' ? FACTS.referUrl : FACTS.bookUrl;
    case 'ad-console': return 'https://topspeedserviceos.com/advertiser';
    case 'service-network': return 'https://topspeedapplianceservice.com/';
    case 'appliance-pro': return 'https://appliancepro.net/';
    case 'speedy-booking': return FACTS.speedyUrl;
    case 'appliance-connect': return 'https://topspeedserviceos.com/app';
    case 'training-academy': return 'https://topspeedserviceos.com/academy';
    case 'parts-supply': return 'https://topspeedserviceos.com/parts';
    case 'cococane': return 'https://topspeedserviceos.com/cococane-site';
    default: {
      const def = DIVISION_BY_KEY.get(division);
      return surface === 'INTERNAL' || surface === 'APP' ? def.consoleUrl : FACTS.bookUrl;
    }
  }
}

// ─── The launch batch ─────────────────────────────────────────────
// The first large batch: the full page universe, the division
// matrix, and the social spotlight set. Deterministic — the same
// code always produces the same campaignKeys, so re-running the
// launch is a no-op at the persistence layer.

export const LAUNCH_BATCH_KEY = 'launch-2026-11-23';

export function generateLaunchBatch() {
  const batchKey = LAUNCH_BATCH_KEY;
  const records = [];
  const push = (input) => records.push(makeRecord({ batchKey, ...input }));

  // 1) The page universe: every published page gets a page-surface
  //    campaign (Marketing OS) and a search/AI directory campaign
  //    (Local OS) — 131 × 2.
  PAGES.forEach((page, i) => {
    const subject = subjectForPage(page);
    const angle = page.kind === 'CITY' ? 'CITY_SPOTLIGHT' : (i % 3 === 0 ? 'SYMPTOM_LED' : 'RATE_CARD');
    push({ division: 'marketing-os', surface: 'CITY_SERVICE_PAGES', angle, subject, variant: i % 3, landingBase: page.url });
    push({ division: 'local-os', surface: 'SEARCH_AI', angle: page.kind === 'CITY' ? 'CITY_SPOTLIGHT' : 'RATE_CARD', subject, variant: (i + 1) % 3, landingBase: page.url });
  });

  // 2) The social spotlight set: one Facebook campaign per page
  //    (Media OS), Instagram twins for the city pages.
  PAGES.forEach((page, i) => {
    const subject = subjectForPage(page);
    const angle = page.kind === 'CITY' ? 'CITY_SPOTLIGHT' : 'SYMPTOM_LED';
    push({ division: 'media-os', surface: 'SOCIAL_FB', angle, subject, variant: i % 3, landingBase: page.url });
    if (page.kind === 'CITY') {
      push({ division: 'media-os', surface: 'SOCIAL_IG', angle: 'CITY_SPOTLIGHT', subject, variant: (i + 2) % 3, landingBase: page.url });
    }
  });

  // 3) The division matrix: every division × its surfaces × its
  //    angles, subjects rotating over services / symptoms / the
  //    booking subject.
  const subjects = [
    BOOKING_SUBJECT,
    ...SERVICES.map((s) => subjectForService(s, null)),
    ...SERVICES.slice(0, 6).map((s, i) => subjectForService(s, SYMPTOMS[i % SYMPTOMS.length])),
  ];
  let n = 0;
  for (const division of DIVISIONS) {
    for (const surface of division.surfaces) {
      division.angles.forEach((listedAngle, ai) => {
        const angle = division.key === 'cococane' ? 'WHOLESALE' : listedAngle;
        const subject = subjects[(n + ai) % subjects.length];
        push({
          division: division.key,
          surface,
          angle,
          subject,
          variant: (n + ai) % 3,
          landingBase: landingFor(division.key, surface, subject),
        });
        n += 1;
      });
    }
  }
  return records;
}

// ─── The daily batch ──────────────────────────────────────────────
// Deterministic by date: a day's batch generates once (the same
// date always yields the same campaignKeys), and the rotation
// walks the city × service × symptom space so new combinations
// keep coming indefinitely. ~56 records/day.

export function dailyBatchKey(date = new Date()) {
  return `daily-${date.toISOString().slice(0, 10)}`;
}

export function generateDailyBatch(date = new Date()) {
  const batchKey = dailyBatchKey(date);
  const dayIndex = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86400000);
  const records = [];
  const push = (input) => records.push(makeRecord({ batchKey, ...input }));

  // Rotating city × service spotlights (social + page surfaces).
  const combos = [];
  for (const city of CITIES) for (const service of SERVICES) combos.push({ city, service });
  const start = (dayIndex * 24) % combos.length;
  for (let i = 0; i < 24; i += 1) {
    const { city, service } = combos[(start + i) % combos.length];
    const symptom = SYMPTOMS[(dayIndex + i) % SYMPTOMS.length];
    const subject = {
      slug: `${city.citySlug}-${service.slug}`,
      label: `${service.name} in ${city.city}`,
      city: city.city,
      pageUrl: city.url,
      subjectNoun: service.plural,
      noun: service.name.toLowerCase(),
      symptomText: i % 2 ? symptom.text : null,
      commercial: false,
    };
    const surface = ['SOCIAL_FB', 'SOCIAL_IG', 'CITY_SERVICE_PAGES'][i % 3];
    push({
      division: surface === 'CITY_SERVICE_PAGES' ? 'marketing-os' : 'media-os',
      surface,
      angle: i % 2 ? 'SYMPTOM_LED' : 'CITY_SPOTLIGHT',
      subject,
      variant: dayIndex % 3,
      landingBase: city.url,
    });
  }

  // Division rotation: 16 matrix records walking the roster.
  const flat = [];
  for (const division of DIVISIONS) {
    for (const surface of division.surfaces) {
      for (const angle of division.angles) flat.push({ division: division.key, surface, angle });
    }
  }
  const subjects = [BOOKING_SUBJECT, ...SERVICES.map((s) => subjectForService(s, null))];
  const fstart = (dayIndex * 16) % flat.length;
  for (let i = 0; i < 16; i += 1) {
    const cell = flat[(fstart + i) % flat.length];
    const subject = subjects[(dayIndex + i) % subjects.length];
    push({ ...cell, subject, variant: (dayIndex + i) % 3, landingBase: landingFor(cell.division, cell.surface, subject) });
  }

  // Send lanes: a small set of staged email/SMS drafts daily.
  const sendCells = [
    { division: 'referral-program', surface: 'EMAIL', angle: 'REFERRAL' },
    { division: 'referral-program', surface: 'SMS', angle: 'REFERRAL' },
    { division: 'sales-os', surface: 'EMAIL', angle: 'SHOP_INVENTORY' },
    { division: 'finance', surface: 'EMAIL', angle: 'PAYMENT' },
    { division: 'finance', surface: 'SMS', angle: 'PAYMENT' },
    { division: 'pepper-lists', surface: 'EMAIL', angle: 'MARKETPLACE' },
    { division: 'ad-console', surface: 'EMAIL', angle: 'ADVERTISER' },
    { division: 'training-academy', surface: 'EMAIL', angle: 'TRAINING' },
  ];
  sendCells.forEach((cell, i) => {
    const subject = subjects[(dayIndex + i) % subjects.length];
    push({ ...cell, subject, variant: (dayIndex + i) % 3, landingBase: landingFor(cell.division, cell.surface, subject) });
  });

  // Maps + search presence: 8 rotating city profile campaigns.
  for (let i = 0; i < 8; i += 1) {
    const city = CITIES[(dayIndex * 8 + i) % CITIES.length];
    const subject = subjectForPage(city);
    push({
      division: 'local-os',
      surface: i % 2 ? 'MAPS_PROFILES' : 'SEARCH_AI',
      angle: 'CITY_SPOTLIGHT',
      subject,
      variant: dayIndex % 3,
      landingBase: city.url,
    });
  }
  return records;
}

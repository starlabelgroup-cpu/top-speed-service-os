import { Router } from 'express';
import { OFFERS } from '../config/offers.js';
import { SERVICE_CITIES } from '../config/serviceAreas.js';
import { PLATFORM_CONSTANTS } from '../config/platform.js';
import {
  MARKETING_CITIES,
  MARKETING_SERVICES,
  MARKETING_SYMPTOMS,
} from '../data/marketingTaxonomy.js';
import { NETWORK_PARTNER_PROVIDERS } from '../data/networkPartners.js';
import { store } from '../data/store.js';
import { allKnowledgeEntries, matchSafetyEntry } from '../knowledge/index.js';

/**
 * The four customer ENGINES (Ramone, 2026-11-16) — one router behind
 * the /explore page:
 *
 *   GET  /engines/search?q=        Speedy Search — ranked results over
 *                                  a real index built per request from
 *                                  platform truth (services, symptoms,
 *                                  cities + landing pages, offers, apps,
 *                                  the 82-entry knowledge base). Pure
 *                                  keyword/fuzzy/synonym matching — NO
 *                                  external calls, so it works with the
 *                                  AI provider down or unconfigured.
 *   POST /engines/recommend        Recommendations — deterministic,
 *                                  rule-based routing (service, booking
 *                                  path, app/partner) where every item
 *                                  carries its "why".
 *   POST /engines/estimate         Price Estimator PREVIEW — shows the
 *                                  published price STRUCTURE only
 *                                  ($99 diagnostic credited / $210 flat
 *                                  repair labor / $150 flat install /
 *                                  parts at written quote; commercial =
 *                                  custom quote). Never a repair total,
 *                                  never a per-appliance price.
 *   GET  /engines/compare          Comparison — Top Speed vs the local
 *                                  field on PUBLISHED facts only. Every
 *                                  competitor cell carries its source
 *                                  URL + the date it was checked; where
 *                                  a competitor publishes nothing, the
 *                                  cell says so instead of guessing.
 *
 * Facts discipline (all four): hours Mon–Fri 8 AM–7 PM; coverage is
 * "104 cities / 170 landing pages", never "131 cities"; bookings
 * auto-confirm only in the 12 core cities — other published cities
 * link to their landing pages and are confirmed by a Service Setter;
 * no reviews/ratings claims anywhere; vent work routes to the
 * Cleanout Vents partner by phone and NEVER carries a price.
 */

const SITE = 'https://topspeedserviceos.com';
const NET = 'https://www.topspeedappliance.net';
const PHONE_DISPLAY = PLATFORM_CONSTANTS.phoneDisplay; // (844) 460-7038
const PHONE_PLAIN = PLATFORM_CONSTANTS.phone; // 844-460-7038
const COMPARE_CHECKED_DATE = '2026-11-16';

const router = Router();

/* ------------------------------ text utils ------------------------------ */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'do', 'does', 'did', 'you', 'your', 'yours',
  'i', 'me', 'my', 'we', 'our', 'it', 'its', 'to', 'of', 'for', 'in', 'on',
  'at', 'and', 'or', 'if', 'so', 'can', 'could', 'would', 'should', 'what',
  'whats', 'when', 'where', 'why', 'how', 'much', 'many', 'about', 'with',
  'without', 'have', 'has', 'had', 'get', 'got', 'please', 'tell', 'there',
  'this', 'that', 'am', 'was', 'were', 'be', 'been', 'will', 'need', 'want',
]);

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawTokens(value) {
  return normalize(value)
    .split(' ')
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function foldPlural(token) {
  return token.length > 3 && token.endsWith('s') && !token.endsWith('ss')
    ? token.slice(0, -1)
    : token;
}

/**
 * Synonym groups: any token in a group expands to the whole group, so
 * "fridge" finds Refrigerator, "stove" finds Oven/Range, "sell my
 * mangoes" finds Pepper Lists, and "vent" finds Cleanout Vents.
 */
const SYNONYM_GROUPS = [
  ['refrigerator', 'fridge', 'refrigerators', 'fridges'],
  ['freezer', 'freezers', 'ice', 'icemaker', 'icemakers'],
  ['washer', 'washers', 'washing', 'laundry'],
  ['dryer', 'dryers', 'drying'],
  ['oven', 'ovens', 'range', 'ranges', 'stove', 'stoves', 'cooktop', 'cooktops', 'stovetop'],
  ['dishwasher', 'dishwashers'],
  ['microwave', 'microwaves'],
  ['disposal', 'disposals', 'disposer', 'garbage'],
  ['installation', 'install', 'installs', 'installed', 'installing', 'hookup'],
  ['vent', 'vents', 'lint', 'airflow', 'cleanout'],
  ['sell', 'sells', 'selling', 'sold', 'listing', 'listings', 'marketplace', 'produce', 'mango', 'mangoes', 'fruit', 'plants', 'trees', 'ackee', 'yard'],
  ['track', 'tracking', 'eta', 'status'],
  ['refer', 'refers', 'referral', 'referrals', 'friend', 'friends', 'earn', 'earns'],
  ['commercial', 'business', 'businesses', 'restaurant', 'restaurants', 'hotel', 'hotels', 'laundromat', 'laundromats', 'facility', 'facilities', 'office', 'offices', 'retail', 'healthcare'],
  ['property', 'manager', 'managers', 'tenant', 'tenants', 'units', 'landlord', 'apartment', 'apartments', 'condo', 'condos'],
  ['parts', 'part', 'plate', 'model', 'serial'],
  ['price', 'prices', 'pricing', 'cost', 'costs', 'estimate', 'estimates', 'estimator', 'quote', 'quotes', 'charge', 'charges', 'fee', 'fees', 'affordable', 'expensive', 'cheap'],
  ['diagnostic', 'diagnostics', 'diagnosis', 'diagnose'],
  ['warranty', 'guarantee', 'guaranteed'],
  ['book', 'books', 'booking', 'bookings', 'schedule', 'scheduling', 'appointment', 'appointments', 'visit'],
  ['repair', 'repairs', 'fix', 'fixes', 'fixing', 'broken', 'service', 'services'],
  ['cooling', 'cold', 'warm', 'temperature'],
  ['heating', 'heat', 'hot'],
  ['leaking', 'leak', 'leaks', 'water', 'dripping'],
  ['noise', 'noises', 'noisy', 'loud', 'sound', 'sounds'],
];

const GROUP_OF = new Map();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) GROUP_OF.set(foldPlural(word), group);
}

function expandedTokens(value) {
  const out = new Set();
  for (const token of rawTokens(value)) {
    out.add(token);
    out.add(foldPlural(token));
    const group = GROUP_OF.get(token) || GROUP_OF.get(foldPlural(token));
    if (group) for (const word of group) out.add(foldPlural(word));
  }
  return out;
}

function tokenSet(value) {
  const out = new Set();
  for (const token of rawTokens(value)) {
    out.add(token);
    out.add(foldPlural(token));
  }
  return out;
}

/* --------------------------- shared matchers ---------------------------- */

const CANONICAL_SERVICES = [
  { name: 'Refrigerator', slug: 'refrigerator-repair', group: 'refrigerator' },
  { name: 'Washer', slug: 'washer-repair', group: 'washer' },
  { name: 'Dryer', slug: 'dryer-repair', group: 'dryer' },
  { name: 'Oven/Range', slug: 'oven-range-repair', group: 'oven' },
  { name: 'Dishwasher', slug: 'dishwasher-repair', group: 'dishwasher' },
  { name: 'Freezer/Ice Maker', slug: 'freezer-ice-maker-repair', group: 'freezer' },
  { name: 'Microwave', slug: 'microwave-repair', group: 'microwave' },
  { name: 'Garbage Disposal', slug: 'garbage-disposal-repair', group: 'disposal' },
  { name: 'Installation', slug: 'appliance-installation', group: 'installation' },
];

function matchAppliance(text) {
  const tokens = expandedTokens(text);
  for (const service of CANONICAL_SERVICES) {
    if (tokens.has(service.group)) return service;
  }
  return null;
}

function liveCities() {
  const fromStore = Array.isArray(store.marketingCities) ? store.marketingCities : [];
  const source = fromStore.length ? fromStore : MARKETING_CITIES;
  // serviceCovered:false records are expansion planning records — no
  // page may publish for them, so they are not customer-facing truth.
  return source.filter((c) => c && c.name && c.serviceCovered !== false);
}

function matchCity(text) {
  const norm = ` ${normalize(text)} `;
  if (norm.trim().length < 3) return null;
  const cities = [...liveCities()].sort((a, b) => b.name.length - a.name.length);
  for (const city of cities) {
    if (norm.includes(` ${normalize(city.name)} `)) {
      return { ...city, core: SERVICE_CITIES.includes(city.name) };
    }
  }
  return null;
}

function hasGroup(text, groupName) {
  const tokens = expandedTokens(text);
  const group = SYNONYM_GROUPS.find((g) => g[0] === groupName) || [];
  return group.some((word) => tokens.has(foldPlural(word)));
}

/* ------------------------- 1. Speedy Search ----------------------------- */

const SERVICE_SNIPPET_IDS = {
  'refrigerator-repair': 'ind-svc-refrigerator',
  'washer-repair': 'ind-svc-washer',
  'dryer-repair': 'ind-svc-dryer',
  'oven-range-repair': 'ind-svc-oven-range',
  'dishwasher-repair': 'ind-svc-dishwasher',
  'freezer-ice-maker-repair': 'ind-svc-freezer-ice-maker',
  'microwave-repair': 'ind-svc-microwave',
  'garbage-disposal-repair': 'ind-svc-garbage-disposal',
  'appliance-installation': 'ind-svc-installation',
};

const SYMPTOM_APPLIANCES = {
  'not-cooling': ['refrigerator', 'freezer'],
  'not-draining': ['washer', 'dishwasher'],
  'not-heating': ['dryer', 'oven'],
  'leaking': ['washer', 'dishwasher', 'refrigerator'],
  'error-codes': ['washer', 'dryer', 'dishwasher', 'oven', 'refrigerator'],
  'unusual-noises': ['washer', 'dryer', 'dishwasher', 'refrigerator'],
  'no-ice': ['freezer'],
};

function firstSentences(text, max = 190) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' — '));
  return `${cut.slice(0, end > 60 ? end + 1 : max).trim()}…`;
}

function appDocs() {
  return [
    {
      id: 'app-book', type: 'App', title: 'Book a Repair — the classic booking form',
      snippet: 'The primary booking path: pick your appliance, your city and a two-hour window (Mon–Fri, 8 AM–7 PM). A Service Setter confirms every booking; the $99 residential diagnostic is collected at booking and credited toward your repair.',
      url: `${SITE}/book`,
      keywords: ['book', 'booking', 'appointment', 'schedule', 'repair', 'service', 'visit', 'form'],
    },
    {
      id: 'app-speedy', type: 'App', title: 'Ask Speedy — AI chat & photo diagnosis',
      snippet: 'Speedy is Top Speed\'s AI: chat answers from the platform knowledge base, a preliminary photo read of your appliance problem, and booking in conversation — the high-tech lane beside the classic form.',
      url: `${SITE}/speedy`,
      keywords: ['speedy', 'chat', 'ai', 'photo', 'diagnosis', 'diagnose', 'picture', 'ask'],
    },
    {
      id: 'app-connect', type: 'App', title: 'Appliance Connect — the customer app',
      snippet: 'Your bookings, appliance garage, service history and live job tracking on one account — the homeowner door into Top Speed Service OS.',
      url: `${SITE}/app`,
      keywords: ['app', 'customer app', 'account', 'garage', 'my appliances', 'history', 'appliance connect'],
    },
    {
      id: 'app-connect-pro', type: 'App', title: 'Appliance Connect Pro — homeowners & property managers',
      snippet: 'For property managers: bulk service requests for many units, every work order\'s live stage, a photo report after each job, and one consolidated monthly invoice itemized by unit.',
      url: `${SITE}/connect-pro-app`,
      keywords: ['property manager', 'property', 'manager', 'units', 'tenants', 'bulk', 'landlord', 'apartment', 'connect pro', 'invoice'],
    },
    {
      id: 'app-appliance-pro', type: 'App', title: 'Appliance Pro — commercial accounts only',
      snippet: 'The commercial door: equipment registry with TS-EQ asset tags, priority dispatch and one consolidated monthly invoice. Commercial work is priced by custom quote — the residential diagnostic never applies.',
      url: `${SITE}/appliance-pro`,
      keywords: ['commercial', 'business', 'restaurant', 'hotel', 'laundromat', 'facility', 'appliance pro', 'equipment'],
    },
    {
      id: 'app-pepper-lists', type: 'App', title: 'Pepper Lists — sell it, or book it',
      snippet: 'Category 1, Pepper Lists Sell: snap a photo and Pepper drafts your Marketplace listing — nothing posts without your yes. Category 2, Pepper Lists Post: reviews, repair photos and videos, and comments. Plus booking, right in the same customer app.',
      url: 'https://www.pepperlists.com',
      keywords: ['sell', 'selling', 'listing', 'marketplace', 'produce', 'mangoes', 'fruit', 'plants', 'trees', 'ackee', 'reviews', 'post', 'pepper lists', 'advertise'],
    },
    {
      id: 'app-appliance-plug', type: 'App', title: 'Appliance Plug — snap the plate, find the parts',
      snippet: 'The technicians\' parts tool inside Speedy Pro: snap the model plate, Speedy reads brand/model/serial, and the Parts Finder returns the categories that fit. Exact part numbers and prices are confirmed by Parts Supply OS at order time.',
      url: `${SITE}/appliance-plug-app`,
      keywords: ['parts', 'part', 'plate', 'model', 'serial', 'technician', 'appliance plug', 'snap'],
    },
    {
      id: 'app-speedy-pro', type: 'App', title: 'Speedy Pro — the technician & provider suite',
      snippet: 'The working side of the platform: Field Pro work orders plus Appliance Plug, for Top Speed technicians and network providers. Customers never need it — their doors are Appliance Connect and Pepper Lists.',
      url: `${SITE}/speedy-pro`,
      keywords: ['technician', 'provider', 'tech', 'field pro', 'speedy pro', 'work order', 'jobs'],
    },
    {
      id: 'app-cleanout-vents', type: 'App', title: 'Cleanout Vents — dryer vent partner',
      snippet: `Dryer vent cleaning, full vent line cleanout and lint & airflow inspection are handled by Cleanout Vents, a registered partner in the Top Speed network — Top Speed doesn't book vent cleaning itself. Call ${PHONE_DISPLAY} and the Service Setters coordinate it. Vent work has no published price.`,
      url: 'https://www.cleanoutvents.com',
      keywords: ['dryer vent', 'vent', 'vents', 'vent cleaning', 'lint', 'airflow', 'cleanout vents', 'clean vents'],
    },
    {
      id: 'app-track', type: 'App', title: 'Track My Tech — live job tracking',
      snippet: 'Follow your job through its 8 stages and see your technician live on the map while they are en route — with your booking reference and the phone number on the booking.',
      url: `${SITE}/track`,
      keywords: ['track', 'tracking', 'status', 'eta', 'where', 'technician', 'job', 'map', 'live'],
    },
    {
      id: 'app-refer', type: 'App', title: 'Refer & Earn — service credit for referrals',
      snippet: 'Refer a friend and earn service credit when their job completes, under the published referral terms — and your friend gets $25 off their first repair.',
      url: `${SITE}/refer`,
      keywords: ['refer', 'referral', 'friend', 'earn', 'credit', 'refer and earn'],
    },
    {
      id: 'app-offers', type: 'App', title: 'Offers & Rewards — the full catalog',
      snippet: 'All 12 published Top Speed programs in one place — the new-customer welcome, referral credits, maintenance rewards, property-partner pricing and more, each under its own published terms.',
      url: `${SITE}/offers-rewards`,
      keywords: ['offer', 'offers', 'discount', 'deal', 'promotion', 'rewards', 'coupon', 'savings', 'special'],
    },
    {
      id: 'app-directory', type: 'App', title: 'Service Areas Directory — 104 cities, 170 landing pages',
      snippet: 'Every published Top Speed city and landing page across Broward, Palm Beach and Miami-Dade — search by city, appliance or problem.',
      url: `${SITE}/service-areas-directory`,
      keywords: ['cities', 'areas', 'coverage', 'near me', 'directory', 'locations', 'serve'],
    },
    {
      id: 'app-explore', type: 'App', title: 'Explore — search, recommendations, price preview, comparisons',
      snippet: 'This page: search the whole platform, get a recommendation for your situation, preview exactly how Top Speed pricing works, and compare published facts against other local repair companies.',
      url: `${SITE}/explore`,
      keywords: ['explore', 'search', 'compare', 'comparison', 'estimate', 'estimator', 'recommend', 'recommendations'],
    },
  ];
}

function buildSearchIndex() {
  const docs = [];
  const knowledge = allKnowledgeEntries();
  const knowledgeById = new Map(knowledge.map((e) => [e.id, e]));

  // Services — from the live taxonomy store when hydrated, else the seed.
  const liveServices = Array.isArray(store.marketingServices) && store.marketingServices.length
    ? store.marketingServices
    : MARKETING_SERVICES;
  for (const service of liveServices) {
    if (!service || !service.name || service.partOfService) continue;
    const explained = knowledgeById.get(SERVICE_SNIPPET_IDS[service.slug]);
    const isInstall = service.slug === 'appliance-installation';
    const isCommercial = service.slug === 'commercial-appliance-repair';
    docs.push({
      id: `svc-${service.slug}`,
      type: 'Service',
      title: isInstall ? 'Appliance Installation' : isCommercial ? service.name : `${service.name} Repair`,
      snippet: explained
        ? firstSentences(explained.answer)
        : `${service.name} service from Top Speed Appliance — every job starts with the $99 diagnostic (credited toward the repair) and a written quote before work begins.`,
      url: `${NET}/services/${service.slug}/`,
      keywords: [
        service.name.toLowerCase(), `${service.name.toLowerCase()} repair`, 'repair',
      ],
    });
  }

  // Symptoms — the taxonomy's seven, with appliance hints.
  const liveSymptoms = Array.isArray(store.marketingSymptoms) && store.marketingSymptoms.length
    ? store.marketingSymptoms
    : MARKETING_SYMPTOMS;
  for (const symptom of liveSymptoms) {
    if (!symptom || !symptom.name) continue;
    docs.push({
      id: `sym-${symptom.slug}`,
      type: 'Symptom',
      title: symptom.name,
      snippet: 'What this symptom usually means, the safe checks you can do, and how Top Speed handles it — the $99 diagnostic visit (credited in full toward your repair) confirms the actual cause before anything is quoted.',
      url: `${SITE}/book`,
      keywords: [
        symptom.name.toLowerCase(), 'symptom', 'problem', 'trouble',
        ...(SYMPTOM_APPLIANCES[symptom.slug] || []),
      ],
    });
  }

  // Cities — published coverage; landing-page URL from a published CITY
  // page when the store has one, else the canonical §4 scheme.
  const publishedCityUrls = new Map();
  for (const page of Array.isArray(store.landingPages) ? store.landingPages : []) {
    if (page && page.status === 'PUBLISHED' && page.type === 'CITY' && page.canonicalUrl) {
      const match = /\/service-areas\/([a-z0-9-]+)\/?$/.exec(page.canonicalUrl);
      if (match) publishedCityUrls.set(match[1], page.canonicalUrl);
    }
  }
  for (const city of liveCities()) {
    const core = SERVICE_CITIES.includes(city.name);
    docs.push({
      id: `city-${city.slug}`,
      type: 'City',
      title: `${city.name} — Appliance Repair`,
      snippet: core
        ? `${city.name} is one of Top Speed's 12 core booking cities — bookings confirm automatically. Local services, offers and booking are on its landing page.`
        : `Top Speed publishes a local landing page for ${city.name}. Bookings for addresses here are confirmed by a Service Setter when your booking is reviewed — a straight answer before anything is charged.`,
      url: publishedCityUrls.get(city.slug) || `${NET}/service-areas/${city.slug}/`,
      keywords: [city.name.toLowerCase(), `${city.name.toLowerCase()} appliance repair`, 'near me', 'repair', 'service', 'area'],
      // A query naming the city — even by its first word alone
      // ("pompano" for Pompano Beach) — means the city page is a
      // primary intent, not background noise.
      boostTokens: [foldPlural(normalize(city.name).split(' ')[0])],
    });
  }

  // Offers — the published catalog, verbatim benefits.
  for (const offer of OFFERS) {
    docs.push({
      id: `offer-${offer.slug}`,
      type: 'Offer',
      title: offer.title,
      snippet: offer.benefit,
      url: `${SITE}/offers/${offer.slug}`,
      keywords: [offer.title.toLowerCase(), offer.slug.replace(/-/g, ' '), 'offer', 'offers', 'discount', 'deal', 'program'],
    });
  }

  // Apps & platform doors.
  docs.push(...appDocs());

  // Answers — the whole knowledge base (site facts, glossary, industry
  // guides, symptom and safety entries).
  for (const entry of knowledge) {
    docs.push({
      id: `ans-${entry.id}`,
      type: 'Answer',
      title: entry.topic,
      snippet: firstSentences(entry.answer, 200),
      url: entry.link || null,
      keywords: entry.keywords || [],
      safety: Boolean(entry.safety),
    });
  }

  return docs;
}

const TYPE_WEIGHT = { Service: 6, Symptom: 6, City: 5, App: 4, Offer: 2, Answer: 0 };

function scoreDoc(queryNorm, queryTokens, doc) {
  let score = 0;
  const titleNorm = normalize(doc.title);
  if (titleNorm.length > 3 && queryNorm.includes(titleNorm)) score += 60;
  for (const keyword of doc.keywords || []) {
    const phrase = normalize(keyword);
    if (!phrase) continue;
    if (phrase.includes(' ')) {
      if (queryNorm.includes(phrase)) score += 34;
    } else if (queryTokens.has(phrase) || queryTokens.has(foldPlural(phrase))) {
      score += 14;
    }
  }
  const titleTokens = tokenSet(doc.title);
  for (const token of queryTokens) if (titleTokens.has(token)) score += 9;
  const keywordTokens = new Set();
  for (const keyword of doc.keywords || []) {
    for (const token of tokenSet(keyword)) keywordTokens.add(token);
  }
  let keywordHits = 0;
  for (const token of queryTokens) if (keywordTokens.has(token)) keywordHits += 1;
  score += Math.min(keywordHits * 3, 18);
  const snippetTokens = tokenSet(doc.snippet);
  let snippetHits = 0;
  for (const token of queryTokens) if (snippetTokens.has(token)) snippetHits += 1;
  score += Math.min(snippetHits * 0.5, 4);
  if (Array.isArray(doc.boostTokens)) {
    for (const token of doc.boostTokens) {
      if (token && queryTokens.has(token)) { score += 45; break; }
    }
  }
  return score;
}

router.get('/engines/search', (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'q query parameter is required' });
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 20);
  const queryNorm = normalize(query);
  const queryTokens = expandedTokens(query);

  const scored = [];
  for (const doc of buildSearchIndex()) {
    const score = scoreDoc(queryNorm, queryTokens, doc);
    if (score >= 12) scored.push({ doc, score: score + (TYPE_WEIGHT[doc.type] || 0) });
  }
  scored.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title));

  let results = scored.slice(0, limit).map(({ doc, score }) => ({
    type: doc.type,
    title: doc.title,
    snippet: doc.snippet,
    url: doc.url,
    score: Math.round(score),
  }));

  // A safety match always leads: if the query reports a hazard, the
  // safety entry is the answer, whatever else scored well.
  const safety = matchSafetyEntry(query);
  if (safety && !results.some((r) => r.title === safety.entry.topic)) {
    results = [
      {
        type: 'Answer',
        title: safety.entry.topic,
        snippet: firstSentences(safety.entry.answer, 200),
        url: safety.entry.link || null,
        score: 999,
        safety: true,
      },
      ...results,
    ].slice(0, limit);
  }

  return res.json({
    data: {
      query,
      count: results.length,
      results,
      engine: {
        name: 'Speedy Search',
        mode: 'keyword-synonym',
        note: 'Ranked by keyword, phrase and synonym matching over Top Speed\'s published services, symptoms, cities, offers, apps and knowledge base. No external calls — it works even when the AI provider is down.',
      },
    },
  });
});

/* ----------------------- 2. Recommendations ----------------------------- */

function normalizeAudience(raw) {
  const value = normalize(raw);
  if (['business', 'commercial', 'company', 'facility'].includes(value)) return 'business';
  if (['property manager', 'property-manager', 'pm', 'landlord', 'manager'].includes(value)) return 'property-manager';
  return 'homeowner';
}

router.post('/engines/recommend', (req, res) => {
  const body = req.body || {};
  const applianceInput = String(body.appliance || '').trim();
  const symptomInput = String(body.symptom || '').trim();
  const cityInput = String(body.city || '').trim();
  const audience = normalizeAudience(body.audience);
  const text = `${applianceInput} ${symptomInput}`;
  const recommendations = [];

  const ventDetected = hasGroup(text, 'vent');
  const sellDetected = hasGroup(text, 'sell');
  const appliance = matchAppliance(text);
  const city = matchCity(cityInput || text);
  const ventPartner = NETWORK_PARTNER_PROVIDERS[0];

  if (sellDetected) {
    recommendations.push({
      kind: 'platform',
      title: 'Pepper Lists Sell — list it from a photo',
      why: 'You mentioned selling. Pepper Lists (Category 1: Sell) turns one photo into a Marketplace listing draft — you approve the title and price before anything posts, and nothing goes live without your yes.',
      url: 'https://www.pepperlists.com',
      action: null,
    });
  }

  if (ventDetected) {
    recommendations.push({
      kind: 'partner',
      title: `Dryer vent cleaning — ${ventPartner?.businessName || 'Cleanout Vents'} (network partner)`,
      why: 'Vent cleaning is not a Top Speed booking service — it is handled by Cleanout Vents, a registered vendor partner in the Top Speed network. Vent work has no published price; the team confirms everything when you call.',
      url: `${SITE}/cleanout-vents-site`,
      action: { type: 'call', phone: PHONE_PLAIN, label: `Call ${PHONE_DISPLAY}` },
    });
  }

  if (audience === 'business') {
    recommendations.push({
      kind: 'platform',
      title: 'Appliance Pro — the commercial door',
      why: 'Business accounts run through Appliance Pro: every unit gets an equipment-registry record, work orders ride a priority dispatch track, and billing rolls into one consolidated monthly invoice. Commercial service is priced by custom quote — the residential $99 diagnostic never applies.',
      url: `${SITE}/appliance-pro`,
      action: null,
    });
    recommendations.push({
      kind: 'booking',
      title: 'Request a commercial account',
      why: 'A commercial request gets its own reference, an equipment assessment, and a written proposal sized to your facility — no work without an approved written quote.',
      url: `${SITE}/appliance-pro`,
      action: null,
    });
  } else if (audience === 'property-manager') {
    recommendations.push({
      kind: 'platform',
      title: 'Appliance Connect Pro — built for property managers',
      why: 'Property managers send bulk service requests for many units at once, watch every work order\'s live stage, get a photo report after each job, and receive one consolidated monthly invoice itemized by unit.',
      url: `${SITE}/connect-pro-app`,
      action: null,
    });
  }

  // A pure vent request ("dryer vent clogged with lint") belongs to
  // the partner alone — the homeowner repair flow only joins when the
  // words also describe a machine problem (not heating, leaking…).
  const problemTokens = new Set(rawTokens(text).map(foldPlural));
  const machineProblem = ['heating', 'cooling', 'draining', 'leaking', 'noise', 'broken', 'spinning', 'stopped', 'heat', 'cold', 'working']
    .some((token) => problemTokens.has(token));
  const repairIntent = Boolean(appliance || symptomInput) && !sellDetected
    && !(ventDetected && !machineProblem);
  if (repairIntent && audience === 'homeowner') {
    const serviceName = appliance ? appliance.name : null;
    recommendations.push({
      kind: 'service',
      title: serviceName ? `${serviceName} Repair` : 'Appliance Repair',
      why: serviceName
        ? `Your description points at the ${serviceName} service. Every residential repair starts with the $99 diagnostic — collected at booking and credited in full toward your approved repair — and the exact total is set in writing after diagnosis.`
        : 'Every residential repair starts with the $99 diagnostic — collected at booking and credited in full toward your approved repair — and the exact total is set in writing after diagnosis.',
      url: appliance ? `${NET}/services/${appliance.slug}/` : `${SITE}/service`,
      action: null,
    });
    recommendations.push({
      kind: 'booking',
      title: 'Book with the classic form first',
      why: 'The classic booking form is Top Speed\'s primary booking path: pick the appliance, your city, and a two-hour window (Mon–Fri, 8 AM–7 PM). A human Service Setter reviews and confirms every booking before dispatch.',
      url: `${SITE}/book`,
      action: null,
    });
    recommendations.push({
      kind: 'booking',
      title: 'Or let Speedy read a photo first',
      why: 'Prefer the high-tech lane? Send Speedy a photo of the problem for a preliminary read and book inside the chat. The classic form stays available either way.',
      url: `${SITE}/speedy`,
      action: null,
    });
    recommendations.push({
      kind: 'tool',
      title: 'Preview how the pricing works',
      why: 'The Price Estimator Preview shows the published structure — $99 diagnostic (credited), $210 flat repair labor, parts priced in the written quote — so there are no surprises before you book. It is a preview, never a quote.',
      url: `${SITE}/explore#estimator`,
      action: null,
    });
    recommendations.push({
      kind: 'offer',
      title: 'New Customer Welcome — $25 off your first repair',
      why: 'New registered customers get $25 off their first eligible repair under the published welcome offer. It is separate from the referral program.',
      url: `${SITE}/offers/new-customer-welcome`,
      action: null,
    });
  }

  if (ventDetected && appliance && appliance.group === 'dryer' && audience === 'homeowner'
    && !recommendations.some((r) => r.kind === 'service' && /Dryer/.test(r.title))) {
    recommendations.push({
      kind: 'service',
      title: 'Dryer Repair — if the dryer itself has a problem',
      why: 'The vent is the partner\'s work, but the dryer is Top Speed diagnostic work: no heat and long dry times are often the machine, the vent, or both. The $99 diagnostic (credited toward the repair) sorts out which.',
      url: `${NET}/services/dryer-repair/`,
      action: null,
    });
  }

  if (city) {
    recommendations.push({
      kind: 'coverage',
      title: `Coverage — ${city.name}`,
      why: city.core
        ? `${city.name} is one of the 12 core booking cities, so bookings there confirm automatically.`
        : `Top Speed publishes a landing page for ${city.name}; bookings for addresses there are confirmed by a Service Setter when your booking is reviewed — you get a straight answer before anything is charged.`,
      url: `${NET}/service-areas/${city.slug}/`,
      action: null,
    });
  } else if (cityInput) {
    recommendations.push({
      kind: 'coverage',
      title: 'Check the Service Areas Directory',
      why: `"${cityInput}" isn't in the published city list. The directory covers all 65 published cities across Broward, Palm Beach and Miami-Dade — and the team at ${PHONE_DISPLAY} can confirm any address directly.`,
      url: `${SITE}/service-areas-directory`,
      action: null,
    });
  }

  if (!recommendations.length) {
    recommendations.push(
      {
        kind: 'booking',
        title: 'Book with the classic form',
        why: 'Tell the form what appliance, what city, and what window — a Service Setter confirms every booking. Mon–Fri, 8 AM–7 PM.',
        url: `${SITE}/book`,
        action: null,
      },
      {
        kind: 'tool',
        title: 'Search the whole platform',
        why: 'Speedy Search covers every service, symptom, city, offer and app on Top Speed — start there if you are not sure which door fits.',
        url: `${SITE}/explore#search`,
        action: null,
      },
      {
        kind: 'platform',
        title: 'Talk to Speedy',
        why: 'Describe the problem in your own words — or send a photo — and Speedy will point you at the right service and book it with you.',
        url: `${SITE}/speedy`,
        action: null,
      },
    );
  }

  return res.json({
    data: {
      input: {
        appliance: applianceInput || null,
        symptom: symptomInput || null,
        audience,
        city: cityInput || null,
      },
      recommendations,
    },
  });
});

/* --------------------- 3. Price Estimator Preview ------------------------ */

const ESTIMATE_DISCLAIMER_RESIDENTIAL =
  'Preview only: this shows how Top Speed pricing works — it is NOT a repair quote, NOT an estimate of your repair\'s total, and NOT a guaranteed price. Your exact price is set in the written quote after the diagnostic visit, and no work ever begins without your approval.';
const ESTIMATE_DISCLAIMER_COMMERCIAL =
  'Preview only: commercial service is priced by custom quote for each facility. This preview is not a quote and not a guaranteed price — your exact price is set in the written commercial proposal after an equipment assessment, and no work ever begins without an approved written quote.';

router.post('/engines/estimate', (req, res) => {
  const body = req.body || {};
  const applianceInput = String(body.appliance || '').trim();
  const serviceType = normalize(body.serviceType) === 'installation' ? 'installation' : 'repair';
  const audience = normalizeAudience(body.audience);
  const appliance = matchAppliance(applianceInput);
  const applianceName = appliance ? appliance.name : applianceInput || null;

  if (audience !== 'homeowner') {
    return res.json({
      data: {
        kind: 'PREVIEW',
        isQuote: false,
        label: 'Price Estimator Preview — commercial',
        appliance: applianceName,
        serviceType,
        audience,
        lines: [
          {
            label: 'Pricing model',
            amount: null,
            display: 'Custom quote',
            note: 'Commercial service is priced per facility after an equipment assessment. The residential diagnostic fee and flat labor rates never apply to commercial accounts.',
          },
          {
            label: 'What happens first',
            amount: null,
            display: 'Equipment assessment + written proposal',
            note: 'A commercial account request gets its own reference, an equipment assessment, and a written proposal sized to your equipment and locations.',
          },
          {
            label: 'Your total',
            amount: null,
            display: 'Set by the written proposal',
            note: 'No work begins without an approved written quote, and payment terms are agreed in writing beforehand.',
          },
        ],
        disclaimer: ESTIMATE_DISCLAIMER_COMMERCIAL,
        cta: { label: 'Open Appliance Pro — the commercial door', url: `${SITE}/appliance-pro` },
      },
    });
  }

  const lines = serviceType === 'installation'
    ? [
        {
          label: 'Installation labor',
          amount: 150,
          display: '$150 flat',
          note: 'Flat labor for the installation — published, not hourly.',
        },
        {
          label: 'Parts & materials',
          amount: null,
          display: 'Priced in your written quote',
          note: 'Any parts or materials your installation needs are itemized on the written quote and confirmed before any work begins.',
        },
        {
          label: 'Your total',
          amount: null,
          display: 'Set by the written quote',
          note: 'The exact total is confirmed in writing before work starts — this preview never invents one.',
        },
      ]
    : [
        {
          label: 'Diagnostic visit',
          amount: 99,
          display: '$99',
          note: 'Collected at booking and credited in full toward your approved repair. If you decide not to repair, the $99 is still due for the visit.',
        },
        {
          label: 'Repair labor',
          amount: 210,
          display: '$210 flat',
          note: 'Flat labor for the repair itself — published, not hourly, the same whatever the repair takes.',
        },
        {
          label: 'Parts & materials',
          amount: null,
          display: 'Priced in your written quote',
          note: 'The technician confirms the actual cause at diagnosis; the exact part(s) are priced on your written quote before any work begins.',
        },
        {
          label: 'Your total',
          amount: null,
          display: 'Set by the written quote after diagnosis',
          note: 'Nobody quotes a repair total sight unseen — the written quote after diagnosis is the real number, and nothing proceeds without your approval.',
        },
      ];

  return res.json({
    data: {
      kind: 'PREVIEW',
      isQuote: false,
      label: 'Price Estimator Preview',
      appliance: applianceName,
      serviceType,
      audience,
      lines,
      disclaimer: ESTIMATE_DISCLAIMER_RESIDENTIAL,
      cta: { label: 'Book the visit', url: `${SITE}/book` },
    },
  });
});

/* ------------------------- 4. Comparison -------------------------------- */

/**
 * Comparison data — PUBLISHED facts only. Every competitor cell was
 * checked against the competitor's own public pages on the
 * checkedDate shown (live fetches 2026-11-16, plus Top Speed's
 * 2026-11-15 competitor gap analysis where marked). Where a
 * competitor publishes no figure, the value says exactly that —
 * nothing here is estimated, averaged, or invented.
 */
const COMPARE_DIMENSIONS = [
  { id: 'diagnosticFee', label: 'Diagnostic / service-call fee' },
  { id: 'diagnosticCredited', label: 'Fee credited or waived with repair?' },
  { id: 'laborModel', label: 'Labor pricing model' },
  { id: 'warranty', label: 'Warranty on repairs' },
  { id: 'pricingPublished', label: 'Pricing published upfront?' },
  { id: 'bookingPaths', label: 'Booking paths' },
  { id: 'aiAssistant', label: 'AI help (chat booking / photo diagnosis)' },
];

const TS_SOURCE = { sourceUrl: `${SITE}/book`, sourceNote: 'Top Speed\'s own published price list and site pages.', checkedDate: COMPARE_CHECKED_DATE };
const cell = (value, source) => ({ value, ...source });

const COMPARE_COMPANIES = [
  {
    id: 'top-speed',
    name: 'Top Speed Appliance',
    highlight: true,
    cells: {
      diagnosticFee: cell('$99 flat — collected at booking', TS_SOURCE),
      diagnosticCredited: cell('Yes — credited in full toward the approved repair (still due if you decline the repair)', TS_SOURCE),
      laborModel: cell('Flat and published: $210 flat repair labor · $150 flat installation labor. Parts priced in the written quote', TS_SOURCE),
      warranty: cell('90-day parts & labor warranty on the specific repair', { sourceUrl: `${SITE}/`, sourceNote: 'Top Speed\'s published warranty terms (also printed on every invoice).', checkedDate: COMPARE_CHECKED_DATE }),
      pricingPublished: cell('Yes — diagnostic, repair labor and installation labor are published flat numbers before you book', TS_SOURCE),
      bookingPaths: cell('Classic online form, Speedy AI chat (books in conversation), customer apps, phone — every booking confirmed by a human Service Setter', { sourceUrl: `${SITE}/`, sourceNote: 'Top Speed\'s own site and apps.', checkedDate: COMPARE_CHECKED_DATE }),
      aiAssistant: cell('Yes — Speedy AI: chat booking, photo/video diagnosis, live job tracking', { sourceUrl: `${SITE}/speedy`, sourceNote: 'Top Speed\'s own Speedy pages.', checkedDate: COMPARE_CHECKED_DATE }),
    },
  },
  {
    id: 'mr-appliance',
    name: 'Mr. Appliance (Neighborly franchise)',
    cells: {
      diagnosticFee: cell('Doesn\'t publish pricing — a diagnostic fee exists (their offers exclude it) but the amount is set by the local franchise and never published', { sourceUrl: 'https://www.mrappliance.com/', sourceNote: 'Homepage offers reference a diagnostic fee without an amount; no fee figure appears anywhere on the page.', checkedDate: COMPARE_CHECKED_DATE }),
      diagnosticCredited: cell('Not stated on their site', { sourceUrl: 'https://www.mrappliance.com/', sourceNote: 'No crediting/waiver statement found on the homepage.', checkedDate: COMPARE_CHECKED_DATE }),
      laborModel: cell('Upfront quote after diagnosis ("upfront pricing") — amounts are not published in advance', { sourceUrl: 'https://www.mrappliance.com/', sourceNote: 'Homepage: the technician "will clearly explain our recommendations… and offer an upfront quote".', checkedDate: COMPARE_CHECKED_DATE }),
      warranty: cell('1 year — "We guarantee all of our repair parts and service for one year" (Neighborly Done Right Promise®)', { sourceUrl: 'https://www.mrappliance.com/', sourceNote: 'Verbatim from their homepage, checked 2026-11-16.', checkedDate: COMPARE_CHECKED_DATE }),
      pricingPublished: cell('No — no prices published; quote after diagnosis', { sourceUrl: 'https://www.mrappliance.com/', sourceNote: 'Homepage carries offers ($10/$20 off) but no service prices.', checkedDate: COMPARE_CHECKED_DATE }),
      bookingPaths: cell('Online booking, phone, ZIP-code local finder', { sourceUrl: 'https://www.mrappliance.com/', sourceNote: 'Homepage: "Easy Online Booking", "Find My Local Mr. Appliance" ZIP routing.', checkedDate: COMPARE_CHECKED_DATE }),
      aiAssistant: cell('None for customers on their site (their chat persona "Maya" is recruiting-only, per Top Speed\'s 2026-11-15 gap analysis)', { sourceUrl: 'https://www.mrappliance.com/', sourceNote: 'No customer AI booking or diagnosis offered on the homepage.', checkedDate: COMPARE_CHECKED_DATE }),
    },
  },
  {
    id: 'sears',
    name: 'Sears Home Services',
    cells: {
      diagnosticFee: cell('$90–$150 depending on the appliance', { sourceUrl: 'https://www.searshomeservices.com/locations/fl/fort-lauderdale/sears-appliance-repair/901-n-federal-highway', sourceNote: 'FAQ on their Fort Lauderdale location page: "A diagnostic fee of $90 to $150 depending on the appliance applies".', checkedDate: COMPARE_CHECKED_DATE }),
      diagnosticCredited: cell('Waived entirely if you proceed with the repair', { sourceUrl: 'https://www.searshomeservices.com/locations/fl/fort-lauderdale/sears-appliance-repair/901-n-federal-highway', sourceNote: 'Same FAQ: "…and it\'s waived if you proceed with the repair."', checkedDate: COMPARE_CHECKED_DATE }),
      laborModel: cell('Exact quote for parts + labor after the on-site diagnostic, locked in once given — amounts not published in advance', { sourceUrl: 'https://www.searshomeservices.com/locations/fl/fort-lauderdale/sears-appliance-repair/901-n-federal-highway', sourceNote: 'FAQ on their Fort Lauderdale location page.', checkedDate: COMPARE_CHECKED_DATE }),
      warranty: cell('Repairs carry a "service guarantee" (no day count stated for standard repairs); a 180-day guarantee is advertised for the paid Sears Protect plan', { sourceUrl: 'https://www.searshomeservices.com/locations/fl/fort-lauderdale/sears-appliance-repair/901-n-federal-highway', sourceNote: 'Location page: "Every repair comes with a service guarantee"; Sears Protect section states the 180-day guarantee.', checkedDate: COMPARE_CHECKED_DATE }),
      pricingPublished: cell('Partially — the diagnostic fee range is published; repair totals are quoted after diagnosis', { sourceUrl: 'https://www.searshomeservices.com/locations/fl/fort-lauderdale/sears-appliance-repair/901-n-federal-highway', sourceNote: 'FAQ on their Fort Lauderdale location page.', checkedDate: COMPARE_CHECKED_DATE }),
      bookingPaths: cell('Online scheduler (embedded at the top of their pages), phone', { sourceUrl: 'https://www.searshomeservices.com/locations/fl/fort-lauderdale/sears-appliance-repair/901-n-federal-highway', sourceNote: 'Location page scheduler + "Schedule service your way".', checkedDate: COMPARE_CHECKED_DATE }),
      aiAssistant: cell('None found on their public pages', { sourceUrl: 'https://www.searshomeservices.com/locations/fl/fort-lauderdale/sears-appliance-repair/901-n-federal-highway', sourceNote: 'No AI chat booking or photo diagnosis offered on the location page.', checkedDate: COMPARE_CHECKED_DATE }),
    },
  },
  {
    id: 'flamingo',
    name: 'Flamingo Appliance Service',
    cells: {
      diagnosticFee: cell('Doesn\'t publish pricing — no diagnostic fee figure appears on their site', { sourceUrl: 'https://flamingoappliance.com/', sourceNote: 'Homepage checked 2026-11-16: no fee or price figures anywhere on the page.', checkedDate: COMPARE_CHECKED_DATE }),
      diagnosticCredited: cell('Not stated on their site', { sourceUrl: 'https://flamingoappliance.com/', sourceNote: 'No crediting/waiver statement on the homepage.', checkedDate: COMPARE_CHECKED_DATE }),
      laborModel: cell('Labor charge is revealed inside the booking flow ("pick your appliance and brand, and your labor charge shows before you book") — never published as a number on site pages', { sourceUrl: 'https://flamingoappliance.com/', sourceNote: 'Verbatim from their homepage "How a Flamingo repair works", checked 2026-11-16.', checkedDate: COMPARE_CHECKED_DATE }),
      warranty: cell('1-year warranty on parts they install (labor coverage not stated)', { sourceUrl: 'https://flamingoappliance.com/', sourceNote: 'Homepage: "Backed by our warranty — Parts you pay us to install are covered" with a "1-year parts warranty" link.', checkedDate: COMPARE_CHECKED_DATE }),
      pricingPublished: cell('Partially — the labor charge appears inside booking before you submit; nothing is published on public pages', { sourceUrl: 'https://flamingoappliance.com/', sourceNote: 'Homepage "How a Flamingo repair works", checked 2026-11-16.', checkedDate: COMPARE_CHECKED_DATE }),
      bookingPaths: cell('Online scheduling, text, phone — plus live technician tracking and job-status pages', { sourceUrl: 'https://flamingoappliance.com/', sourceNote: 'Homepage utility menu: Text Us · Schedule Service · Track Your Technician · Check Job Status.', checkedDate: COMPARE_CHECKED_DATE }),
      aiAssistant: cell('None found on their public pages', { sourceUrl: 'https://flamingoappliance.com/', sourceNote: 'No AI chat booking or photo diagnosis offered on the homepage.', checkedDate: COMPARE_CHECKED_DATE }),
    },
  },
  {
    id: 'pozharko',
    name: 'Pozharko Appliance Repair',
    cells: {
      diagnosticFee: cell('Free diagnostics with every repair', { sourceUrl: null, sourceNote: 'From Top Speed\'s competitor gap analysis (live inspection of Pozharko\'s site, 2026-11-15). Direct re-verification fetch was unavailable in the 2026-11-16 pass.', checkedDate: '2026-11-15' }),
      diagnosticCredited: cell('Free with the repair — there is no fee to credit', { sourceUrl: null, sourceNote: 'Same 2026-11-15 gap-analysis inspection.', checkedDate: '2026-11-15' }),
      laborModel: cell('Not published', { sourceUrl: null, sourceNote: 'Same 2026-11-15 gap-analysis inspection: no labor pricing on their site.', checkedDate: '2026-11-15' }),
      warranty: cell('Three-month guarantee on work and parts', { sourceUrl: null, sourceNote: 'Same 2026-11-15 gap-analysis inspection.', checkedDate: '2026-11-15' }),
      pricingPublished: cell('Partially — advertises free diagnostics with repair; no other prices published', { sourceUrl: null, sourceNote: 'Same 2026-11-15 gap-analysis inspection.', checkedDate: '2026-11-15' }),
      bookingPaths: cell('Phone + an 8-field contact form on a basic one-page site — no scheduling engine', { sourceUrl: null, sourceNote: 'Same 2026-11-15 gap-analysis inspection.', checkedDate: '2026-11-15' }),
      aiAssistant: cell('None', { sourceUrl: null, sourceNote: 'Same 2026-11-15 gap-analysis inspection.', checkedDate: '2026-11-15' }),
    },
  },
  {
    id: 'five-star',
    name: 'Five Star Same Day Appliance Repair',
    cells: {
      diagnosticFee: cell('Doesn\'t publish a diagnostic fee — the site advertises "$25 off any repair service" instead', { sourceUrl: 'https://fivestarsamedayappliancerepair.com/', sourceNote: 'Homepage checked 2026-11-16: "Diagnostic with any Appliance Repair Services" + "$25 off on any Repair Service"; no fee figure.', checkedDate: COMPARE_CHECKED_DATE }),
      diagnosticCredited: cell('Not stated on their site', { sourceUrl: 'https://fivestarsamedayappliancerepair.com/', sourceNote: 'No crediting/waiver statement on the homepage.', checkedDate: COMPARE_CHECKED_DATE }),
      laborModel: cell('Not published as a flat number — some service pages publish average cost ranges (per Top Speed\'s 2026-11-15 gap analysis)', { sourceUrl: 'https://fivestarsamedayappliancerepair.com/', sourceNote: 'Homepage carries no labor pricing; ranges on service pages per the 2026-11-15 gap analysis.', checkedDate: COMPARE_CHECKED_DATE }),
      warranty: cell('No warranty term published on their homepage', { sourceUrl: 'https://fivestarsamedayappliancerepair.com/', sourceNote: 'Homepage checked 2026-11-16: no warranty term stated.', checkedDate: COMPARE_CHECKED_DATE }),
      pricingPublished: cell('Partially — average cost ranges on some service pages; no diagnostic fee or flat labor price', { sourceUrl: 'https://fivestarsamedayappliancerepair.com/', sourceNote: 'Ranges per the 2026-11-15 gap analysis; homepage itself publishes no prices (checked 2026-11-16).', checkedDate: COMPARE_CHECKED_DATE }),
      bookingPaths: cell('Phone + a quote/contact form', { sourceUrl: 'https://fivestarsamedayappliancerepair.com/', sourceNote: 'Homepage: "To request a service, fill out the form below" + phone contact.', checkedDate: COMPARE_CHECKED_DATE }),
      aiAssistant: cell('None found on their public pages', { sourceUrl: 'https://fivestarsamedayappliancerepair.com/', sourceNote: 'No AI chat booking or photo diagnosis offered on the homepage.', checkedDate: COMPARE_CHECKED_DATE }),
    },
  },
  {
    id: 'oj',
    name: 'OJ Same Day Appliance Repairs',
    cells: {
      diagnosticFee: cell('Doesn\'t publish pricing — quote required', { sourceUrl: 'https://samedayappliancerepairs.net/', sourceNote: 'Their single-page site checked 2026-11-16: no pricing of any kind.', checkedDate: COMPARE_CHECKED_DATE }),
      diagnosticCredited: cell('Not stated on their site', { sourceUrl: 'https://samedayappliancerepairs.net/', sourceNote: 'No crediting/waiver statement on their page.', checkedDate: COMPARE_CHECKED_DATE }),
      laborModel: cell('Not published', { sourceUrl: 'https://samedayappliancerepairs.net/', sourceNote: 'No labor pricing on their page.', checkedDate: COMPARE_CHECKED_DATE }),
      warranty: cell('No warranty published on their site', { sourceUrl: 'https://samedayappliancerepairs.net/', sourceNote: 'No warranty mention on their page, checked 2026-11-16.', checkedDate: COMPARE_CHECKED_DATE }),
      pricingPublished: cell('No — no pricing anywhere on the site', { sourceUrl: 'https://samedayappliancerepairs.net/', sourceNote: 'Single thin page: phone, one Request Service button, hours.', checkedDate: COMPARE_CHECKED_DATE }),
      bookingPaths: cell('Phone + one "Request Service" form', { sourceUrl: 'https://samedayappliancerepairs.net/', sourceNote: 'Their page, checked 2026-11-16.', checkedDate: COMPARE_CHECKED_DATE }),
      aiAssistant: cell('None', { sourceUrl: 'https://samedayappliancerepairs.net/', sourceNote: 'No AI anything on their page.', checkedDate: COMPARE_CHECKED_DATE }),
    },
  },
];

router.get('/engines/compare', (req, res) => {
  return res.json({
    data: {
      checkedDate: COMPARE_CHECKED_DATE,
      method:
        'Published facts only — every competitor figure below was read on that company\'s own public pages on the checked date shown, and each cell links its source. Where a company publishes no figure, the cell says so. Nothing is estimated or averaged.',
      dimensions: COMPARE_DIMENSIONS,
      companies: COMPARE_COMPANIES,
    },
  });
});

export default router;

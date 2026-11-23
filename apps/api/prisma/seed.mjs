// Top Speed Service OS — database seed.
//
// Creates the platform tenant (Top Speed Appliance LLC) with the SAME fixed
// UUID the in-memory skeleton used (PLATFORM_COMPANY_ID), plus the three
// demo provider companies and providers the dispatch matcher was tuned
// against. Idempotent: safe to re-run (upserts by id).
//
// Run:  DATABASE_URL=... node prisma/seed.mjs     (or: npm run db:seed)
import { PrismaClient } from '@prisma/client';
import {
  MARKETING_BRANDS,
  MARKETING_CITIES,
  MARKETING_SERVICES,
  MARKETING_SYMPTOMS,
} from '../src/data/marketingTaxonomy.js';
import { buildPhase2DraftPages } from '../src/data/phase2DraftPages.js';
import { GOOGLE_ACCOUNT_SEEDS } from '../src/data/googleAccounts.js';
import { MEDIA_CONTENT_SEEDS } from '../src/data/mediaOsSeed.js';
import { NETWORK_PARTNER_COMPANIES, NETWORK_PARTNER_PROVIDERS } from '../src/data/networkPartners.js';
import { PARTNER_VENDOR_SUPPLIERS } from '../src/data/partsPartners.js';
import {
  LAUNCH_BATCH_KEY,
  dailyBatchKey,
  generateDailyBatch,
  generateLaunchBatch,
} from '../src/services/campaignFactory.js';

const prisma = new PrismaClient();

const PLATFORM_COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const providerCompanies = {
  alpha: '20000000-0000-4000-8000-000000000001',
  beta: '20000000-0000-4000-8000-000000000002',
  gamma: '20000000-0000-4000-8000-000000000003',
};

const companies = [
  { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance LLC', slug: 'top-speed-appliance', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  { id: providerCompanies.alpha, name: 'Broward Rapid Refrigeration', slug: 'broward-rapid-refrigeration', type: 'NETWORK_BUSINESS' },
  { id: providerCompanies.beta, name: 'Plantation Home Appliance Pros', slug: 'plantation-home-appliance-pros', type: 'NETWORK_BUSINESS' },
  { id: providerCompanies.gamma, name: 'Top Speed Field Team', slug: 'top-speed-field-team', type: 'INDEPENDENT_PROVIDER' },
];

const providers = [
  {
    // Score reset (Ramone, 2026-11-16): every provider starts at zero.
    // No rating is seeded — rating stays null ("no rating yet") until
    // real reviews from real completed jobs earn one. The invented
    // 4.9 / 4.8 / 4.8 values these records carried were removed here
    // and zeroed on existing rows by migration
    // 20261116140000_score_reset_zero.
    id: '30000000-0000-4000-8000-000000000001',
    companyId: providerCompanies.alpha,
    businessName: 'Broward Rapid Refrigeration',
    type: 'NETWORK_BUSINESS',
    specialties: ['Refrigerator', 'Freezer / Ice Maker'],
    serviceCities: ['Sunrise', 'Plantation', 'Fort Lauderdale', 'Lauderhill', 'Tamarac', 'Davie'],
    rating: null,
    active: true,
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    companyId: providerCompanies.beta,
    businessName: 'Plantation Home Appliance Pros',
    type: 'NETWORK_BUSINESS',
    specialties: ['Washer', 'Dryer', 'Dishwasher'],
    serviceCities: ['Plantation', 'Sunrise', 'Davie', 'Coral Springs', 'Fort Lauderdale'],
    rating: null,
    active: true,
  },
  {
    id: '30000000-0000-4000-8000-000000000003',
    companyId: providerCompanies.gamma,
    businessName: 'Top Speed Field Team',
    companyCrew: true,
    type: 'INDEPENDENT_PROVIDER',
    specialties: ['Refrigerator', 'Washer', 'Dryer', 'Oven / Range', 'Dishwasher', 'Freezer / Ice Maker', 'Microwave', 'Garbage Disposal', 'Installation'],
    serviceCities: ['Lauderhill', 'Plantation', 'Sunrise', 'Tamarac', 'Fort Lauderdale', 'Lauderdale Lakes', 'North Lauderdale', 'Davie', 'Coral Springs', 'Pompano Beach', 'Oakland Park', 'Margate'],
    rating: null,
    active: true,
  },
];

for (const company of companies) {
  await prisma.company.upsert({ where: { id: company.id }, update: {}, create: company });
}
for (const provider of providers) {
  await prisma.provider.upsert({ where: { id: provider.id }, update: {}, create: provider });
}

// Vendor partner businesses (2026-11-14): Cleanout Vents, the network's
// dryer-vent-cleaning partner, registered in the same Company/Provider
// tables as the trio above. Create-only by id (empty update), and the
// API's boot hydrator runs the same ensure pass — see
// src/data/networkPartners.js for the full fact sheet. No vent-cleaning
// prices and no rating exist; neither is ever seeded.
for (const company of NETWORK_PARTNER_COMPANIES) {
  await prisma.company.upsert({ where: { id: company.id }, update: {}, create: company });
}
for (const provider of NETWORK_PARTNER_PROVIDERS) {
  await prisma.provider.upsert({ where: { id: provider.id }, update: {}, create: provider });
}

// Parts Supply OS partnership vendor distributors (2026-11-14):
// Appliance Plus Parts Supply, the first supplier record in Parts
// Supply OS, registered as a partner distributor. Create-only by id
// (empty update); the API's boot hydrator runs the same ensure pass —
// see src/data/partsPartners.js for the full fact sheet. No contact
// details exist for this vendor; none are seeded.
for (const supplier of PARTNER_VENDOR_SUPPLIERS) {
  await prisma.supplier.upsert({ where: { id: supplier.id }, update: {}, create: supplier });
}

// Top Speed Marketing OS taxonomy (blueprint §3). Idempotent: upsert by
// slug with an empty update, so Studio edits survive redeploys. The API's
// cold-start hydrator runs the same seed-if-missing pass.
const marketingTaxonomy = [
  ['marketingCity', MARKETING_CITIES.map((c, i) => ({ name: c.name, slug: c.slug, state: 'FL', serviceCovered: c.serviceCovered, sortOrder: i }))],
  ['marketingBrand', MARKETING_BRANDS.map((b, i) => ({ name: b.name, slug: b.slug, sortOrder: i }))],
  ['marketingService', MARKETING_SERVICES.map((s, i) => ({ name: s.name, slug: s.slug, partOfService: s.partOfService, sortOrder: i }))],
  ['marketingSymptom', MARKETING_SYMPTOMS.map((s, i) => ({ name: s.name, slug: s.slug, sortOrder: i }))],
];
for (const [model, rows] of marketingTaxonomy) {
  for (const row of rows) {
    await prisma[model].upsert({ where: { slug: row.slug }, update: {}, create: row });
  }
}

// Top Speed Marketing OS — Phase 2 draft landing pages (Fusion absorb,
// 2026-11-12). Create-only: a page is inserted the first time its
// canonicalUrl is seen and NEVER modified by reseeding afterwards, so
// Studio edits, reviews and status changes are safe. Every seeded page
// starts IN_REVIEW — the seed cannot publish — with a v1 PageVersion
// snapshot in the same shape the Studio writes (routes/marketingOs.js).
const citiesBySlug = new Map((await prisma.marketingCity.findMany()).map((c) => [c.slug, c]));
const servicesBySlug = new Map((await prisma.marketingService.findMany()).map((s) => [s.slug, s]));
let phase2Created = 0;
let phase2Skipped = 0;
for (const spec of buildPhase2DraftPages()) {
  const existing = await prisma.landingPage.findUnique({ where: { canonicalUrl: spec.canonicalUrl } });
  if (existing) continue;
  const city = spec.citySlug ? citiesBySlug.get(spec.citySlug) : null;
  const service = spec.serviceSlug ? servicesBySlug.get(spec.serviceSlug) : null;
  if ((spec.citySlug && !city) || (spec.serviceSlug && !service)) {
    phase2Skipped += 1;
    console.warn(`Phase 2 seed: skipping ${spec.canonicalUrl} — taxonomy record missing.`);
    continue;
  }
  const page = await prisma.landingPage.create({
    data: {
      type: spec.type,
      cityId: city ? city.id : null,
      brandId: null,
      serviceId: service ? service.id : null,
      slug: spec.slug,
      canonicalUrl: spec.canonicalUrl,
      title: spec.title,
      metaDescription: spec.metaDescription,
      status: 'IN_REVIEW',
      sections: spec.sections,
      createdBy: 'phase2-seed',
      updatedBy: 'phase2-seed',
    },
  });
  await prisma.pageVersion.create({
    data: {
      pageId: page.id,
      version: 1,
      snapshot: {
        type: page.type,
        cityId: page.cityId,
        brandId: null,
        serviceId: page.serviceId,
        slug: page.slug,
        canonicalUrl: page.canonicalUrl,
        title: page.title,
        metaDescription: page.metaDescription,
        status: page.status,
        sections: spec.sections,
      },
      note: 'Phase 2 draft — Fusion absorb (2026-11-12). Awaiting Studio review; not published.',
      createdBy: 'phase2-seed',
    },
  });
  phase2Created += 1;
}

// ─── Phase 2 draft correction: Coral Springs office wording ─────────────
// The Phase 2 drafts were first seeded (commit 35185f0) with the Coral
// Springs city page claiming the office is IN Coral Springs. The source
// text was corrected in commit e69e371 — the office is 6810 N State Rd 7,
// Suite 341, Coconut Creek, FL 33073 — but the create-only seed above never
// rewrites existing records, so the already-seeded draft still carries the
// old wording. This step repairs ONLY records that are still exactly the
// seed's own output:
//   - created by the phase2 seed (createdBy 'phase2-seed'),
//   - still unpublished drafts (status DRAFT/IN_REVIEW, publishedAt null),
//   - whose version history contains NO non-seed edit — a Studio save by a
//     human writes a PageVersion under another createdBy, and any record
//     with one is skipped ENTIRELY, even if the old strings remain, and
//   - whose field values still EXACTLY equal the pre-fix seeded strings
//     (full-value match per field; diverged content is never rewritten).
// Replacement values are read from the CURRENT buildPhase2DraftPages()
// source, and the correction itself is recorded as a new PageVersion.
// Idempotent: once corrected, the old strings no longer match, so re-runs
// change nothing.
const PHASE2_SEED_AUTHORS = ['phase2-seed', 'phase2-seed-correction'];
let phase2Corrected = 0;
{
  const csSpec = buildPhase2DraftPages().find((s) => s.citySlug === 'coral-springs');
  const csHero = csSpec ? csSpec.sections.find((s) => s.type === 'hero') : null;
  const csFaq = csSpec ? csSpec.sections.find((s) => s.type === 'faq') : null;
  // [pre-fix seeded string, current source string] — full-value pairs.
  const correctionPairs = csSpec
    ? [
        [
          'Appliance repair in Coral Springs, FL, from the locally based Top Speed Appliance team. Online booking, Service Setter confirmation, live tracking — $99 diagnostic credited toward your repair.',
          csSpec.metaDescription,
        ],
        [
          'Coral Springs is a master-planned city of family neighborhoods, and many of its homes are reaching the age where the original washer, dryer, and refrigerator all start asking for attention at once. Top Speed Appliance is based right here — our office is in Coral Springs — so local bookings get the full platform: online booking, a Service Setter confirmation call, and live job tracking.',
          csHero ? csHero.body : null,
        ],
        ['Are you actually based in Coral Springs?', csFaq ? csFaq.items[0].q : null],
        [
          'Yes. Top Speed Appliance LLC operates from Coconut Creek / Coral Springs, and Coral Springs is one of our twelve covered Broward service cities.',
          csFaq ? csFaq.items[0].a : null,
        ],
      ].filter(([, next]) => typeof next === 'string')
    : [];
  const correctionMap = new Map(correctionPairs);
  const applyCorrections = (value, state) => {
    if (typeof value === 'string') {
      const next = correctionMap.get(value);
      if (next !== undefined) {
        state.hits += 1;
        return next;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => applyCorrections(v, state));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = applyCorrections(v, state);
      return out;
    }
    return value;
  };
  if (correctionMap.size) {
    const candidates = await prisma.landingPage.findMany({
      where: { createdBy: 'phase2-seed', status: { in: ['DRAFT', 'IN_REVIEW'] }, publishedAt: null },
      include: { versions: { select: { version: true, createdBy: true } } },
    });
    for (const page of candidates) {
      const hasNonSeedEdit = page.versions.some((v) => !PHASE2_SEED_AUTHORS.includes(v.createdBy));
      if (hasNonSeedEdit) continue;
      const state = { hits: 0 };
      const nextMeta = applyCorrections(page.metaDescription, state);
      const nextSections = applyCorrections(page.sections, state);
      if (!state.hits) continue;
      const nextVersion = Math.max(0, ...page.versions.map((v) => v.version)) + 1;
      await prisma.landingPage.update({
        where: { id: page.id },
        data: { metaDescription: nextMeta, sections: nextSections, updatedBy: 'phase2-seed-correction' },
      });
      await prisma.pageVersion.create({
        data: {
          pageId: page.id,
          version: nextVersion,
          snapshot: {
            type: page.type,
            cityId: page.cityId,
            brandId: page.brandId,
            serviceId: page.serviceId,
            slug: page.slug,
            canonicalUrl: page.canonicalUrl,
            title: page.title,
            metaDescription: nextMeta,
            status: page.status,
            sections: nextSections,
          },
          note: 'Seed correction (2026-11-12): Coral Springs office wording — the office is 6810 N State Rd 7, Suite 341, Coconut Creek, FL 33073 (source fix e69e371). Exact-match repair of an unedited phase2-seed draft.',
          createdBy: 'phase2-seed-correction',
        },
      });
      phase2Corrected += 1;
      console.log(`Phase 2 correction: updated office wording on ${page.canonicalUrl} (${state.hits} field(s) replaced).`);
    }
  }
}

// ─── Phase 3 publish: the seven remaining problem pages (2026-11-23) ────
// The 2026-11-13 tri-county problem-page batch defined 36 symptom pages
// in buildPhase2DraftPages(); 29 were published through the Studio the
// same day. These seven were seeded as drafts and never published, which
// left the live count at 124 against the platform's stated 131
// (COVERAGE_AFTER_RING2.pagesBefore in data/expansionCities.js, surfaced
// by the Ads OS platforms feed). Owner directive 2026-11-23 ("Do
// everything" — publish the missing pages, do not correct the claim
// down) closes the gap by publishing exactly these seven.
//
// Guards:
//   - ONLY the seven canonicalUrls listed here are ever touched.
//   - A record is published ONLY if it has never been published before:
//     status DRAFT or IN_REVIEW and publishedAt null, with a non-empty
//     title and sections. A page that WAS published and later taken
//     down (status UNPUBLISHED, or publishedAt set) is never touched,
//     and neither is an already-PUBLISHED record. The record's current
//     content is published as-is — this step never edits title, meta
//     or sections. (The first version of this step, 52a865d, also
//     required the record to still be the seed's own untouched draft;
//     the production records turned out to carry Studio-batch
//     authorship, so that requirement skipped all seven and was
//     dropped — the never-published test above is the guard that
//     matters, and the owner's 2026-11-23 directive is the publish
//     decision for exactly these seven URLs.)
//   - v3 (2026-11-23): the e4bc63e production build log showed all
//     seven records are in fact status IN_REVIEW with publishedAt
//     ALREADY SET — a review-state leftover, not a human takedown
//     (a takedown is UNPUBLISHED, still never touched above). v3
//     flips exactly that state to PUBLISHED, keeping the record's
//     original publishedAt, and records the flip as a phase3-publish
//     PageVersion. Every other guard is unchanged: DRAFT with
//     publishedAt set still skips, UNPUBLISHED still skips, empty
//     content still skips, no other URL is ever touched.
//   - If a record does not exist at all, it is created from the current
//     Phase 2 spec first (same create-only shape as the Phase 2 seed)
//     and then published in the same step.
//   - The publish is recorded as a PageVersion (createdBy
//     'phase3-publish') in the same snapshot shape the Studio writes.
// Idempotent: once PUBLISHED, later runs skip every record.
const PHASE3_PUBLISH_URLS = [
  'https://topspeedappliance.net/services/refrigerator-repair/leaking/',
  'https://topspeedappliance.net/services/refrigerator-repair/unusual-noises/',
  'https://topspeedappliance.net/services/refrigerator-repair/error-codes/',
  'https://topspeedappliance.net/services/washer-repair/leaking/',
  'https://topspeedappliance.net/services/washer-repair/unusual-noises/',
  'https://topspeedappliance.net/services/washer-repair/error-codes/',
  'https://topspeedappliance.net/services/dryer-repair/unusual-noises/',
];
let phase3Published = 0;
{
  const specsByUrl = new Map(buildPhase2DraftPages().map((s) => [s.canonicalUrl, s]));
  for (const url of PHASE3_PUBLISH_URLS) {
    const spec = specsByUrl.get(url);
    if (!spec) {
      console.warn(`Phase 3 publish: skipping ${url} — no Phase 2 spec defines it.`);
      continue;
    }
    let page = await prisma.landingPage.findUnique({
      where: { canonicalUrl: url },
      include: { versions: { select: { version: true, createdBy: true } } },
    });
    if (!page) {
      const service = spec.serviceSlug ? servicesBySlug.get(spec.serviceSlug) : null;
      if (spec.serviceSlug && !service) {
        console.warn(`Phase 3 publish: skipping ${url} — taxonomy record missing.`);
        continue;
      }
      page = await prisma.landingPage.create({
        data: {
          type: spec.type,
          cityId: null,
          brandId: null,
          serviceId: service ? service.id : null,
          slug: spec.slug,
          canonicalUrl: spec.canonicalUrl,
          title: spec.title,
          metaDescription: spec.metaDescription,
          status: 'IN_REVIEW',
          sections: spec.sections,
          createdBy: 'phase2-seed',
          updatedBy: 'phase2-seed',
        },
      });
      await prisma.pageVersion.create({
        data: {
          pageId: page.id,
          version: 1,
          snapshot: {
            type: page.type,
            cityId: page.cityId,
            brandId: null,
            serviceId: page.serviceId,
            slug: page.slug,
            canonicalUrl: page.canonicalUrl,
            title: page.title,
            metaDescription: page.metaDescription,
            status: page.status,
            sections: spec.sections,
          },
          note: 'Phase 3 publish (2026-11-23): record created by the seed from the Phase 2 spec — no Studio draft existed for this page.',
          createdBy: 'phase2-seed',
        },
      });
      page = { ...page, versions: [{ version: 1, createdBy: 'phase2-seed' }] };
    }
    if (page.status === 'PUBLISHED') continue;
    const hasContent =
      typeof page.title === 'string' &&
      page.title.trim().length > 0 &&
      Array.isArray(page.sections) &&
      page.sections.length > 0;
    const neverPublished =
      (page.status === 'DRAFT' || page.status === 'IN_REVIEW') &&
      !page.publishedAt &&
      hasContent;
    // v3: IN_REVIEW with publishedAt already set is the actual
    // production state of all seven (e4bc63e build log) — flip it,
    // keeping the original publishedAt.
    const stuckInReview =
      page.status === 'IN_REVIEW' && Boolean(page.publishedAt) && hasContent;
    if (!neverPublished && !stuckInReview) {
      console.log(`Phase 3 publish: skipping ${url} — record is neither a never-published draft nor a stuck IN_REVIEW record with content (status ${page.status}, publishedAt ${page.publishedAt ? 'set' : 'null'}).`);
      continue;
    }
    const nextVersion = Math.max(0, ...page.versions.map((v) => v.version)) + 1;
    await prisma.landingPage.update({
      where: { id: page.id },
      data: stuckInReview
        ? { status: 'PUBLISHED', updatedBy: 'phase3-publish' }
        : { status: 'PUBLISHED', publishedAt: new Date(), updatedBy: 'phase3-publish' },
    });
    await prisma.pageVersion.create({
      data: {
        pageId: page.id,
        version: nextVersion,
        snapshot: {
          type: page.type,
          cityId: page.cityId,
          brandId: page.brandId,
          serviceId: page.serviceId,
          slug: page.slug,
          canonicalUrl: page.canonicalUrl,
          title: page.title,
          metaDescription: page.metaDescription,
          status: 'PUBLISHED',
          sections: page.sections,
        },
        note: stuckInReview
          ? 'Published by seed Phase 3 v3 (2026-11-23): record was IN_REVIEW with publishedAt already set — status flipped to PUBLISHED, original publishedAt kept. One of the seven 2026-11-13 problem pages; owner directive 2026-11-23 makes the published count the stated 131.'
          : 'Published by seed Phase 3 (2026-11-23): one of the seven 2026-11-13 problem pages seeded as drafts and never published — owner directive 2026-11-23 makes the published count the stated 131.',
        createdBy: 'phase3-publish',
      },
    });
    phase3Published += 1;
    console.log(stuckInReview ? `Phase 3 publish: published ${url} (status flip from IN_REVIEW; publishedAt kept).` : `Phase 3 publish: published ${url}.`);
  }
}

// ─── Phase 4 phone correction: the public number on the published pages ──
// The 2026-11-13 page batches (the tri-county problem pages, the
// taxonomy service / installation pages and the city pages) were
// created carrying the
// private line 954-931-7997 in their CTA and FAQ copy — the CTA
// block's phone field, the "How do I book?" FAQ answer and the CTA
// body. The phone-swap waves fixed the SOURCES (phase2DraftPages.js
// now builds every one of those strings with 844-460-7038, the
// public platform number), but the create-only seed never rewrites
// existing records, so the published pages kept the private number.
// A live scan on 2026-11-23 found '954-931-7997' — that one format
// only — on all 59 published /services/ pages (169 occurrences) and
// all 65 published /service-areas/ city pages (136 occurrences).
//
// This step repairs ONLY the listed records and ONLY the phone
// string:
//   - the URL list is exactly the 59 published /services/ pages plus
//     the seven Phase 3 problem pages (same 2026-11-13 batch; the
//     Phase 3 step above publishes their stored content as-is, so
//     they are corrected here, in the same run, after it) plus the
//     65 published /service-areas/ city pages — 131 URLs in all,
//     the full published set (59 + 7 + 65);
//   - a record is written ONLY when its title, metaDescription or
//     sections still contain the old string, and the replacement is
//     a pure substring swap to '844-460-7038' — the exact format
//     the current source builds — so no other copy can change;
//   - the correction is recorded as a PageVersion (createdBy
//     'phase4-phone-correction') in the Studio snapshot shape,
//     like the Phase 2 correction.
// Idempotent: once corrected, the old string no longer matches, so
// re-runs change nothing. (The 65 city pages were added to this list
// on 2026-11-23: the owner's full live scan showed every one of them
// carries the same string in the same CTA/FAQ pattern, so the
// correction covers the entire published set in a single run.)
const PHASE4_PHONE_URLS = [
  'https://topspeedappliance.net/services/appliance-installation/',
  'https://topspeedappliance.net/services/commercial-appliance-installation/',
  'https://topspeedappliance.net/services/commercial-appliance-repair/',
  'https://topspeedappliance.net/services/commercial-cooking-equipment-installation/',
  'https://topspeedappliance.net/services/commercial-cooking-equipment-repair/',
  'https://topspeedappliance.net/services/commercial-cooking-equipment-repair/error-codes/',
  'https://topspeedappliance.net/services/commercial-cooking-equipment-repair/not-heating/',
  'https://topspeedappliance.net/services/commercial-dishwashing-installation/',
  'https://topspeedappliance.net/services/commercial-dishwashing-repair/',
  'https://topspeedappliance.net/services/commercial-dishwashing-repair/leaking/',
  'https://topspeedappliance.net/services/commercial-dishwashing-repair/not-draining/',
  'https://topspeedappliance.net/services/commercial-laundry-installation/',
  'https://topspeedappliance.net/services/commercial-laundry-repair/',
  'https://topspeedappliance.net/services/commercial-laundry-repair/not-draining/',
  'https://topspeedappliance.net/services/commercial-laundry-repair/not-heating/',
  'https://topspeedappliance.net/services/commercial-refrigeration-installation/',
  'https://topspeedappliance.net/services/commercial-refrigeration-repair/',
  'https://topspeedappliance.net/services/commercial-refrigeration-repair/leaking/',
  'https://topspeedappliance.net/services/commercial-refrigeration-repair/not-cooling/',
  'https://topspeedappliance.net/services/commercial-trash-and-beverage-equipment-installation/',
  'https://topspeedappliance.net/services/commercial-trash-beverage-equipment-repair/',
  'https://topspeedappliance.net/services/commercial-trash-beverage-equipment-repair/leaking/',
  'https://topspeedappliance.net/services/commercial-trash-beverage-equipment-repair/not-cooling/',
  'https://topspeedappliance.net/services/cooktop-installation/',
  'https://topspeedappliance.net/services/dishwasher-installation/',
  'https://topspeedappliance.net/services/dishwasher-repair/',
  'https://topspeedappliance.net/services/dishwasher-repair/error-codes/',
  'https://topspeedappliance.net/services/dishwasher-repair/leaking/',
  'https://topspeedappliance.net/services/dishwasher-repair/not-draining/',
  'https://topspeedappliance.net/services/dishwasher-repair/unusual-noises/',
  'https://topspeedappliance.net/services/dryer-installation/',
  'https://topspeedappliance.net/services/dryer-repair/',
  'https://topspeedappliance.net/services/dryer-repair/error-codes/',
  'https://topspeedappliance.net/services/dryer-repair/not-heating/',
  'https://topspeedappliance.net/services/freezer-ice-maker-installation/',
  'https://topspeedappliance.net/services/freezer-ice-maker-repair/',
  'https://topspeedappliance.net/services/freezer-ice-maker-repair/leaking/',
  'https://topspeedappliance.net/services/freezer-ice-maker-repair/no-ice/',
  'https://topspeedappliance.net/services/freezer-ice-maker-repair/not-cooling/',
  'https://topspeedappliance.net/services/garbage-disposal-installation/',
  'https://topspeedappliance.net/services/garbage-disposal-repair/',
  'https://topspeedappliance.net/services/garbage-disposal-repair/leaking/',
  'https://topspeedappliance.net/services/garbage-disposal-repair/not-draining/',
  'https://topspeedappliance.net/services/garbage-disposal-repair/unusual-noises/',
  'https://topspeedappliance.net/services/microwave-installation/',
  'https://topspeedappliance.net/services/microwave-repair/',
  'https://topspeedappliance.net/services/microwave-repair/error-codes/',
  'https://topspeedappliance.net/services/microwave-repair/not-heating/',
  'https://topspeedappliance.net/services/microwave-repair/unusual-noises/',
  'https://topspeedappliance.net/services/oven-range-installation/',
  'https://topspeedappliance.net/services/oven-range-repair/',
  'https://topspeedappliance.net/services/oven-range-repair/error-codes/',
  'https://topspeedappliance.net/services/oven-range-repair/not-heating/',
  'https://topspeedappliance.net/services/refrigerator-installation/',
  'https://topspeedappliance.net/services/refrigerator-repair/',
  'https://topspeedappliance.net/services/refrigerator-repair/not-cooling/',
  'https://topspeedappliance.net/services/washer-installation/',
  'https://topspeedappliance.net/services/washer-repair/',
  'https://topspeedappliance.net/services/washer-repair/not-draining/',
  'https://topspeedappliance.net/services/refrigerator-repair/leaking/',
  'https://topspeedappliance.net/services/refrigerator-repair/unusual-noises/',
  'https://topspeedappliance.net/services/refrigerator-repair/error-codes/',
  'https://topspeedappliance.net/services/washer-repair/leaking/',
  'https://topspeedappliance.net/services/washer-repair/unusual-noises/',
  'https://topspeedappliance.net/services/washer-repair/error-codes/',
  'https://topspeedappliance.net/services/dryer-repair/unusual-noises/',
  // — the 65 published city (service-area) pages:
  'https://topspeedappliance.net/service-areas/fort-lauderdale/',
  'https://topspeedappliance.net/service-areas/coral-springs/',
  'https://topspeedappliance.net/service-areas/plantation/',
  'https://topspeedappliance.net/service-areas/sunrise/',
  'https://topspeedappliance.net/service-areas/lauderhill/',
  'https://topspeedappliance.net/service-areas/lauderdale-lakes/',
  'https://topspeedappliance.net/service-areas/north-lauderdale/',
  'https://topspeedappliance.net/service-areas/tamarac/',
  'https://topspeedappliance.net/service-areas/davie/',
  'https://topspeedappliance.net/service-areas/pompano-beach/',
  'https://topspeedappliance.net/service-areas/oakland-park/',
  'https://topspeedappliance.net/service-areas/margate/',
  'https://topspeedappliance.net/service-areas/hollywood/',
  'https://topspeedappliance.net/service-areas/pembroke-pines/',
  'https://topspeedappliance.net/service-areas/miramar/',
  'https://topspeedappliance.net/service-areas/deerfield-beach/',
  'https://topspeedappliance.net/service-areas/coconut-creek/',
  'https://topspeedappliance.net/service-areas/dania-beach/',
  'https://topspeedappliance.net/service-areas/cooper-city/',
  'https://topspeedappliance.net/service-areas/weston/',
  'https://topspeedappliance.net/service-areas/parkland/',
  'https://topspeedappliance.net/service-areas/hallandale-beach/',
  'https://topspeedappliance.net/service-areas/wilton-manors/',
  'https://topspeedappliance.net/service-areas/lighthouse-point/',
  'https://topspeedappliance.net/service-areas/lauderdale-by-the-sea/',
  'https://topspeedappliance.net/service-areas/southwest-ranches/',
  'https://topspeedappliance.net/service-areas/west-park/',
  'https://topspeedappliance.net/service-areas/pembroke-park/',
  'https://topspeedappliance.net/service-areas/hillsboro-beach/',
  'https://topspeedappliance.net/service-areas/sea-ranch-lakes/',
  'https://topspeedappliance.net/service-areas/lazy-lake/',
  'https://topspeedappliance.net/service-areas/west-palm-beach/',
  'https://topspeedappliance.net/service-areas/boca-raton/',
  'https://topspeedappliance.net/service-areas/boynton-beach/',
  'https://topspeedappliance.net/service-areas/delray-beach/',
  'https://topspeedappliance.net/service-areas/wellington/',
  'https://topspeedappliance.net/service-areas/jupiter/',
  'https://topspeedappliance.net/service-areas/palm-beach-gardens/',
  'https://topspeedappliance.net/service-areas/lake-worth-beach/',
  'https://topspeedappliance.net/service-areas/riviera-beach/',
  'https://topspeedappliance.net/service-areas/greenacres/',
  'https://topspeedappliance.net/service-areas/royal-palm-beach/',
  'https://topspeedappliance.net/service-areas/palm-beach/',
  'https://topspeedappliance.net/service-areas/belle-glade/',
  'https://topspeedappliance.net/service-areas/palm-springs/',
  'https://topspeedappliance.net/service-areas/north-palm-beach/',
  'https://topspeedappliance.net/service-areas/lake-park/',
  'https://topspeedappliance.net/service-areas/miami/',
  'https://topspeedappliance.net/service-areas/hialeah/',
  'https://topspeedappliance.net/service-areas/miami-gardens/',
  'https://topspeedappliance.net/service-areas/miami-beach/',
  'https://topspeedappliance.net/service-areas/north-miami/',
  'https://topspeedappliance.net/service-areas/homestead/',
  'https://topspeedappliance.net/service-areas/doral/',
  'https://topspeedappliance.net/service-areas/coral-gables/',
  'https://topspeedappliance.net/service-areas/aventura/',
  'https://topspeedappliance.net/service-areas/cutler-bay/',
  'https://topspeedappliance.net/service-areas/hialeah-gardens/',
  'https://topspeedappliance.net/service-areas/sunny-isles-beach/',
  'https://topspeedappliance.net/service-areas/north-miami-beach/',
  'https://topspeedappliance.net/service-areas/sweetwater/',
  'https://topspeedappliance.net/service-areas/florida-city/',
  'https://topspeedappliance.net/service-areas/key-biscayne/',
  'https://topspeedappliance.net/service-areas/surfside/',
  'https://topspeedappliance.net/service-areas/bal-harbour/',
];
const PHASE4_OLD_PHONE = '954-931-7997';
const PHASE4_NEW_PHONE = '844-460-7038';
let phase4Corrected = 0;
{
  const swapPhone = (value, state) => {
    if (typeof value === 'string') {
      const parts = value.split(PHASE4_OLD_PHONE);
      if (parts.length > 1) {
        state.hits += parts.length - 1;
        return parts.join(PHASE4_NEW_PHONE);
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => swapPhone(v, state));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = swapPhone(v, state);
      return out;
    }
    return value;
  };
  for (const url of PHASE4_PHONE_URLS) {
    const page = await prisma.landingPage.findUnique({
      where: { canonicalUrl: url },
      include: { versions: { select: { version: true } } },
    });
    if (!page) {
      console.log(`Phase 4 phone correction: skipping ${url} — no record exists.`);
      continue;
    }
    const state = { hits: 0 };
    const nextTitle = swapPhone(page.title, state);
    const nextMeta = swapPhone(page.metaDescription, state);
    const nextSections = swapPhone(page.sections, state);
    if (!state.hits) continue;
    const nextVersion = Math.max(0, ...page.versions.map((v) => v.version)) + 1;
    await prisma.landingPage.update({
      where: { id: page.id },
      data: { title: nextTitle, metaDescription: nextMeta, sections: nextSections, updatedBy: 'phase4-phone-correction' },
    });
    await prisma.pageVersion.create({
      data: {
        pageId: page.id,
        version: nextVersion,
        snapshot: {
          type: page.type,
          cityId: page.cityId,
          brandId: page.brandId,
          serviceId: page.serviceId,
          slug: page.slug,
          canonicalUrl: page.canonicalUrl,
          title: nextTitle,
          metaDescription: nextMeta,
          status: page.status,
          sections: nextSections,
        },
        note: 'Seed correction (2026-11-23): public phone number — CTA/FAQ copy carried the private line 954-931-7997; replaced with the public platform number 844-460-7038 (the format the current Phase 2 source builds). Phone-string replacement only; no other copy changed.',
        createdBy: 'phase4-phone-correction',
      },
    });
    phase4Corrected += 1;
    console.log(`Phase 4 phone correction: replaced ${state.hits} phone occurrence(s) on ${url}.`);
  }
}

// Top Speed Media OS — Phase 1 content library (2026-11-14).
// Create-only by slug, exactly like the Phase 2 pages above: a record
// is inserted the first time its slug is seen and NEVER modified by
// reseeding afterwards, so console edits, reviews and status changes
// are safe. Seeded statuses are the records' true starting states:
// Flywheel Ad 01 is genuinely posted on Facebook (PUBLISHED, with the
// real post URL); the other 24 ads and all 29 Training Academy modules
// are unpublished drafts.
let mediaCreated = 0;
for (const seed of MEDIA_CONTENT_SEEDS) {
  const existing = await prisma.mediaContent.findUnique({ where: { slug: seed.slug } });
  if (existing) continue;
  await prisma.mediaContent.create({
    data: {
      slug: seed.slug,
      type: seed.type,
      division: seed.division,
      title: seed.title,
      description: seed.description,
      assetUrl: seed.assetUrl,
      thumbnailUrl: seed.thumbnailUrl,
      durationSec: seed.durationSec,
      transcript: seed.transcript,
      destinationUrl: seed.destinationUrl,
      status: seed.status,
      publishAt: seed.publishAt ? new Date(seed.publishAt) : null,
      publishedAt: seed.publishedAt ? new Date(seed.publishedAt) : null,
      tags: seed.tags,
      createdBy: 'media-os-seed',
      updatedBy: 'media-os-seed',
    },
  });
  mediaCreated += 1;
}

// Multi-account Google manager registry (2026-11-13): the REAL Google
// accounts in the structure. Idempotent BY EMAIL and create-only
// (update: {}) — a redeploy must never overwrite edits the owner made
// in the registry, and statuses never auto-flip here.
for (const seed of GOOGLE_ACCOUNT_SEEDS) {
  await prisma.googleAccountLink.upsert({ where: { email: seed.email }, update: {}, create: seed });
}

// ─── Phase 5: the Campaign Engine registry (2026-11-23) ──────────
// The perpetual campaign factory's launch batch + today's daily
// batch, generated by the SAME pure factory the API service runs
// (src/services/campaignFactory.js), so the registry's contents
// are reproducible from code. Idempotent twice over: a batch row
// exists per batchKey (a batch generates exactly once) and every
// campaignKey is unique. Records are born DRAFT / STAGED (send
// lanes); the day's social selection (up to 7) is also queued
// into the Facebook OS stream as born-DRAFT posts under the
// 'campaign-engine' series, deduped by (seriesKey, linkUrl) like
// the city-posts loader. Nothing here publishes, sends, enables,
// or funds anything.
async function seedCampaignBatch(batchKey, kind, records) {
  const existingBatch = await prisma.campaignBatch.findUnique({ where: { batchKey } });
  if (existingBatch) {
    console.log(`Campaign Engine: batch ${batchKey} already generated — skipping.`);
    return { created: 0, socialQueued: 0 };
  }
  let created = 0;
  const persisted = [];
  for (const record of records) {
    const existing = await prisma.campaignRecord.findUnique({
      where: { campaignKey: record.campaignKey },
      select: { id: true },
    });
    if (existing) { persisted.push({ ...record, id: existing.id }); continue; }
    const row = await prisma.campaignRecord.create({
      data: {
        campaignKey: record.campaignKey,
        batchKey: record.batchKey,
        name: record.name,
        division: record.division,
        surface: record.surface,
        audience: record.audience ?? null,
        audienceNote: record.audienceNote ?? null,
        angle: record.angle,
        subject: record.subject ?? null,
        copy: record.copy,
        creativeSpec: record.creativeSpec ?? undefined,
        landingUrl: record.landingUrl,
        sourceTag: record.sourceTag,
        status: record.status === 'STAGED' ? 'STAGED' : 'DRAFT',
        createdById: null,
      },
    });
    persisted.push({ ...record, id: row.id });
    created += 1;
  }
  let socialQueued = 0;
  for (const record of persisted) {
    if (socialQueued >= 7) break;
    if (record.surface !== 'SOCIAL_FB') continue;
    const existingPost = await prisma.facebookStreamPost.findFirst({
      where: { seriesKey: 'campaign-engine', linkUrl: record.landingBase },
    });
    if (existingPost) {
      await prisma.campaignRecord.update({
        where: { id: record.id },
        data: { linkedRef: existingPost.id },
      });
      continue;
    }
    const post = await prisma.facebookStreamPost.create({
      data: {
        seriesKey: 'campaign-engine',
        format: record.angle === 'CITY_SPOTLIGHT' ? 'CITY_SPOTLIGHT' : 'CUSTOM',
        title: record.name.slice(0, 120),
        copy: record.copy.slice(0, 1024),
        linkUrl: record.landingBase,
        status: 'DRAFT',
        statusNote: `Campaign Engine ${record.batchKey} · ${record.campaignKey} — queued by the factory; publish only through the lifecycle + owner approval.`,
      },
    });
    await prisma.campaignRecord.update({
      where: { id: record.id },
      data: { status: 'QUEUED', linkedRef: post.id },
    });
    socialQueued += 1;
  }
  await prisma.campaignBatch.create({
    data: { batchKey, kind, campaignCount: created, socialQueued },
  });
  console.log(`Campaign Engine: batch ${batchKey} generated — ${created} campaigns, ${socialQueued} social queued.`);
  return { created, socialQueued };
}

const campaignLaunch = await seedCampaignBatch(LAUNCH_BATCH_KEY, 'LAUNCH', generateLaunchBatch());
const todayKey = dailyBatchKey(new Date());
const campaignDaily = await seedCampaignBatch(todayKey, 'DAILY', generateDailyBatch(new Date()));
const campaignRecordCount = await prisma.campaignRecord.count();

const companyCount = await prisma.company.count();
const providerCount = await prisma.provider.count();
const marketingCityCount = await prisma.marketingCity.count();
const landingPageCount = await prisma.landingPage.count();
const googleAccountCount = await prisma.googleAccountLink.count();
const mediaContentCount = await prisma.mediaContent.count();
console.log(`Seed complete: ${companyCount} companies, ${providerCount} providers, ${marketingCityCount} marketing cities, ${landingPageCount} landing pages (${phase2Created} Phase 2 drafts created, ${phase2Skipped} skipped, ${phase2Corrected} Phase 2 drafts corrected, ${phase3Published} Phase 3 pages published, ${phase4Corrected} Phase 4 pages phone-corrected), ${googleAccountCount} Google account links, ${mediaContentCount} media content records (${mediaCreated} created), ${campaignRecordCount} campaign records (${campaignLaunch.created} launch + ${campaignDaily.created} daily created this run).`);
await prisma.$disconnect();

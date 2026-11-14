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
    id: '30000000-0000-4000-8000-000000000001',
    companyId: providerCompanies.alpha,
    businessName: 'Broward Rapid Refrigeration',
    type: 'NETWORK_BUSINESS',
    specialties: ['Refrigerator', 'Freezer / Ice Maker'],
    serviceCities: ['Sunrise', 'Plantation', 'Fort Lauderdale', 'Lauderhill', 'Tamarac', 'Davie'],
    rating: 4.9,
    active: true,
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    companyId: providerCompanies.beta,
    businessName: 'Plantation Home Appliance Pros',
    type: 'NETWORK_BUSINESS',
    specialties: ['Washer', 'Dryer', 'Dishwasher'],
    serviceCities: ['Plantation', 'Sunrise', 'Davie', 'Coral Springs', 'Fort Lauderdale'],
    rating: 4.8,
    active: true,
  },
  {
    id: '30000000-0000-4000-8000-000000000003',
    companyId: providerCompanies.gamma,
    businessName: 'Top Speed Field Team',
    type: 'INDEPENDENT_PROVIDER',
    specialties: ['Refrigerator', 'Washer', 'Dryer', 'Oven / Range', 'Dishwasher', 'Freezer / Ice Maker', 'Microwave', 'Garbage Disposal', 'Installation'],
    serviceCities: ['Lauderhill', 'Plantation', 'Sunrise', 'Tamarac', 'Fort Lauderdale', 'Lauderdale Lakes', 'North Lauderdale', 'Davie', 'Coral Springs', 'Pompano Beach', 'Oakland Park', 'Margate'],
    rating: 4.8,
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

const companyCount = await prisma.company.count();
const providerCount = await prisma.provider.count();
const marketingCityCount = await prisma.marketingCity.count();
const landingPageCount = await prisma.landingPage.count();
const googleAccountCount = await prisma.googleAccountLink.count();
const mediaContentCount = await prisma.mediaContent.count();
console.log(`Seed complete: ${companyCount} companies, ${providerCount} providers, ${marketingCityCount} marketing cities, ${landingPageCount} landing pages (${phase2Created} Phase 2 drafts created, ${phase2Skipped} skipped, ${phase2Corrected} Phase 2 drafts corrected), ${googleAccountCount} Google account links, ${mediaContentCount} media content records (${mediaCreated} created).`);
await prisma.$disconnect();

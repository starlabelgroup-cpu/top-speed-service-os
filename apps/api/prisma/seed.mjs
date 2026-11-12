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

const companyCount = await prisma.company.count();
const providerCount = await prisma.provider.count();
const marketingCityCount = await prisma.marketingCity.count();
const landingPageCount = await prisma.landingPage.count();
console.log(`Seed complete: ${companyCount} companies, ${providerCount} providers, ${marketingCityCount} marketing cities, ${landingPageCount} landing pages (${phase2Created} Phase 2 drafts created, ${phase2Skipped} skipped).`);
await prisma.$disconnect();

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

const companyCount = await prisma.company.count();
const providerCount = await prisma.provider.count();
const marketingCityCount = await prisma.marketingCity.count();
console.log(`Seed complete: ${companyCount} companies, ${providerCount} providers, ${marketingCityCount} marketing cities.`);
await prisma.$disconnect();

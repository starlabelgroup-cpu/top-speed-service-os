import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';
import {
  MARKETING_BRANDS,
  MARKETING_CITIES,
  MARKETING_SERVICES,
  MARKETING_SYMPTOMS,
} from '../data/marketingTaxonomy.js';

/**
 * Top Speed Marketing OS — persistence for the agency data layer.
 *
 * Same pattern as the banner system: Prisma tables are the durable
 * record, the in-memory store is the working set, mutations write
 * through, and hydrateMarketingOs() loads everything at cold start.
 * Taxonomy seeding is idempotent in both modes: seed rows are matched
 * by slug and created only when missing, so admin edits made in the
 * Studio are never clobbered by a redeploy (blueprint §3/§12).
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreCity(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    state: row.state || 'FL',
    serviceCovered: row.serviceCovered === true,
    sortOrder: row.sortOrder || 0,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toStoreBrand(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    sortOrder: row.sortOrder || 0,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toStoreService(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    partOfService: row.partOfService || null,
    sortOrder: row.sortOrder || 0,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toStoreSymptom(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    sortOrder: row.sortOrder || 0,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toStorePage(row) {
  return {
    id: row.id,
    type: row.type,
    cityId: row.cityId || null,
    brandId: row.brandId || null,
    serviceId: row.serviceId || null,
    slug: row.slug,
    canonicalUrl: row.canonicalUrl,
    title: row.title,
    metaDescription: row.metaDescription || null,
    status: row.status || 'DRAFT',
    sections: Array.isArray(row.sections) ? row.sections : [],
    createdBy: row.createdBy || null,
    updatedBy: row.updatedBy || null,
    publishedAt: iso(row.publishedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toStoreVersion(row) {
  return {
    id: row.id,
    pageId: row.pageId,
    version: row.version,
    snapshot: row.snapshot || {},
    note: row.note || null,
    createdBy: row.createdBy || null,
    createdAt: iso(row.createdAt),
  };
}

const MAPPERS = {
  city: toStoreCity,
  brand: toStoreBrand,
  service: toStoreService,
  symptom: toStoreSymptom,
};

const STORE_KEYS = {
  city: 'marketingCities',
  brand: 'marketingBrands',
  service: 'marketingServices',
  symptom: 'marketingSymptoms',
};

const PRISMA_MODELS = {
  city: 'marketingCity',
  brand: 'marketingBrand',
  service: 'marketingService',
  symptom: 'marketingSymptom',
};

const SEEDS = {
  city: MARKETING_CITIES,
  brand: MARKETING_BRANDS,
  service: MARKETING_SERVICES,
  symptom: MARKETING_SYMPTOMS,
};

function seedStoreRecord(kind, seed, index) {
  const now = new Date().toISOString();
  const base = {
    id: createId(),
    name: seed.name,
    slug: seed.slug,
    sortOrder: index,
    createdAt: now,
    updatedAt: now,
  };
  if (kind === 'city') return { ...base, state: 'FL', serviceCovered: seed.serviceCovered === true };
  if (kind === 'service') return { ...base, partOfService: seed.partOfService || null };
  return base;
}

function seedDbRow(kind, seed, index) {
  const base = { name: seed.name, slug: seed.slug, sortOrder: index };
  if (kind === 'city') return { ...base, state: 'FL', serviceCovered: seed.serviceCovered === true };
  if (kind === 'service') return { ...base, partOfService: seed.partOfService || null };
  return base;
}

/** Fill any missing taxonomy records from the §3 seeds (store-only). */
export function seedTaxonomyIntoStore() {
  for (const kind of Object.keys(SEEDS)) {
    const key = STORE_KEYS[kind];
    SEEDS[kind].forEach((seed, index) => {
      if (!store[key].some((record) => record.slug === seed.slug)) {
        store[key].push(seedStoreRecord(kind, seed, index));
      }
    });
    store[key].sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));
  }
}

export async function persistTaxonomyRecord(kind, record) {
  if (!DATABASE_ENABLED || !record?.id) return;
  try {
    const row = {
      id: record.id,
      name: record.name,
      slug: record.slug,
      sortOrder: record.sortOrder || 0,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt || record.createdAt),
    };
    if (kind === 'city') {
      row.state = record.state || 'FL';
      row.serviceCovered = record.serviceCovered === true;
    }
    if (kind === 'service') row.partOfService = record.partOfService || null;
    await db()[PRISMA_MODELS[kind]].upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error(`persistTaxonomyRecord(${kind}) failed`, error?.message || error);
  }
}

export async function deleteTaxonomyRecord(kind, id) {
  if (!DATABASE_ENABLED) return;
  try {
    await db()[PRISMA_MODELS[kind]].delete({ where: { id } });
  } catch (error) {
    console.error(`deleteTaxonomyRecord(${kind}) failed`, error?.message || error);
  }
}

export async function persistLandingPage(page) {
  if (!DATABASE_ENABLED || !page?.id) return;
  try {
    const row = {
      id: page.id,
      type: page.type,
      cityId: page.cityId || null,
      brandId: page.brandId || null,
      serviceId: page.serviceId || null,
      slug: page.slug,
      canonicalUrl: page.canonicalUrl,
      title: page.title,
      metaDescription: page.metaDescription || null,
      status: page.status || 'DRAFT',
      sections: Array.isArray(page.sections) ? page.sections : [],
      createdBy: page.createdBy || null,
      updatedBy: page.updatedBy || null,
      publishedAt: page.publishedAt ? new Date(page.publishedAt) : null,
      createdAt: new Date(page.createdAt),
      updatedAt: new Date(page.updatedAt || page.createdAt),
    };
    await db().landingPage.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistLandingPage failed', error?.message || error);
  }
}

export async function persistPageVersion(version) {
  if (!DATABASE_ENABLED || !version?.id) return;
  try {
    const row = {
      id: version.id,
      pageId: version.pageId,
      version: version.version,
      snapshot: version.snapshot || {},
      note: version.note || null,
      createdBy: version.createdBy || null,
      createdAt: new Date(version.createdAt),
    };
    await db().pageVersion.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistPageVersion failed', error?.message || error);
  }
}

export async function deleteLandingPage(id) {
  if (!DATABASE_ENABLED) return;
  try {
    await db().landingPage.delete({ where: { id } });
  } catch (error) {
    console.error('deleteLandingPage failed', error?.message || error);
  }
}

export async function hydrateMarketingOs() {
  if (!DATABASE_ENABLED) {
    seedTaxonomyIntoStore();
    return {
      cities: store.marketingCities.length,
      brands: store.marketingBrands.length,
      services: store.marketingServices.length,
      symptoms: store.marketingSymptoms.length,
      pages: store.landingPages.length,
    };
  }
  const prisma = db();
  // Idempotent taxonomy seed: create only the slugs that are missing.
  for (const kind of Object.keys(SEEDS)) {
    const model = prisma[PRISMA_MODELS[kind]];
    const existing = await model.findMany({ select: { slug: true } });
    const have = new Set(existing.map((row) => row.slug));
    for (const [index, seed] of SEEDS[kind].entries()) {
      if (!have.has(seed.slug)) {
        await model.create({ data: seedDbRow(kind, seed, index) });
      }
    }
    const rows = await model.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    store[STORE_KEYS[kind]] = rows.map(MAPPERS[kind]);
  }
  const pageRows = await prisma.landingPage.findMany({ orderBy: { createdAt: 'asc' } });
  store.landingPages = pageRows.map(toStorePage);
  const versionRows = await prisma.pageVersion.findMany({ orderBy: [{ pageId: 'asc' }, { version: 'asc' }] });
  store.pageVersions = versionRows.map(toStoreVersion);
  return {
    cities: store.marketingCities.length,
    brands: store.marketingBrands.length,
    services: store.marketingServices.length,
    symptoms: store.marketingSymptoms.length,
    pages: store.landingPages.length,
    versions: store.pageVersions.length,
  };
}

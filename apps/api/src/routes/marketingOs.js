import { Router } from 'express';
import { z } from 'zod';
import { appendEvent, createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { slugify } from '../data/marketingTaxonomy.js';
import {
  deleteLandingPage,
  deleteTaxonomyRecord,
  persistLandingPage,
  persistPageVersion,
  persistTaxonomyRecord,
} from '../db/marketingOsRepo.js';
import { emitReport } from '../services/managementReports.js';

/**
 * Top Speed Marketing OS — the agency's API on the Service OS backend.
 *
 * Public (the contract the .net runtime renders from in Phase 2):
 *   GET /marketing-os/taxonomy          the §3 taxonomy
 *   GET /marketing-os/pages             published pages, summary fields
 *   GET /marketing-os/pages/by-url      one published page by its path
 *
 * Admin (Page Studio backend; marketing + staff roles only):
 *   taxonomy CRUD + search, page CRUD with the §4 URL generator,
 *   duplicate-canonical protection, the draft → in-review → published
 *   → unpublished workflow with a version snapshot on every content
 *   save and every publish, and the §10 publish guardrail: a page can
 *   only be PUBLISHED for a service-covered city.
 */
const router = Router();
const marketingOnly = [
  authenticate,
  requireCompany,
  requireRole(ROLES.MARKETING_MANAGER, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];

const SITE_BASE = 'https://topspeedappliance.net';
const PAGE_TYPES = ['CITY', 'BRAND', 'SERVICE', 'BRAND_SERVICE', 'BRAND_SERVICE_CITY'];
const PAGE_STATUSES = ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'UNPUBLISHED'];
const TRANSITIONS = {
  DRAFT: ['IN_REVIEW'],
  IN_REVIEW: ['PUBLISHED', 'DRAFT'],
  PUBLISHED: ['UNPUBLISHED'],
  UNPUBLISHED: ['IN_REVIEW', 'DRAFT'],
};

// ─── taxonomy lookups + serializers ─────────────────────────────────

const KIND_STORES = {
  cities: 'marketingCities',
  brands: 'marketingBrands',
  services: 'marketingServices',
  symptoms: 'marketingSymptoms',
};
const KIND_SINGULAR = { cities: 'city', brands: 'brand', services: 'service', symptoms: 'symptom' };

function findCity(id) { return store.marketingCities.find((c) => c.id === id) || null; }
function findBrand(id) { return store.marketingBrands.find((b) => b.id === id) || null; }
function findService(id) { return store.marketingServices.find((s) => s.id === id) || null; }

function publicCity(c) {
  return c && { id: c.id, name: c.name, slug: c.slug, state: c.state, serviceCovered: c.serviceCovered };
}
function publicBrand(b) { return b && { id: b.id, name: b.name, slug: b.slug }; }
function publicService(s) {
  return s && { id: s.id, name: s.name, slug: s.slug, partOfService: s.partOfService || null };
}
function publicSymptom(s) { return s && { id: s.id, name: s.name, slug: s.slug }; }

function pageSummary(page) {
  return {
    id: page.id,
    type: page.type,
    slug: page.slug,
    canonicalUrl: page.canonicalUrl,
    title: page.title,
    metaDescription: page.metaDescription || null,
    status: page.status,
    city: publicCity(page.cityId ? findCity(page.cityId) : null) || null,
    brand: publicBrand(page.brandId ? findBrand(page.brandId) : null) || null,
    service: publicService(page.serviceId ? findService(page.serviceId) : null) || null,
    publishedAt: page.publishedAt || null,
    updatedAt: page.updatedAt,
  };
}

function pagePublic(page) {
  return { ...pageSummary(page), sections: page.sections || [] };
}

function pageAdmin(page) {
  return {
    ...pageSummary(page),
    sections: page.sections || [],
    createdBy: page.createdBy || null,
    updatedBy: page.updatedBy || null,
    createdAt: page.createdAt,
    versionCount: store.pageVersions.filter((v) => v.pageId === page.id).length,
  };
}

// ─── §4 URL scheme + default content ────────────────────────────────

function canonicalFor(type, { city, brand, service }) {
  let slug = null;
  if (type === 'CITY') slug = `service-areas/${city.slug}`;
  if (type === 'BRAND') slug = `brands/${brand.slug}`;
  if (type === 'SERVICE') slug = `services/${service.slug}`;
  if (type === 'BRAND_SERVICE') slug = `brands/${brand.slug}/${service.slug}`;
  if (type === 'BRAND_SERVICE_CITY') slug = `brands/${brand.slug}/${service.slug}/${city.slug}`;
  return { slug, canonicalUrl: `${SITE_BASE}/${slug}/` };
}

function serviceDisplayName(service) {
  if (!service) return '';
  if (/repair/i.test(service.name)) return service.name;
  if (service.name === 'Installation') return 'Appliance Installation';
  return `${service.name} Repair`;
}

function defaultTitle(type, { city, brand, service }) {
  if (type === 'CITY') return `Appliance Repair in ${city.name}, FL | Top Speed Appliance`;
  if (type === 'BRAND') return `${brand.name} Appliance Repair in Broward County | Top Speed Appliance`;
  if (type === 'SERVICE') return `${serviceDisplayName(service)} in Broward County | Top Speed Appliance`;
  if (type === 'BRAND_SERVICE') return `${brand.name} ${serviceDisplayName(service)} | Top Speed Appliance`;
  return `${brand.name} ${serviceDisplayName(service)} in ${city.name}, FL | Top Speed Appliance`;
}

function defaultMeta(type, { city, brand, service }) {
  const where = city ? `${city.name}, FL` : 'Broward County, FL';
  const what = service ? serviceDisplayName(service).toLowerCase() : 'appliance repair';
  const who = brand ? `${brand.name} ` : '';
  return `Book ${who}${what} in ${where} with Top Speed Appliance — booked online, confirmed by a Service Setter, tracked live. Independent repair service.`;
}

function defaultSections(type, { city, brand, service }) {
  const where = city ? city.name : 'Broward County';
  const what = service ? serviceDisplayName(service) : 'Appliance Repair';
  const heading = type === 'CITY'
    ? `Appliance Repair in ${city.name}`
    : type === 'BRAND'
      ? `${brand.name} Appliance Repair`
      : type === 'SERVICE'
        ? what
        : `${brand.name} ${what}${type === 'BRAND_SERVICE_CITY' ? ` in ${city.name}` : ''}`;
  const blocks = [
    {
      type: 'hero',
      heading,
      body: brand
        ? `Independent ${brand.name} appliance service in ${where}. Top Speed Appliance is an independent repair service and is not affiliated with ${brand.name}.`
        : `Residential and commercial appliance service in ${where} — booked online, confirmed by a Service Setter, and tracked live from request to repair.`,
      primaryCta: 'Book Service',
      secondaryCta: 'Call Top Speed',
      tertiaryCta: 'Ask Speedy AI',
    },
    {
      type: 'intro',
      heading: 'How Top Speed works',
      body: 'Book online or with Speedy AI, a Service Setter confirms your appointment by phone, and your technician is dispatched through Book OS. Track My Tech shows all eight stages of your job as they happen.',
    },
  ];
  if (service && service.slug === 'commercial-appliance-repair') {
    blocks.push({
      type: 'service-terms',
      heading: 'Commercial terms',
      body: 'Commercial work is priced by custom quote under a service agreement. The residential diagnostic fee does not apply to commercial accounts.',
    });
  } else {
    blocks.push({
      type: 'service-terms',
      heading: 'Straightforward pricing',
      body: 'Residential service starts with a $99 diagnostic, collected at booking and credited toward your repair when you approve it.',
    });
  }
  if (service) {
    blocks.push({
      type: 'symptoms',
      heading: 'Common problems we diagnose',
      items: store.marketingSymptoms.map((s) => s.name),
    });
  }
  const faq = [
    {
      q: 'How do I book?',
      a: 'Book online in about a minute, call 954-931-7997, or ask Speedy AI. A Service Setter confirms every appointment by phone.',
    },
    {
      q: 'Can I track my technician?',
      a: 'Yes. Every booking gets a secure Track My Tech link with live stages, and a map pin when your technician is en route and sharing location.',
    },
  ];
  if (brand) {
    faq.unshift({
      q: `Are you affiliated with ${brand.name}?`,
      a: `No. Top Speed Appliance is an independent repair service. We repair ${brand.name} appliances but are not affiliated with or authorized by the manufacturer.`,
    });
  }
  blocks.push({ type: 'faq', heading: 'Questions', items: faq });
  blocks.push({
    type: 'cta',
    heading: 'Book your repair',
    body: `Top Speed Appliance serves ${where} and all twelve Broward service cities.`,
    phone: '954-931-7997',
  });
  return blocks;
}

// ─── versions ───────────────────────────────────────────────────────

function snapshotOf(page) {
  return {
    type: page.type,
    cityId: page.cityId || null,
    brandId: page.brandId || null,
    serviceId: page.serviceId || null,
    slug: page.slug,
    canonicalUrl: page.canonicalUrl,
    title: page.title,
    metaDescription: page.metaDescription || null,
    status: page.status,
    sections: page.sections || [],
  };
}

async function addVersion(page, note, actor) {
  const existing = store.pageVersions.filter((v) => v.pageId === page.id);
  const version = {
    id: createId(),
    pageId: page.id,
    version: existing.length ? Math.max(...existing.map((v) => v.version)) + 1 : 1,
    snapshot: snapshotOf(page),
    note: note || null,
    createdBy: actor || null,
    createdAt: new Date().toISOString(),
  };
  store.pageVersions.push(version);
  await persistPageVersion(version);
  return version;
}

function actorOf(req) {
  return req.user?.email || req.user?.id || null;
}

// ─── public API ─────────────────────────────────────────────────────

router.get('/marketing-os/taxonomy', (req, res) => {
  return res.json({
    data: {
      cities: store.marketingCities.map(publicCity),
      brands: store.marketingBrands.map(publicBrand),
      services: store.marketingServices.map(publicService),
      symptoms: store.marketingSymptoms.map(publicSymptom),
    },
  });
});

router.get('/marketing-os/pages', (req, res) => {
  const pages = store.landingPages
    .filter((p) => p.status === 'PUBLISHED')
    .map(pageSummary);
  return res.json({ data: pages });
});

router.get('/marketing-os/pages/by-url', (req, res) => {
  const raw = String(req.query.path || '').trim();
  if (!raw) return res.status(400).json({ error: 'path query parameter is required' });
  const pathOnly = raw.replace(/^https?:\/\/[^/]+/i, '');
  const normalized = `/${pathOnly.replace(/^\/+|\/+$/g, '')}/`;
  const page = store.landingPages.find(
    (p) => p.status === 'PUBLISHED' && p.canonicalUrl === `${SITE_BASE}${normalized}`,
  );
  if (!page) return res.status(404).json({ error: 'Published page not found for that URL' });
  return res.json({ data: pagePublic(page) });
});

// ─── admin: taxonomy ────────────────────────────────────────────────

router.get('/marketing-os/admin/taxonomy', ...marketingOnly, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const match = (r) => !q || r.name.toLowerCase().includes(q) || r.slug.includes(q);
  return res.json({
    data: {
      cities: store.marketingCities.filter(match),
      brands: store.marketingBrands.filter(match),
      services: store.marketingServices.filter(match),
      symptoms: store.marketingSymptoms.filter(match),
      counts: {
        cities: store.marketingCities.length,
        coveredCities: store.marketingCities.filter((c) => c.serviceCovered).length,
        brands: store.marketingBrands.length,
        services: store.marketingServices.length,
        symptoms: store.marketingSymptoms.length,
        pages: store.landingPages.length,
        publishedPages: store.landingPages.filter((p) => p.status === 'PUBLISHED').length,
      },
    },
  });
});

const taxonomyCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().min(2).max(80).optional(),
  serviceCovered: z.boolean().optional(),
  state: z.string().trim().min(2).max(2).optional(),
  partOfService: z.string().trim().max(80).nullable().optional(),
});
const taxonomyPatchSchema = taxonomyCreateSchema.partial();

function taxonomyKind(req, res, next) {
  const kind = KIND_SINGULAR[req.params.kind];
  if (!kind) return res.status(404).json({ error: 'Unknown taxonomy kind' });
  req.taxonomyKind = kind;
  req.taxonomyStoreKey = KIND_STORES[req.params.kind];
  return next();
}

router.post('/marketing-os/admin/taxonomy/:kind', ...marketingOnly, taxonomyKind, async (req, res) => {
  const parsed = taxonomyCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid record', details: parsed.error.flatten() });
  const slug = slugify(parsed.data.slug || parsed.data.name);
  if (!slug) return res.status(400).json({ error: 'A valid name or slug is required' });
  const list = store[req.taxonomyStoreKey];
  if (list.some((r) => r.slug === slug || r.name.toLowerCase() === parsed.data.name.toLowerCase())) {
    return res.status(409).json({ error: 'A record with that name or slug already exists' });
  }
  const now = new Date().toISOString();
  const record = {
    id: createId(),
    name: parsed.data.name,
    slug,
    sortOrder: list.length,
    createdAt: now,
    updatedAt: now,
  };
  if (req.taxonomyKind === 'city') {
    record.state = (parsed.data.state || 'FL').toUpperCase();
    record.serviceCovered = parsed.data.serviceCovered === true;
  }
  if (req.taxonomyKind === 'service') record.partOfService = parsed.data.partOfService || null;
  list.push(record);
  await persistTaxonomyRecord(req.taxonomyKind, record);
  return res.status(201).json({ data: record });
});

router.patch('/marketing-os/admin/taxonomy/:kind/:id', ...marketingOnly, taxonomyKind, async (req, res) => {
  const record = store[req.taxonomyStoreKey].find((r) => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  const parsed = taxonomyPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
  const nextSlug = parsed.data.slug ? slugify(parsed.data.slug) : record.slug;
  const nextName = parsed.data.name || record.name;
  const clash = store[req.taxonomyStoreKey].some(
    (r) => r.id !== record.id && (r.slug === nextSlug || r.name.toLowerCase() === nextName.toLowerCase()),
  );
  if (clash) return res.status(409).json({ error: 'Another record already uses that name or slug' });
  record.name = nextName;
  record.slug = nextSlug;
  if (req.taxonomyKind === 'city') {
    if (parsed.data.state) record.state = parsed.data.state.toUpperCase();
    if (typeof parsed.data.serviceCovered === 'boolean') record.serviceCovered = parsed.data.serviceCovered;
  }
  if (req.taxonomyKind === 'service' && parsed.data.partOfService !== undefined) {
    record.partOfService = parsed.data.partOfService || null;
  }
  record.updatedAt = new Date().toISOString();
  await persistTaxonomyRecord(req.taxonomyKind, record);
  return res.json({ data: record });
});

router.delete('/marketing-os/admin/taxonomy/:kind/:id', ...marketingOnly, taxonomyKind, async (req, res) => {
  const list = store[req.taxonomyStoreKey];
  const idx = list.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Record not found' });
  const fkField = `${req.taxonomyKind}Id`;
  if (req.taxonomyKind !== 'symptom' && store.landingPages.some((p) => p[fkField] === req.params.id)) {
    return res.status(409).json({ error: 'Record is used by landing pages and cannot be deleted' });
  }
  list.splice(idx, 1);
  await deleteTaxonomyRecord(req.taxonomyKind, req.params.id);
  return res.status(204).end();
});

// ─── admin: pages ───────────────────────────────────────────────────

router.get('/marketing-os/admin/pages', ...marketingOnly, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim().toUpperCase();
  const type = String(req.query.type || '').trim().toUpperCase();
  let pages = [...store.landingPages].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (status) pages = pages.filter((p) => p.status === status);
  if (type) pages = pages.filter((p) => p.type === type);
  if (q) {
    pages = pages.filter((p) =>
      p.title.toLowerCase().includes(q) || p.slug.includes(q) || p.canonicalUrl.toLowerCase().includes(q));
  }
  return res.json({ data: pages.map(pageAdmin) });
});

const pageCreateSchema = z.object({
  type: z.enum(PAGE_TYPES),
  cityId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  serviceId: z.string().uuid().optional(),
  title: z.string().trim().min(4).max(200).optional(),
  metaDescription: z.string().trim().max(320).optional(),
  note: z.string().trim().max(300).optional(),
});

const REQUIRED_REFS = {
  CITY: ['cityId'],
  BRAND: ['brandId'],
  SERVICE: ['serviceId'],
  BRAND_SERVICE: ['brandId', 'serviceId'],
  BRAND_SERVICE_CITY: ['brandId', 'serviceId', 'cityId'],
};

router.post('/marketing-os/admin/pages', ...marketingOnly, async (req, res) => {
  const parsed = pageCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid page', details: parsed.error.flatten() });
  const { type } = parsed.data;
  for (const field of REQUIRED_REFS[type]) {
    if (!parsed.data[field]) return res.status(400).json({ error: `${field} is required for a ${type} page` });
  }
  const refs = {
    city: parsed.data.cityId ? findCity(parsed.data.cityId) : null,
    brand: parsed.data.brandId ? findBrand(parsed.data.brandId) : null,
    service: parsed.data.serviceId ? findService(parsed.data.serviceId) : null,
  };
  if (parsed.data.cityId && !refs.city) return res.status(400).json({ error: 'cityId does not match a taxonomy city' });
  if (parsed.data.brandId && !refs.brand) return res.status(400).json({ error: 'brandId does not match a taxonomy brand' });
  if (parsed.data.serviceId && !refs.service) return res.status(400).json({ error: 'serviceId does not match a taxonomy service' });
  const { slug, canonicalUrl } = canonicalFor(type, refs);
  if (store.landingPages.some((p) => p.canonicalUrl === canonicalUrl)) {
    return res.status(409).json({ error: 'A page already exists for that canonical URL', canonicalUrl });
  }
  const now = new Date().toISOString();
  const page = {
    id: createId(),
    type,
    cityId: parsed.data.cityId || null,
    brandId: parsed.data.brandId || null,
    serviceId: parsed.data.serviceId || null,
    slug,
    canonicalUrl,
    title: parsed.data.title || defaultTitle(type, refs),
    metaDescription: parsed.data.metaDescription || defaultMeta(type, refs),
    status: 'DRAFT',
    sections: defaultSections(type, refs),
    createdBy: actorOf(req),
    updatedBy: actorOf(req),
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  store.landingPages.push(page);
  await persistLandingPage(page);
  await addVersion(page, parsed.data.note || 'Initial draft', actorOf(req));
  appendEvent('MARKETING_PAGE_CREATED', {
    source: 'page-studio',
    actor: actorOf(req),
    entityType: 'LANDING_PAGE',
    entityId: page.id,
    details: { type, canonicalUrl },
  });
  return res.status(201).json({ data: pageAdmin(page) });
});

router.get('/marketing-os/admin/pages/:id', ...marketingOnly, (req, res) => {
  const page = store.landingPages.find((p) => p.id === req.params.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  return res.json({ data: pageAdmin(page) });
});

const sectionSchema = z.object({ type: z.string().trim().min(1).max(40) }).passthrough();
const pagePatchSchema = z.object({
  title: z.string().trim().min(4).max(200).optional(),
  metaDescription: z.string().trim().max(320).nullable().optional(),
  sections: z.array(sectionSchema).max(30).optional(),
  note: z.string().trim().max(300).optional(),
  type: z.never().optional(),
  cityId: z.never().optional(),
  brandId: z.never().optional(),
  serviceId: z.never().optional(),
});

router.patch('/marketing-os/admin/pages/:id', ...marketingOnly, async (req, res) => {
  const page = store.landingPages.find((p) => p.id === req.params.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  if (req.body && ('type' in req.body || 'cityId' in req.body || 'brandId' in req.body || 'serviceId' in req.body)) {
    return res.status(400).json({ error: 'Page identity (type/city/brand/service) is fixed — create a new page for a different combination' });
  }
  const parsed = pagePatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid page update', details: parsed.error.flatten() });
  const { note, ...content } = parsed.data;
  const changed = ['title', 'metaDescription', 'sections'].some(
    (field) => content[field] !== undefined && JSON.stringify(content[field]) !== JSON.stringify(page[field]),
  );
  if (!changed) return res.json({ data: pageAdmin(page) });
  Object.assign(page, content, { updatedBy: actorOf(req), updatedAt: new Date().toISOString() });
  await persistLandingPage(page);
  const version = await addVersion(page, note || 'Content edit', actorOf(req));
  return res.json({ data: { ...pageAdmin(page), latestVersion: version.version } });
});

const statusSchema = z.object({
  status: z.enum(PAGE_STATUSES),
  note: z.string().trim().max(300).optional(),
});

router.post('/marketing-os/admin/pages/:id/status', ...marketingOnly, async (req, res) => {
  const page = store.landingPages.find((p) => p.id === req.params.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid status change', details: parsed.error.flatten() });
  const target = parsed.data.status;
  if (target === page.status) return res.json({ data: pageAdmin(page) });
  const allowed = TRANSITIONS[page.status] || [];
  if (!allowed.includes(target)) {
    return res.status(422).json({
      error: `Cannot move a page from ${page.status} to ${target}`,
      allowedTransitions: allowed,
    });
  }
  if (target === 'PUBLISHED' && page.cityId) {
    const city = findCity(page.cityId);
    if (!city || !city.serviceCovered) {
      return res.status(422).json({
        error: `Cannot publish: ${city ? city.name : 'that city'} is not a service-covered city (expansion market — records only)`,
        guardrail: 'blueprint §10: publish only services and coverage the company can actually serve',
      });
    }
  }
  page.status = target;
  page.updatedBy = actorOf(req);
  page.updatedAt = new Date().toISOString();
  if (target === 'PUBLISHED') page.publishedAt = page.updatedAt;
  await persistLandingPage(page);
  if (target === 'PUBLISHED') {
    await addVersion(page, parsed.data.note || 'Published', actorOf(req));
  }
  appendEvent(`MARKETING_PAGE_${target}`, {
    source: 'page-studio',
    actor: actorOf(req),
    entityType: 'LANDING_PAGE',
    entityId: page.id,
    details: { canonicalUrl: page.canonicalUrl },
  });
  if (target === 'PUBLISHED') {
    emitReport({
      department: 'marketing',
      type: 'MARKETING_PAGE_PUBLISHED',
      title: `Landing page published — ${page.title || page.canonicalUrl}`,
      detail: { pageId: page.id, title: page.title || null, canonicalUrl: page.canonicalUrl, type: page.type || null, actor: actorOf(req) },
      source: 'page-studio',
      reference: page.canonicalUrl,
      eventKey: `marketing-page:${page.id}:published:${page.updatedAt}`,
    });
  }
  return res.json({ data: pageAdmin(page) });
});

router.get('/marketing-os/admin/pages/:id/versions', ...marketingOnly, (req, res) => {
  const page = store.landingPages.find((p) => p.id === req.params.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const versions = store.pageVersions
    .filter((v) => v.pageId === page.id)
    .sort((a, b) => b.version - a.version);
  return res.json({ data: versions });
});

router.delete('/marketing-os/admin/pages/:id', ...marketingOnly, async (req, res) => {
  const idx = store.landingPages.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Page not found' });
  const [removed] = store.landingPages.splice(idx, 1);
  store.pageVersions = store.pageVersions.filter((v) => v.pageId !== removed.id);
  await deleteLandingPage(removed.id);
  return res.status(204).end();
});

export default router;

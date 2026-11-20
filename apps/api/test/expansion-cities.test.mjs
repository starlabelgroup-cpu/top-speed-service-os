/**
 * Tri-county expansion ring 2 drill (2026-11-20, E8).
 *
 * Proves, in skeleton mode (no database, no network):
 *  1. The canonical ring-2 data (data/expansionCities.js) is sound:
 *     39 real tri-county municipalities — the remaining 23 of Palm
 *     Beach County and 16 of Miami-Dade County — with unique slugs
 *     that match slugify(name) and zero overlap with the 65 cities
 *     already published (the taxonomy seed 12 + the Expander's 53).
 *  2. The Expander's inline CITIES_NEXT list is IDENTICAL to the
 *     canonical data module (the two cannot drift), and every ring
 *     city appears in the Service Areas directory (104 cards).
 *  3. The normal Marketing OS pipeline publishes a ring city exactly
 *     like an existing one: covered taxonomy record → CITY page with
 *     the canonical URL → Speedy CTA enrichment → DRAFT → IN_REVIEW
 *     → PUBLISHED → publicly readable; a duplicate create is a 409.
 *  4. The §10 guardrail still holds: a page for a city that is NOT
 *     service-covered cannot be published (422).
 *  5. Booking parity: a booking naming a ring city resolves through
 *     the exact same area path as one naming a first-expansion city
 *     (recorded, OUT_OF_AREA, honest expansion message, no
 *     auto-match), while a core-12 city still auto-matches IN_AREA.
 *     The 12-city matcher is untouched by the ring.
 *
 * Run: node test/expansion-cities.test.mjs   (exit 0 = pass)
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

delete process.env.DATABASE_URL;
delete process.env.DATABASE_URL_UNPOOLED;
delete process.env.DIRECT_URL;
process.env.JWT_SECRET = 'expansion-cities-drill-secret';
delete process.env.ALLOW_DEMO_AUTH;

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', 'web');

const express = (await import('express')).default;
const { default: marketingOsRouter } = await import('../src/routes/marketingOs.js');
const { default: speedyRouter } = await import('../src/routes/speedy.js');
const { store, PLATFORM_COMPANY_ID } = await import('../src/data/store.js');
const { EXPANSION_RING2_CITIES, COVERAGE_AFTER_RING2 } = await import('../src/data/expansionCities.js');
const { slugify, MARKETING_CITIES } = await import('../src/data/marketingTaxonomy.js');

let failures = 0;
function check(label, ok, extra = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
}

function mintToken(roles) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    sub: 'drill-user', companyId: PLATFORM_COMPANY_ID, email: 'drill@example.test',
    roles, exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const sig = createHmac('sha256', process.env.JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const app = express();
app.use(express.json());
app.use('/api/v1', marketingOsRouter);
app.use('/api/v1', speedyRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}/api/v1`;

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

/* ── 1. Data integrity ─────────────────────────────────────────── */
check('ring has exactly 39 cities', EXPANSION_RING2_CITIES.length === 39, String(EXPANSION_RING2_CITIES.length));
check('county split is 23 Palm Beach + 16 Miami-Dade',
  EXPANSION_RING2_CITIES.filter((c) => c.county === 'Palm Beach').length === 23 &&
  EXPANSION_RING2_CITIES.filter((c) => c.county === 'Miami-Dade').length === 16);
check('names are unique', new Set(EXPANSION_RING2_CITIES.map((c) => c.name)).size === 39);
check('slugs are unique', new Set(EXPANSION_RING2_CITIES.map((c) => c.slug)).size === 39);
check('every slug equals slugify(name)', EXPANSION_RING2_CITIES.every((c) => slugify(c.name) === c.slug));
check('coverage totals: 65 + 39 = 104 cities, 131 + 39 = 170 pages',
  COVERAGE_AFTER_RING2.citiesAfter === 104 && COVERAGE_AFTER_RING2.pagesAfter === 170);

/* ── 2. Expander + directory parity ────────────────────────────── */
const expanderHtml = readFileSync(join(webRoot, 'marketing-os', 'expander', 'index.html'), 'utf8');
function parseNameArray(html, varName) {
  const m = new RegExp(`var ${varName} = \\[([\\s\\S]*?)\\];`).exec(html);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
const phase1Names = parseNameArray(expanderHtml, 'CITIES');
const nextNames = parseNameArray(expanderHtml, 'CITIES_NEXT');
check('expander Phase 1 list parses to 53 cities', Array.isArray(phase1Names) && phase1Names.length === 53);
check('expander CITIES_NEXT is identical to the canonical data module',
  JSON.stringify(nextNames) === JSON.stringify(EXPANSION_RING2_CITIES.map((c) => c.name)));

const existing65 = new Set([
  ...MARKETING_CITIES.filter((c) => c.serviceCovered).map((c) => c.name),
  ...(phase1Names || []),
]);
check('the pre-ring published set is 65 cities', existing65.size === 65, String(existing65.size));
check('ring overlaps none of the existing 65', EXPANSION_RING2_CITIES.every((c) => !existing65.has(c.name)));

const directoryHtml = readFileSync(join(webRoot, 'service-areas-directory', 'index.html'), 'utf8');
const directorySlugs = [...directoryHtml.matchAll(/service-areas\/([a-z0-9-]+)\//g)].map((m) => m[1]);
check('directory lists 104 unique city pages', new Set(directorySlugs).size === 104, String(new Set(directorySlugs).size));
check('every ring city is in the directory', EXPANSION_RING2_CITIES.every((c) => directorySlugs.includes(c.slug)));
check('directory header counts updated (104 cities / 170 pages)',
  directoryHtml.includes('104 cities') && directoryHtml.includes('170 published pages'));

const ctaMatch = /var CTA_BODY = '([^']+)'/.exec(expanderHtml);
check('expander CTA body found (Speedy Booking + Speedy AI)', Boolean(ctaMatch) && ctaMatch[1].includes('Speedy Booking'));
const CTA_BODY = ctaMatch[1];

/* ── 3. The normal pipeline publishes a ring city ──────────────── */
const token = mintToken(['MARKETING_MANAGER']);
const svc = await req('POST', '/marketing-os/admin/taxonomy/services', { token, body: { name: 'Refrigerator', slug: 'refrigerator-repair' } });
check('taxonomy service seeded', svc.status === 201, String(svc.status));

const cityRes = await req('POST', '/marketing-os/admin/taxonomy/cities', {
  token, body: { name: 'Miami Lakes', serviceCovered: true, state: 'FL' },
});
check('ring city taxonomy record created covered', cityRes.status === 201 && cityRes.json.data.serviceCovered === true, String(cityRes.status));
const cityId = cityRes.json.data.id;

const pageRes = await req('POST', '/marketing-os/admin/pages', { token, body: { type: 'CITY', cityId } });
check('city page created as DRAFT', pageRes.status === 201 && pageRes.json.data.status === 'DRAFT', String(pageRes.status));
check('canonical URL follows the city scheme',
  pageRes.json.data.canonicalUrl === 'https://topspeedappliance.net/service-areas/miami-lakes/', pageRes.json.data.canonicalUrl);
const pageId = pageRes.json.data.id;

// The Expander's CTA enrichment, replicated exactly: rewrite every
// cta section's body to the Speedy booking body (append one if the
// generated page has none).
const pageRead = await req('GET', `/marketing-os/admin/pages/${pageId}`, { token });
const sections = (pageRead.json.data.sections || []).map((b) =>
  b.type === 'cta' ? { type: 'cta', heading: 'Book your repair', body: CTA_BODY, phone: '844-460-7038' } : b);
if (!sections.some((b) => b.type === 'cta')) {
  sections.push({ type: 'cta', heading: 'Book your repair', body: CTA_BODY, phone: '844-460-7038' });
}
const patch = await req('PATCH', `/marketing-os/admin/pages/${pageId}`, { token, body: { sections } });
check('CTA enrichment saved', patch.status === 200, String(patch.status));

const review = await req('POST', `/marketing-os/admin/pages/${pageId}/status`, { token, body: { status: 'IN_REVIEW' } });
check('DRAFT → IN_REVIEW', review.status === 200 && review.json.data.status === 'IN_REVIEW', String(review.status));
const publish = await req('POST', `/marketing-os/admin/pages/${pageId}/status`, { token, body: { status: 'PUBLISHED' } });
check('IN_REVIEW → PUBLISHED', publish.status === 200 && publish.json.data.status === 'PUBLISHED', String(publish.status));

const pub = await req('GET', '/marketing-os/pages/by-url?path=service-areas/miami-lakes');
check('published page is publicly readable by URL', pub.status === 200 && pub.json.data.slug === 'service-areas/miami-lakes', String(pub.status));
check('published page carries the Speedy booking CTA',
  JSON.stringify(pub.json.data.sections || []).includes('Book online with Speedy Booking'));
const list = await req('GET', '/marketing-os/pages');
check('published page appears in the public page list',
  (list.json.data || []).some((p) => p.slug === 'service-areas/miami-lakes'));

const dup = await req('POST', '/marketing-os/admin/pages', { token, body: { type: 'CITY', cityId } });
check('duplicate city page refused with 409', dup.status === 409, String(dup.status));

/* ── 4. The §10 publish guardrail still holds ──────────────────── */
const bare = await req('POST', '/marketing-os/admin/taxonomy/cities', {
  token, body: { name: 'Uncovered Testville', serviceCovered: false, state: 'FL' },
});
const barePage = await req('POST', '/marketing-os/admin/pages', { token, body: { type: 'CITY', cityId: bare.json.data.id } });
await req('POST', `/marketing-os/admin/pages/${barePage.json.data.id}/status`, { token, body: { status: 'IN_REVIEW' } });
const barePublish = await req('POST', `/marketing-os/admin/pages/${barePage.json.data.id}/status`, { token, body: { status: 'PUBLISHED' } });
check('uncovered city page cannot publish (422 guardrail)', barePublish.status === 422, String(barePublish.status));

/* ── 5. Booking parity ─────────────────────────────────────────── */
async function book(city, zip) {
  return req('POST', '/speedy/book', {
    body: {
      customer: { name: 'Drill Person', phone: '9545550142', address: '1 Main Street' },
      city, zip, appliance: 'Refrigerator', issue: 'Not cooling at all',
    },
  });
}
const ring = await book('Miami Lakes', '33014');
check('ring-city booking recorded (201)', ring.status === 201, String(ring.status));
check('ring-city booking is OUT_OF_AREA with no auto-match',
  ring.json.data.areaStatus === 'OUT_OF_AREA' && ring.json.data.area === null,
  JSON.stringify(ring.json.data));
check('ring-city booking carries the honest expansion message',
  typeof ring.json.data.areaMessage === 'string' && ring.json.data.areaMessage.includes('expansion list'));
check('ring-city booking is in the store for the setters',
  [...store.bookings.values()].some((b) => b.referenceCode === ring.json.data.referenceCode));

const first = await book('Miami', '33101');
check('first-expansion city booking behaves identically',
  first.status === 201 && first.json.data.areaStatus === ring.json.data.areaStatus &&
  first.json.data.area === ring.json.data.area &&
  first.json.data.areaMessage === ring.json.data.areaMessage);

const core = await book('Fort Lauderdale', '33301');
check('core-12 city still auto-matches IN_AREA',
  core.status === 201 && core.json.data.areaStatus === 'IN_AREA' && core.json.data.area === 'Fort Lauderdale',
  JSON.stringify(core.json.data));

server.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

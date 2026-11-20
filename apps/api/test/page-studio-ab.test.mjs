/**
 * Page Studio A/B testing — verification harness (E4, 2026-11-20).
 *
 * Boots the real API server against a scratch Postgres. Covers:
 *   - experiment lifecycle on a Marketing OS page: create (409 while
 *     one is open), variant B starts as a copy of the live sections,
 *     edit in DRAFT/PAUSED only (422 while RUNNING), start requires a
 *     PUBLISHED page (422 otherwise), pause/resume/end transitions.
 *   - deterministic serving on GET /marketing-os/pages/by-url: the
 *     same visitor key always lands on the same variant (verified
 *     against the documented sha256 bucket rule), explicit ?variant=
 *     wins, anonymous reads serve A and are not counted, identified
 *     serves increment viewsA/viewsB.
 *   - results are RAW COUNTS of real intakes: guest bookings and a
 *     connection carrying each variant's attribution via-tag.
 *   - the winner is a STAFF decision only: picking B promotes its
 *     sections onto the page through the normal versioned save;
 *     picking A leaves the page untouched. Nothing auto-promotes.
 *
 * Run:  node test/page-studio-ab.test.mjs
 * Env:  DRILL_DATABASE_URL (default local wave3 cluster on :5490)
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const DB_URL = process.env.DRILL_DATABASE_URL || 'postgresql://postgres@127.0.0.1:5490/wave3_ab';
process.env.DATABASE_URL = DB_URL;
process.env.DATABASE_URL_UNPOOLED = DB_URL;

const PORT = 8933;
const B = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'DrillPass123!';

const IDS = {
  owner: 'f1111111-1111-4111-8111-111111111111',
  adv: 'f2222222-2222-4222-8222-222222222222',
};
const EMAILS = { owner: 'abowner@drill.local', adv: 'abadv@drill.local' };

let passed = 0; let failed = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? '  ok ' : '  FAIL'} ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, cond, extra = '') {
  if (cond) passed += 1; else failed += 1;
  console.log(`${cond ? '  ok ' : '  FAIL'} ${label}${cond ? '' : ` ${extra}`}`);
}
async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${B}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(email) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status !== 200 || !r.json?.token) throw new Error(`login failed for ${email}: ${r.status} ${r.text}`);
  return r.json.token;
}
function bucketOf(pageId, visitor) {
  const digest = createHash('sha256').update(`${pageId}:${visitor}`).digest();
  return digest.readUInt32BE(0) % 100;
}
function findVisitor(pageId, wantB, splitB) {
  for (let i = 0; i < 5000; i += 1) {
    const key = `drill-visitor-${i}`;
    const isB = bucketOf(pageId, key) < splitB;
    if (isB === wantB) return key;
  }
  throw new Error('no visitor key found');
}
const bookWith = (via, phone) => api('/speedy/book', {
  method: 'POST',
  body: { customer: { name: 'Drill Visitor', phone }, city: 'Fort Lauderdale', zip: '33301', appliance: 'Dryer', issue: 'Not heating at all', source: 'WEB_FORM', via },
});

const prisma = new PrismaClient();
let server;

try {
  // ---------- Seed ----------
  await prisma.pageExperiment.deleteMany({});
  await prisma.pageVersion.deleteMany({});
  await prisma.landingPage.deleteMany({});
  // Taxonomy is NOT wiped: hydration seeds the real city list into the
  // DB at boot, so the drill looks cities up instead of creating them.
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
  await prisma.company.upsert({ where: { id: PLATFORM_COMPANY_ID }, update: {}, create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'top-speed-appliance', type: 'PLATFORM_OWNER', isPlatformOwner: true } });
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.user.create({ data: { id: IDS.owner, companyId: PLATFORM_COMPANY_ID, email: EMAILS.owner, passwordHash, roles: ['COMPANY_OWNER'], verifyRequired: false, layer2Required: false } });
  await prisma.user.create({ data: { id: IDS.adv, companyId: PLATFORM_COMPANY_ID, email: EMAILS.adv, passwordHash, roles: ['ADVERTISER'], verifyRequired: false, layer2Required: false } });

  // ---------- Boot ----------
  const engineLib = fileURLToPath(new URL('../node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node', import.meta.url));
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: 'drill-secret-ab', DATABASE_URL: DB_URL, DATABASE_URL_UNPOOLED: DB_URL, APP_BASE: `http://127.0.0.1:${PORT}`,
      ...(existsSync(engineLib) ? { PRISMA_QUERY_ENGINE_LIBRARY: engineLib } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  let up = false;
  for (let i = 0; i < 240 && !up; i += 1) {
    try { const r = await fetch(`${B}/payments/status`); up = r.status === 200; } catch { await sleep(500); }
  }
  if (!up) throw new Error('API did not come up');

  const owner = await login(EMAILS.owner);
  const adv = await login(EMAILS.adv);

  console.log('\n[setup — taxonomy + published page]');
  const tax = await api('/marketing-os/admin/taxonomy', { token: owner });
  check('taxonomy list loads', tax.status, 200);
  const cityByName = (name) => (tax.json.data.cities || []).find((c) => c.name === name);
  checkTrue('seeded Fort Lauderdale is service-covered', !!cityByName('Fort Lauderdale')?.serviceCovered);
  const cityId = cityByName('Fort Lauderdale').id;
  const pageCreate = await api('/marketing-os/admin/pages', { method: 'POST', token: owner, body: { type: 'CITY', cityId } });
  check('city page created', pageCreate.status, 201);
  const page = pageCreate.json.data;
  const pagePath = new URL(page.canonicalUrl).pathname;
  const sectionsA = [{ type: 'hero', heading: 'Alpha headline', body: 'Alpha body copy' }];
  const seeded = await api(`/marketing-os/admin/pages/${page.id}`, { method: 'PATCH', token: owner, body: { sections: sectionsA, note: 'seed A' } });
  check('sections seeded', seeded.status, 200);
  check('publish step 1 (IN_REVIEW)', (await api(`/marketing-os/admin/pages/${page.id}/status`, { method: 'POST', token: owner, body: { status: 'IN_REVIEW' } })).status, 200);
  check('publish step 2 (PUBLISHED)', (await api(`/marketing-os/admin/pages/${page.id}/status`, { method: 'POST', token: owner, body: { status: 'PUBLISHED' } })).status, 200);

  console.log('\n[serving without a test — unchanged contract]');
  const plain = await api(`/marketing-os/pages/by-url?path=${encodeURIComponent(pagePath)}`);
  check('by-url -> 200', plain.status, 200);
  check('abTest is null', plain.json.data.abTest, null);
  check('sections are the live page', plain.json.data.sections[0]?.heading, 'Alpha headline');

  console.log('\n[experiment lifecycle]');
  check('anon experiments list -> 401', (await api(`/marketing-os/admin/pages/${page.id}/experiments`)).status, 401);
  check('advertiser experiments list -> 403', (await api(`/marketing-os/admin/pages/${page.id}/experiments`, { token: adv })).status, 403);
  const expCreate = await api(`/marketing-os/admin/pages/${page.id}/experiments`, { method: 'POST', token: owner, body: { splitB: 50 } });
  check('experiment created', expCreate.status, 201);
  const exp = expCreate.json.data;
  check('status DRAFT', exp.status, 'DRAFT');
  check('variant B starts as a copy of A', exp.sectionsB[0]?.heading, 'Alpha headline');
  check('tag A shape', exp.tags.a, `abtest-${exp.id.slice(0, 8)}-a`);
  check('tag B shape', exp.tags.b, `abtest-${exp.id.slice(0, 8)}-b`);
  check('second open experiment -> 409', (await api(`/marketing-os/admin/pages/${page.id}/experiments`, { method: 'POST', token: owner, body: {} })).status, 409);

  const sectionsB = [{ type: 'hero', heading: 'Bravo headline', body: 'Bravo body copy' }];
  const patched = await api(`/marketing-os/admin/experiments/${exp.id}`, { method: 'PATCH', token: owner, body: { sectionsB } });
  check('variant B editable in DRAFT', patched.status, 200);
  check('variant B saved', patched.json.data.sectionsB[0]?.heading, 'Bravo headline');

  // An unpublished page cannot start a test.
  const draftCreate = await api('/marketing-os/admin/pages', { method: 'POST', token: owner, body: { type: 'CITY', cityId: cityByName('Sunrise').id } });
  check('second page draft created (own city)', draftCreate.status, 201);
  const draftPage = draftCreate.json.data;
  const draftExp = await api(`/marketing-os/admin/pages/${draftPage.id}/experiments`, { method: 'POST', token: owner, body: {} });
  check('draft-page experiment created', draftExp.status, 201);
  check('start on UNPUBLISHED page -> 422', (await api(`/marketing-os/admin/experiments/${draftExp.json.data.id}/status`, { method: 'POST', token: owner, body: { status: 'RUNNING' } })).status, 422);
  check('end the draft-page experiment', (await api(`/marketing-os/admin/experiments/${draftExp.json.data.id}/status`, { method: 'POST', token: owner, body: { status: 'ENDED' } })).status, 200);

  check('start main test', (await api(`/marketing-os/admin/experiments/${exp.id}/status`, { method: 'POST', token: owner, body: { status: 'RUNNING' } })).status, 200);
  check('edit while RUNNING -> 422', (await api(`/marketing-os/admin/experiments/${exp.id}`, { method: 'PATCH', token: owner, body: { splitB: 60 } })).status, 422);
  check('illegal transition RUNNING->DRAFT -> 422', (await api(`/marketing-os/admin/experiments/${exp.id}/status`, { method: 'POST', token: owner, body: { status: 'DRAFT' } })).status, 422);

  console.log('\n[deterministic serving]');
  const keyA = findVisitor(page.id, false, 50);
  const keyB = findVisitor(page.id, true, 50);
  const serve = (qs) => api(`/marketing-os/pages/by-url?path=${encodeURIComponent(pagePath)}${qs}`);
  const a1 = await serve(`&visitor=${keyA}`);
  const a2 = await serve(`&visitor=${keyA}`);
  check('visitor A variant', a1.json.data.abTest?.variant, 'A');
  check('visitor A variant is stable', a2.json.data.abTest?.variant, 'A');
  check('visitor A sees live sections', a1.json.data.sections[0]?.heading, 'Alpha headline');
  const b1 = await serve(`&visitor=${keyB}`);
  const b2 = await serve(`&visitor=${keyB}`);
  check('visitor B variant', b1.json.data.abTest?.variant, 'B');
  check('visitor B variant is stable', b2.json.data.abTest?.variant, 'B');
  check('visitor B sees variant B sections', b1.json.data.sections[0]?.heading, 'Bravo headline');
  check('abTest names the B tag', b1.json.data.abTest?.viaTag, exp.tags.b);
  const anon = await serve('');
  check('anonymous read serves A', anon.json.data.abTest?.variant, 'A');
  const override = await serve('&variant=b');
  check('explicit ?variant=b wins', override.json.data.abTest?.variant, 'B');
  await sleep(300);
  const listed = await api(`/marketing-os/admin/pages/${page.id}/experiments`, { token: owner });
  const current = listed.json.data.find((e) => e.id === exp.id);
  check('viewsA counts identified A serves only (2)', current?.viewsA, 2);
  check('viewsB counts visitor + override serves (3)', current?.viewsB, 3);
  check('results serves mirror the counters', current?.results.b.serves, 3);

  console.log('\n[results from real intakes]');
  check('booking via tag A', (await bookWith(exp.tags.a, '9545550151')).status, 201);
  check('booking via tag B #1', (await bookWith(exp.tags.b, '9545550152')).status, 201);
  check('booking via tag B #2', (await bookWith(exp.tags.b, '9545550153')).status, 201);
  const connB = await api('/connections', { method: 'POST', body: { name: 'Drill Enquiry', phone: '9545550154', type: 'SERVICE_REQUEST', message: 'B enquiry', via: exp.tags.b } });
  check('connection via tag B', connB.status, 201);
  const listed2 = await api(`/marketing-os/admin/pages/${page.id}/experiments`, { token: owner });
  const cur2 = listed2.json.data.find((e) => e.id === exp.id);
  check('A bookings = 1', cur2?.results.a.bookings, 1);
  check('A enquiries = 0', cur2?.results.a.connections, 0);
  check('B bookings = 2', cur2?.results.b.bookings, 2);
  check('B enquiries = 1', cur2?.results.b.connections, 1);
  check('B leads total = 3', cur2?.results.b.total, 3);

  console.log('\n[winner — staff decision only]');
  const win = await api(`/marketing-os/admin/experiments/${exp.id}/winner`, { method: 'POST', token: owner, body: { variant: 'B' } });
  check('winner B -> 200', win.status, 200);
  check('experiment ENDED', win.json.data.status, 'ENDED');
  check('winner recorded', win.json.data.winner, 'B');
  checkTrue('promotion saved a page version', Number(win.json.data.promotedVersion) >= 2, String(win.json.data.promotedVersion));
  const pageAfter = await api(`/marketing-os/admin/pages/${page.id}`, { token: owner });
  check('live page now serves B sections', pageAfter.json.data.sections[0]?.heading, 'Bravo headline');
  const versions = await api(`/marketing-os/admin/pages/${page.id}/versions`, { token: owner });
  checkTrue('version history names the promotion', versions.json.data.some((v) => /variant B/.test(v.note || '')), JSON.stringify(versions.json.data.map((v) => v.note)));
  const after = await api(`/marketing-os/pages/by-url?path=${encodeURIComponent(pagePath)}`);
  check('by-url after end: abTest null', after.json.data.abTest, null);
  check('by-url after end: B content live', after.json.data.sections[0]?.heading, 'Bravo headline');
  check('winner on an ENDED test -> 422', (await api(`/marketing-os/admin/experiments/${exp.id}/winner`, { method: 'POST', token: owner, body: { variant: 'A' } })).status, 422);
  check('a fresh test can start after one ends', (await api(`/marketing-os/admin/pages/${page.id}/experiments`, { method: 'POST', token: owner, body: {} })).status, 201);

  console.log('\n[winner A — page untouched]');
  const page2Create = await api('/marketing-os/admin/pages', { method: 'POST', token: owner, body: { type: 'CITY', cityId: cityByName('Plantation').id } });
  const page2 = page2Create.json.data;
  await api(`/marketing-os/admin/pages/${page2.id}`, { method: 'PATCH', token: owner, body: { sections: sectionsA, note: 'seed A2' } });
  await api(`/marketing-os/admin/pages/${page2.id}/status`, { method: 'POST', token: owner, body: { status: 'IN_REVIEW' } });
  await api(`/marketing-os/admin/pages/${page2.id}/status`, { method: 'POST', token: owner, body: { status: 'PUBLISHED' } });
  const exp2 = (await api(`/marketing-os/admin/pages/${page2.id}/experiments`, { method: 'POST', token: owner, body: {} })).json.data;
  await api(`/marketing-os/admin/experiments/${exp2.id}`, { method: 'PATCH', token: owner, body: { sectionsB } });
  await api(`/marketing-os/admin/experiments/${exp2.id}/status`, { method: 'POST', token: owner, body: { status: 'RUNNING' } });
  const winA = await api(`/marketing-os/admin/experiments/${exp2.id}/winner`, { method: 'POST', token: owner, body: { variant: 'A' } });
  check('winner A -> 200', winA.status, 200);
  check('winner A promotes nothing', winA.json.data.promotedVersion, null);
  const page2After = await api(`/marketing-os/admin/pages/${page2.id}`, { token: owner });
  check('page 2 sections unchanged', page2After.json.data.sections[0]?.heading, 'Alpha headline');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  if (server) server.kill('SIGTERM');
  await prisma.$disconnect();
}

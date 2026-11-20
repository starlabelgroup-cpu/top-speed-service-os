/**
 * Advertiser growth package — verification harness (E2 + E3, 2026-11-20).
 *
 * Boots the real API server against a scratch Postgres. Covers:
 *   E2 — GET /ad-studio/my-results: the advertiser's OWN recorded
 *        impressions/clicks/leads only (owner-scoped; another
 *        advertiser's campaigns never appear), gated by the plan
 *        'attribution' feature exactly like the rest of the matrix
 *        (grandfathered baseline does NOT include it -> 403
 *        plan_upgrade_required; a Pro grant includes it -> 200).
 *   E3 — advertiser creative uploads: magic-byte validated image
 *        data URLs (JPEG/PNG/WebP), real header dimensions, 6 MB cap;
 *        attach to own campaigns only; the public image route serves
 *        ONLY while an attached campaign is ACTIVE (the ReviewMedia
 *        published-only rule); delete detaches drafts/paused and is
 *        refused (409) while a campaign is pending or live.
 *
 * Counts are produced by the REAL tracking surface: display serves,
 * the click redirect, a guest booking and a connection carrying the
 * campaign's sourceTag.
 *
 * Run:  node test/advertiser-growth.test.mjs
 * Env:  DRILL_DATABASE_URL (default local wave3 cluster on :5490)
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const DB_URL = process.env.DRILL_DATABASE_URL || 'postgresql://postgres@127.0.0.1:5490/wave3_growth';
process.env.DATABASE_URL = DB_URL;
process.env.DATABASE_URL_UNPOOLED = DB_URL;

const PORT = 8931;
const B = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'DrillPass123!';

const IDS = {
  owner: 'e1111111-1111-4111-8111-111111111111',
  advPro: 'e2222222-2222-4222-8222-222222222222',
  advOther: 'e3333333-3333-4333-8333-333333333333',
  advOld: 'e4444444-4444-4444-8444-444444444444',
  advNone: 'e5555555-5555-4555-8555-555555555555',
};
const EMAILS = Object.fromEntries(Object.entries(IDS).map(([k, v]) => [k, `${k.toLowerCase()}@drill.local`]));

// ---------- Harness ----------
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
async function raw(path, { token } = {}) {
  const res = await fetch(`${B}${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) }, redirect: 'manual' });
  return { status: res.status, type: res.headers.get('content-type') || '', location: res.headers.get('location') || '' };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(email) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status !== 200 || !r.json?.token) throw new Error(`login failed for ${email}: ${r.status} ${r.text}`);
  return r.json.token;
}
// Unique per run: a campaign's sourceTag derives from its name, and
// lead counts are tag-based — a fixed name would count a previous
// run's tagged bookings again.
const RUN = `r${Date.now().toString(36)}`;
const campaignBody = (name, extra = {}) => ({
  name: `${name} ${RUN}`, advertiserName: 'Drill Biz', offering: 'Appliance repair services',
  headline: `${name} headline`, copy: 'Drill campaign body copy.', ctaText: 'Book Service',
  destinationUrl: '/book', ...extra,
});

// Image fixtures — real format bytes, authored here.
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_32X16 = `data:image/jpeg;base64,${Buffer.from('ffd8ffe000104a46494600010100000100010000ffc00011080010002003012200021101031101ffd9', 'hex').toString('base64')}`;
const WEBP_300X250 = `data:image/webp;base64,${Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([22, 0, 0, 0]), Buffer.from('WEBPVP8X'),
  Buffer.from([10, 0, 0, 0]), Buffer.from([0, 0, 0, 0]),
  Buffer.from([0x2b, 0x01, 0x00]), Buffer.from([0xf9, 0x00, 0x00]),
]).toString('base64')}`;
const TEXT_AS_PNG = `data:image/png;base64,${Buffer.from('hello world, definitely not an image').toString('base64')}`;
const OVERSIZE_PNG = `data:image/png;base64,${Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(6 * 1024 * 1024, 7),
]).toString('base64')}`;

const prisma = new PrismaClient();
let server;

try {
  // ---------- Seed ----------
  await prisma.advertiserCreative.deleteMany({});
  await prisma.adCampaign.deleteMany({ where: { createdById: { in: Object.values(IDS) } } });
  await prisma.advertiserSubscription.deleteMany({ where: { userId: { in: Object.values(IDS) } } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
  await prisma.company.upsert({ where: { id: PLATFORM_COMPANY_ID }, update: {}, create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'top-speed-appliance', type: 'PLATFORM_OWNER', isPlatformOwner: true } });
  const passwordHash = await hashPassword(PASSWORD);
  const mkUser = (id, email, roles, createdAt) => prisma.user.create({
    data: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, roles, verifyRequired: false, layer2Required: false, createdAt },
  });
  const NOW = new Date();
  const LONG_AGO = new Date('2026-01-15T00:00:00.000Z'); // before the plans launch cutoff
  await mkUser(IDS.owner, EMAILS.owner, ['COMPANY_OWNER'], NOW);
  await mkUser(IDS.advPro, EMAILS.advPro, ['ADVERTISER'], NOW);
  await mkUser(IDS.advOther, EMAILS.advOther, ['ADVERTISER'], NOW);
  await mkUser(IDS.advOld, EMAILS.advOld, ['ADVERTISER'], LONG_AGO);
  await mkUser(IDS.advNone, EMAILS.advNone, ['ADVERTISER'], NOW);

  // ---------- Boot ----------
  const engineLib = fileURLToPath(new URL('../node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node', import.meta.url));
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: 'drill-secret-growth', DATABASE_URL: DB_URL, DATABASE_URL_UNPOOLED: DB_URL, APP_BASE: `http://127.0.0.1:${PORT}`,
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
  const advPro = await login(EMAILS.advPro);
  const advOther = await login(EMAILS.advOther);
  const advOld = await login(EMAILS.advOld);
  const advNone = await login(EMAILS.advNone);

  // Pro grants (attribution included) for the two working advertisers.
  check('owner grants Pro to advPro', (await api(`/ad-studio/subscriptions/${IDS.advPro}/grant`, { method: 'POST', token: owner, body: { planKey: 'pro' } })).status, 200);
  check('owner grants Pro to advOther', (await api(`/ad-studio/subscriptions/${IDS.advOther}/grant`, { method: 'POST', token: owner, body: { planKey: 'pro' } })).status, 200);

  console.log('\n[E2 — results dashboard gating]');
  check('anon my-results -> 401', (await api('/ad-studio/my-results')).status, 401);
  check('owner (staff) my-results -> 403 advertiser-only', (await api('/ad-studio/my-results', { token: owner })).status, 403);
  const oldRes = await api('/ad-studio/my-results', { token: advOld });
  check('grandfathered baseline my-results -> 403 (attribution not in baseline)', oldRes.status, 403);
  check('denial code', oldRes.json.error, 'plan_upgrade_required');
  check('denial feature', oldRes.json.feature, 'attribution');
  check('no-plan advertiser my-results -> 403', (await api('/ad-studio/my-results', { token: advNone })).status, 403);

  console.log('\n[E2 — recorded counts, owner-scoped]');
  const alphaCreate = await api('/ad-studio/my-campaigns', { method: 'POST', token: advPro, body: campaignBody('Alpha Ads') });
  check('advPro creates Alpha', alphaCreate.status, 201);
  const alpha = alphaCreate.json.data;
  const betaCreate = await api('/ad-studio/my-campaigns', { method: 'POST', token: advOther, body: campaignBody('Beta Ads') });
  check('advOther creates Beta', betaCreate.status, 201);
  const beta = betaCreate.json.data;
  checkTrue('campaigns carry distinct sourceTags', alpha.sourceTag && beta.sourceTag && alpha.sourceTag !== beta.sourceTag);

  const empty = await api('/ad-studio/my-results', { token: advPro });
  check('results before any serve -> 200', empty.status, 200);
  check('Alpha starts at zero impressions', empty.json.data.campaigns.find((c) => c.id === alpha.id)?.impressions, 0);
  checkTrue('counting notes are present', typeof empty.json.data.counting?.impressions === 'string' && empty.json.data.counting.impressions.length > 10);

  check('submit Alpha', (await api(`/ad-studio/my-campaigns/${alpha.id}/submit`, { method: 'POST', token: advPro, body: {} })).status, 200);
  check('owner approves Alpha', (await api(`/ad-studio/campaigns/${alpha.id}/approve`, { method: 'POST', token: owner, body: {} })).status, 200);

  for (let i = 0; i < 3; i += 1) await raw('/ad-studio/display');
  const click1 = await raw(`/ad-studio/click/${alpha.id}`);
  check('click redirects (302)', click1.status, 302);
  await raw(`/ad-studio/click/${alpha.id}`);
  const book = await api('/speedy/book', {
    method: 'POST',
    body: { customer: { name: 'Drill Customer', phone: '9545550141' }, city: 'Fort Lauderdale', zip: '33301', appliance: 'Refrigerator', issue: 'Not cooling at all', source: 'WEB_FORM', via: alpha.sourceTag },
  });
  check('tagged guest booking -> 201', book.status, 201);
  const conn = await api('/connections', {
    method: 'POST',
    body: { name: 'Drill Enquiry', phone: '9545550142', type: 'SERVICE_REQUEST', message: 'Drill enquiry', via: alpha.sourceTag },
  });
  check('tagged connection -> 201', conn.status, 201);
  await sleep(400); // banner counters persist fire-and-forget

  const res = await api('/ad-studio/my-results', { token: advPro });
  check('advPro results -> 200', res.status, 200);
  const alphaRow = res.json.data.campaigns.find((c) => c.id === alpha.id);
  checkTrue('Alpha row present', !!alphaRow);
  check('Alpha impressions = 3 serves', alphaRow?.impressions, 3);
  check('Alpha clicks = 2', alphaRow?.clicks, 2);
  check('Alpha bookings = 1', alphaRow?.leads.bookings, 1);
  check('Alpha enquiries = 1', alphaRow?.leads.connections, 1);
  check('Alpha leads total = 2', alphaRow?.leads.total, 2);
  checkTrue('Alpha ctr = 2/3', Math.abs((alphaRow?.ctr ?? -1) - 2 / 3) < 0.001, String(alphaRow?.ctr));
  check('totals campaigns = 1 (own only)', res.json.data.totals.campaigns, 1);
  checkTrue('Beta never appears in advPro results', !res.json.data.campaigns.some((c) => c.id === beta.id));

  const otherRes = await api('/ad-studio/my-results', { token: advOther });
  check('advOther results -> 200', otherRes.status, 200);
  check('advOther sees only Beta', otherRes.json.data.campaigns.length, 1);
  check('Beta impressions = 0 (never served)', otherRes.json.data.campaigns[0]?.impressions, 0);
  check('Beta leads = 0', otherRes.json.data.campaigns[0]?.leads.total, 0);
  check('Beta ctr is null at zero impressions', otherRes.json.data.campaigns[0]?.ctr, null);

  console.log('\n[E3 — creative uploads]');
  check('anon upload -> 401', (await api('/ad-studio/my-creatives', { method: 'POST', body: { imageDataUrl: PNG_1X1 } })).status, 401);
  const up1 = await api('/ad-studio/my-creatives', { method: 'POST', token: advPro, body: { name: 'Drill PNG', imageDataUrl: PNG_1X1 } });
  check('PNG upload -> 201', up1.status, 201);
  const png = up1.json.data;
  check('PNG mime recorded', png.mimeType, 'image/png');
  check('PNG width read from header', png.width, 1);
  check('PNG height read from header', png.height, 1);
  checkTrue('PNG size recorded', png.sizeBytes > 50 && png.sizeBytes < 200, String(png.sizeBytes));

  const mislabeled = await api('/ad-studio/my-creatives', { method: 'POST', token: advPro, body: { imageDataUrl: PNG_1X1.replace('image/png', 'image/jpeg') } });
  check('PNG bytes declared as JPEG -> 400', mislabeled.status, 400);
  check('plain text declared as PNG -> 400', (await api('/ad-studio/my-creatives', { method: 'POST', token: advPro, body: { imageDataUrl: TEXT_AS_PNG } })).status, 400);
  check('remote URL instead of a file -> 400', (await api('/ad-studio/my-creatives', { method: 'POST', token: advPro, body: { imageDataUrl: 'https://example.com/banner.png' } })).status, 400);
  const big = await api('/ad-studio/my-creatives', { method: 'POST', token: advPro, body: { imageDataUrl: OVERSIZE_PNG } });
  check('over-6MB upload -> 400', big.status, 400);
  checkTrue('oversize message names the cap', /6 MB/.test(big.json.error || ''), big.text);

  const upJpeg = await api('/ad-studio/my-creatives', { method: 'POST', token: advPro, body: { name: 'Drill JPEG', imageDataUrl: JPEG_32X16 } });
  check('JPEG upload -> 201', upJpeg.status, 201);
  check('JPEG width from SOF', upJpeg.json.data.width, 32);
  check('JPEG height from SOF', upJpeg.json.data.height, 16);
  const upWebp = await api('/ad-studio/my-creatives', { method: 'POST', token: advPro, body: { name: 'Drill WebP', imageDataUrl: WEBP_300X250 } });
  check('WebP upload -> 201', upWebp.status, 201);
  check('WebP width from VP8X', upWebp.json.data.width, 300);
  check('WebP height from VP8X', upWebp.json.data.height, 250);

  const otherUp = await api('/ad-studio/my-creatives', { method: 'POST', token: advOther, body: { name: 'Other PNG', imageDataUrl: PNG_1X1 } });
  check('advOther upload -> 201', otherUp.status, 201);
  const list = await api('/ad-studio/my-creatives', { token: advPro });
  check('library lists only own uploads', list.json.data.length, 3);
  checkTrue("other advertiser's upload absent", !list.json.data.some((c) => c.id === otherUp.json.data.id));

  console.log('\n[E3 — attach + approval flow]');
  const steal = await api('/ad-studio/my-campaigns', { method: 'POST', token: advPro, body: campaignBody('Gamma Steal', { creativeUploadId: otherUp.json.data.id }) });
  check("attaching another advertiser's creative -> 400", steal.status, 400);
  const deltaCreate = await api('/ad-studio/my-campaigns', { method: 'POST', token: advPro, body: campaignBody('Delta Img', { creativeUploadId: png.id }) });
  check('create with own creative -> 201', deltaCreate.status, 201);
  const delta = deltaCreate.json.data;
  check('campaign records the creative', delta.creativeUploadId, png.id);
  check('campaign imageUrl is the creative route', delta.imageUrl, `/api/v1/ad-studio/creatives/${png.id}/image`);

  check('public image while DRAFT -> 404', (await raw(`/ad-studio/creatives/${png.id}/image`)).status, 404);
  const ownImg = await raw(`/ad-studio/my-creatives/${png.id}/image`, { token: advPro });
  check('owner image route -> 200', ownImg.status, 200);
  checkTrue('owner image content-type is png', ownImg.type.includes('image/png'), ownImg.type);
  check("other advertiser's owner route -> 404", (await raw(`/ad-studio/my-creatives/${png.id}/image`, { token: advOther })).status, 404);

  check('submit Delta', (await api(`/ad-studio/my-campaigns/${delta.id}/submit`, { method: 'POST', token: advPro, body: {} })).status, 200);
  check('public image while PENDING_APPROVAL -> 404', (await raw(`/ad-studio/creatives/${png.id}/image`)).status, 404);
  const delPending = await fetch(`${B}/ad-studio/my-creatives/${png.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${advPro}` } });
  check('delete while PENDING_APPROVAL -> 409', delPending.status, 409);

  check('owner approves Delta', (await api(`/ad-studio/campaigns/${delta.id}/approve`, { method: 'POST', token: owner, body: {} })).status, 200);
  const pubImg = await raw(`/ad-studio/creatives/${png.id}/image`);
  check('public image while ACTIVE -> 200', pubImg.status, 200);
  checkTrue('public image content-type is png', pubImg.type.includes('image/png'), pubImg.type);
  const delActive = await fetch(`${B}/ad-studio/my-creatives/${png.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${advPro}` } });
  check('delete while ACTIVE -> 409', delActive.status, 409);

  check('pause Delta', (await api(`/ad-studio/my-campaigns/${delta.id}/pause`, { method: 'POST', token: advPro, body: {} })).status, 200);
  check('public image after pause -> 404', (await raw(`/ad-studio/creatives/${png.id}/image`)).status, 404);
  const delPaused = await fetch(`${B}/ad-studio/my-creatives/${png.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${advPro}` } });
  check('delete while PAUSED -> 204 (detaches)', delPaused.status, 204);
  const mine = await api('/ad-studio/my-campaigns', { token: advPro });
  const deltaAfter = mine.json.data.find((c) => c.id === delta.id);
  check('Delta creativeUploadId cleared', deltaAfter?.creativeUploadId ?? null, null);
  check('Delta imageUrl cleared', deltaAfter?.imageUrl ?? null, null);
  check('owner image after delete -> 404', (await raw(`/ad-studio/my-creatives/${png.id}/image`, { token: advPro })).status, 404);
  const listAfter = await api('/ad-studio/my-creatives', { token: advPro });
  check('library shrinks to 2', listAfter.json.data.length, 2);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  if (server) server.kill('SIGTERM');
  await prisma.$disconnect();
}

/**
 * Streaming Ads channel — verification harness (2026-11-17).
 *
 * Exercises the Flywheel Streaming Ads build in routes/adStudio.js
 * end to end over HTTP: the owner-only pack loader (creates the 10
 * Google-style ads in PENDING_APPROVAL, idempotent by source tag),
 * the lifecycle gates (staff cannot approve, approval is owner-only),
 * feed isolation (streaming campaigns NEVER enter the public
 * /ad-studio/display banner feed, even when ACTIVE, while a BANNER
 * campaign does), advertiser isolation (the pack belongs to the
 * owner; advertisers see none of it), streaming creative validation,
 * and the pack's copy rules (no phone numbers, no review/rating
 * claims, no $99 in the commercial ad).
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://.../tsos_streaming_test \
 *   node test/streaming-ads.test.mjs
 * The harness seeds its own users, boots the real API on TEST_PORT
 * (default 4423), and cleans up. Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4423);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  owner: '20000000-0000-4000-8000-0000000000e1',
  manager: '20000000-0000-4000-8000-0000000000e2',
  advertiser: '20000000-0000-4000-8000-0000000000e3',
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function login(email) {
  const { status, json } = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    { id: IDS.owner, email: 'owner@test.local', roles: ['COMPANY_OWNER'] },
    { id: IDS.manager, email: 'manager@test.local', roles: ['MARKETING_MANAGER'] },
    { id: IDS.advertiser, email: 'advertiser@test.local', roles: ['ADVERTISER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash, phone: '9545550100', roles: u.roles, active: true },
    });
  }
}

async function cleanup() {
  try {
    await prisma.adCampaign.deleteMany({ where: { OR: [{ sourceTag: { startsWith: 'flywheel-streaming-' } }, { sourceTag: { startsWith: 'adstudio-streaming-test' } }, { sourceTag: { startsWith: 'adstudio-banner-test' } }] } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not come up');
}

async function main() {
  await cleanup();
  await seed();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: process.env.JWT_SECRET || 'streaming-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  // ── Auth gates ────────────────────────────────────────────────
  check('campaigns unauthenticated', (await api('/ad-studio/campaigns')).status, 401);
  check('streaming-pack unauthenticated', (await api('/ad-studio/streaming-pack')).status, 401);
  check('pack load unauthenticated', (await api('/ad-studio/streaming-pack/load', { method: 'POST', body: {} })).status, 401);

  const owner = await login('owner@test.local');
  const manager = await login('manager@test.local');
  const advertiser = await login('advertiser@test.local');

  // ── Pack state before loading ─────────────────────────────────
  const before = await api('/ad-studio/streaming-pack', { token: owner });
  check('pack status 200', before.status, 200);
  check('pack total', before.json.data.total, 10);
  check('pack loaded before', before.json.data.loaded, 0);
  check('pack providers listed', before.json.data.providers.length, 7);

  // ── Loader is owner-only ──────────────────────────────────────
  check('manager cannot load pack', (await api('/ad-studio/streaming-pack/load', { token: manager, method: 'POST', body: {} })).status, 403);
  check('advertiser cannot load pack', (await api('/ad-studio/streaming-pack/load', { token: advertiser, method: 'POST', body: {} })).status, 403);

  // ── Load the pack ─────────────────────────────────────────────
  const load = await api('/ad-studio/streaming-pack/load', { token: owner, method: 'POST', body: {} });
  check('pack load 201', load.status, 201);
  check('pack created count', load.json.data.created.length, 10);
  check('pack skipped count', load.json.data.skipped.length, 0);
  checkTrue('pack tags are flywheel-streaming-01..10', load.json.data.created.includes('flywheel-streaming-01') && load.json.data.created.includes('flywheel-streaming-10'));

  const list = await api('/ad-studio/campaigns?placement=STREAMING', { token: owner });
  check('streaming campaigns listed', list.json.data.length, 10);
  checkTrue('all PENDING_APPROVAL', list.json.data.every((c) => c.status === 'PENDING_APPROVAL'));
  checkTrue('all placement STREAMING', list.json.data.every((c) => c.placement === 'STREAMING'));
  check('five TEXT', list.json.data.filter((c) => c.streamingFormat === 'TEXT').length, 5);
  check('five DISPLAY', list.json.data.filter((c) => c.streamingFormat === 'DISPLAY').length, 5);

  const byTag = Object.fromEntries(list.json.data.map((c) => [c.sourceTag, c]));
  check('ad 01 destination', byTag['flywheel-streaming-01'].destinationUrl, 'https://topspeedserviceos.com/book');
  check('ad 07 destination (commercial)', byTag['flywheel-streaming-07'].destinationUrl, 'https://topspeedserviceos.com/commercial');
  check('ad 08 destination (speedy)', byTag['flywheel-streaming-08'].destinationUrl, 'https://topspeedserviceos.com/speedy');
  check('ad 09 destination (refer)', byTag['flywheel-streaming-09'].destinationUrl, 'https://topspeedserviceos.com/refer');
  check('ad 01 display path', byTag['flywheel-streaming-01'].displayPath, 'Refrigerator-Repair');
  check('ad 02 sizes count', byTag['flywheel-streaming-02'].displaySizes.length, 6);
  checkTrue('ad 02 has long headline', Boolean(byTag['flywheel-streaming-02'].longHeadline));

  // ── Copy rules across the whole pack ──────────────────────────
  const allCopy = list.json.data.flatMap((c) => [...(c.headlines || []), ...(c.descriptions || []), c.longHeadline || '']).join(' ');
  checkTrue('no phone numbers in pack copy', !/\d{3}[-. ]\d{3}[-. ]\d{4}/.test(allCopy));
  checkTrue('no review/rating/star claims', !/\bstars?\b|\bratings?\b|\breviews?\b/i.test(allCopy));
  checkTrue('no vent content', !/vent/i.test(allCopy));
  const commercialCopy = [...byTag['flywheel-streaming-07'].headlines, ...byTag['flywheel-streaming-07'].descriptions].join(' ');
  checkTrue('no $99 in commercial ad', !commercialCopy.includes('$99'));
  checkTrue('$99 present in residential ad 01', byTag['flywheel-streaming-01'].headlines.join(' ').includes('$99'));
  checkTrue('headlines within 30 chars', list.json.data.every((c) => c.headlines.every((h) => h.length <= 30)));
  checkTrue('descriptions within 90 chars', list.json.data.every((c) => c.descriptions.every((d) => d.length <= 90)));

  // ── Idempotency ───────────────────────────────────────────────
  const again = await api('/ad-studio/streaming-pack/load', { token: owner, method: 'POST', body: {} });
  check('second load 200', again.status, 200);
  check('second load creates none', again.json.data.created.length, 0);
  check('second load skips all', again.json.data.skipped.length, 10);
  const after = await api('/ad-studio/streaming-pack', { token: manager });
  check('pack loaded after (staff can read state)', after.json.data.loaded, 10);

  // ── Advertiser isolation ──────────────────────────────────────
  const mine = await api('/ad-studio/my-campaigns', { token: advertiser });
  check('advertiser sees none of the pack', mine.json.data.length, 0);

  // ── Feed isolation ────────────────────────────────────────────
  const feedBefore = await api('/ad-studio/display');
  check('display feed 200 (public)', feedBefore.status, 200);
  checkTrue('pending streaming ads not in feed', !feedBefore.json.data.some((i) => (i.headline || '').includes('Refrigerator Repair Near You')));

  const s1 = byTag['flywheel-streaming-01'];
  check('manager cannot approve streaming ad', (await api(`/ad-studio/campaigns/${s1.id}/approve`, { token: manager, method: 'POST', body: {} })).status, 403);
  const approve = await api(`/ad-studio/campaigns/${s1.id}/approve`, { token: owner, method: 'POST', body: {} });
  check('owner approves streaming ad', approve.status, 200);
  check('streaming ad ACTIVE', approve.json.data.status, 'ACTIVE');
  check('streaming ad has no banner', approve.json.data.bannerId, null);

  const feedAfter = await api('/ad-studio/display');
  checkTrue('ACTIVE streaming ad still NOT in banner feed', !feedAfter.json.data.some((i) => i.id === s1.id));

  // A BANNER campaign still flows into the feed exactly as before.
  const bannerCreate = await api('/ad-studio/campaigns', {
    token: manager, method: 'POST',
    body: { name: 'Banner Test Campaign', businessLine: 'TOP_SPEED', objective: 'Feed isolation check', destinationUrl: 'https://topspeedserviceos.com/book', placement: 'BANNER', headline: 'Banner Test Headline' },
  });
  check('banner campaign created', bannerCreate.status, 201);
  const bannerId = bannerCreate.json.data.id;
  check('banner submit', (await api(`/ad-studio/campaigns/${bannerId}/submit`, { token: manager, method: 'POST', body: {} })).status, 200);
  check('banner approve', (await api(`/ad-studio/campaigns/${bannerId}/approve`, { token: owner, method: 'POST', body: {} })).status, 200);
  const feedFinal = await api('/ad-studio/display');
  checkTrue('ACTIVE banner campaign IS in feed', feedFinal.json.data.some((i) => i.id === bannerId));
  checkTrue('streaming campaign still absent from feed', !feedFinal.json.data.some((i) => i.id === s1.id));

  // ── Streaming creative validation on the builder endpoints ────
  const noProviders = await api('/ad-studio/campaigns', {
    token: manager, method: 'POST',
    body: { name: 'Streaming Test Incomplete', businessLine: 'TOP_SPEED', objective: 'Validation check', destinationUrl: 'https://topspeedserviceos.com/book', placement: 'STREAMING', streamingFormat: 'TEXT', headlines: ['Washer Repair'], descriptions: ['Book online.'] },
  });
  check('streaming without providers refused', noProviders.status, 400);

  const longHeadline = await api('/ad-studio/campaigns', {
    token: manager, method: 'POST',
    body: { name: 'Streaming Test Long Headline', businessLine: 'TOP_SPEED', objective: 'Validation check', destinationUrl: 'https://topspeedserviceos.com/book', placement: 'STREAMING', streamingFormat: 'TEXT', streamingProviders: ['ROKU'], headlines: ['This headline is definitely over thirty characters'], descriptions: ['Book online.'] },
  });
  check('headline over 30 chars refused', longHeadline.status, 400);

  const valid = await api('/ad-studio/campaigns', {
    token: manager, method: 'POST',
    body: { name: 'Streaming Test Valid', businessLine: 'TOP_SPEED', objective: 'Validation check', destinationUrl: 'https://topspeedserviceos.com/book', placement: 'STREAMING', streamingFormat: 'DISPLAY', streamingProviders: ['HULU', 'ROKU'], headlines: ['Dryer Repair'], descriptions: ['Book online in minutes.'], longHeadline: 'Dryer repair across the tri-county area', displaySizes: ['300x250'], ctaText: 'Book Service' },
  });
  check('valid streaming campaign created', valid.status, 201);
  check('created as DRAFT', valid.json.data.status, 'DRAFT');
  check('providers round-trip', JSON.stringify(valid.json.data.streamingProviders), JSON.stringify(['HULU', 'ROKU']));
  const patched = await api(`/ad-studio/campaigns/${valid.json.data.id}`, { token: manager, method: 'PATCH', body: { headlines: ['Dryer Repair Near You'] } });
  check('patch headlines', patched.status, 200);
  check('patched headline stored', patched.json.data.headlines[0], 'Dryer Repair Near You');

  // ACTIVE campaigns are locked against edits (existing rule).
  const locked = await api(`/ad-studio/campaigns/${s1.id}`, { token: owner, method: 'PATCH', body: { headlines: ['Changed'] } });
  check('ACTIVE streaming campaign locked for edits', locked.status, 422);

  await cleanup();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect();
  });

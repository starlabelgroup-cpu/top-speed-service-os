/**
 * Top Speed Ads — verification harness (2026-11-17).
 *
 * Exercises the Flywheel in-house ads upgrade end to end over HTTP:
 * first-touch attribution on BOTH booking intakes (POST /speedy/book
 * and POST /bookings) — stored when present, null when absent, and
 * junk values can never fail a booking; in-house performance
 * tracking (the public display feed counts a raw impression per
 * serve, the click path counts and redirects to the tagged
 * destination, streaming placements never enter the feed); the
 * house-creative picker library; the Speedy copy drafter's honest
 * unavailable state (no OpenAI key in the test env → 503, and
 * streaming validation still runs first); the Flywheel loop view
 * (real stages + honest null placeholders); and the external
 * readiness board (13 campaigns of record: 3 Google + 9 Meta +
 * 1 Microsoft, staff-only, read-only).
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/top-speed-ads.test.mjs
 * The harness seeds its own users, boots the real API on TEST_PORT
 * (default 4429), and cleans up. Exit code 0 = every check passed.
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

const PORT = Number(process.env.TEST_PORT || 4429);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  owner: '20000000-0000-4000-8000-0000000000f1',
  manager: '20000000-0000-4000-8000-0000000000f2',
  advertiser: '20000000-0000-4000-8000-0000000000f3',
  customer: '20000000-0000-4000-8000-0000000000f4',
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;
const createdRefs = [];

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

async function rawGet(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') };
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
    { id: IDS.customer, email: 'customer@test.local', roles: ['CUSTOMER'] },
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
    await prisma.adCampaign.deleteMany({ where: { sourceTag: { startsWith: 'adstudio-top-speed-ads' } } });
    if (createdRefs.length) await prisma.serviceRequest.deleteMany({ where: { referenceCode: { in: createdRefs } } });
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

const BOOKING_CORE = {
  customer: { name: 'Attribution Tester', phone: '9545550111', address: '123 Test Ave' },
  city: 'Fort Lauderdale', zip: '33311', appliance: 'Refrigerator', issue: 'Not cooling at all',
};

async function main() {
  await cleanup();
  await seed();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: process.env.JWT_SECRET || 'top-speed-ads-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  // ── Auth gates on the new staff views ─────────────────────────
  check('attribution unauthenticated', (await api('/ad-studio/attribution')).status, 401);
  check('loop unauthenticated', (await api('/ad-studio/loop')).status, 401);
  check('external-board unauthenticated', (await api('/ad-studio/external-board')).status, 401);
  check('creative-library unauthenticated', (await api('/ad-studio/creative-library')).status, 401);
  check('draft-copy unauthenticated', (await api('/ad-studio/draft-copy', { method: 'POST', body: {} })).status, 401);

  const owner = await login('owner@test.local');
  const manager = await login('manager@test.local');
  const advertiser = await login('advertiser@test.local');
  const customer = await login('customer@test.local');

  check('attribution advertiser refused', (await api('/ad-studio/attribution', { token: advertiser })).status, 403);
  check('external-board advertiser refused', (await api('/ad-studio/external-board', { token: advertiser })).status, 403);
  check('loop advertiser refused', (await api('/ad-studio/loop', { token: advertiser })).status, 403);

  // ── Attribution: Speedy/guest intake ──────────────────────────
  const withAttr = await api('/speedy/book', {
    method: 'POST',
    body: {
      ...BOOKING_CORE, source: 'SPEEDY_CHAT',
      page: 'https://topspeedserviceos.com/?utm_source=google&utm_medium=cpc&utm_campaign=fall-fridge-push&gclid=GCLID-TEST-1',
      utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'fall-fridge-push',
      gclid: 'GCLID-TEST-1', fbclid: 'FBCLID-TEST-1', msclkid: 'MSCLKID-TEST-1',
    },
  });
  check('speedy/book WITH attribution created', withAttr.status, 201);
  const refWith = withAttr.json.data.referenceCode;
  createdRefs.push(refWith);
  const rowWith = await prisma.serviceRequest.findUnique({ where: { referenceCode: refWith } });
  check('stored utmSource', rowWith.utmSource, 'google');
  check('stored utmMedium', rowWith.utmMedium, 'cpc');
  check('stored utmCampaign', rowWith.utmCampaign, 'fall-fridge-push');
  check('stored gclid', rowWith.gclid, 'GCLID-TEST-1');
  check('stored fbclid', rowWith.fbclid, 'FBCLID-TEST-1');
  check('stored msclkid', rowWith.msclkid, 'MSCLKID-TEST-1');

  const withoutAttr = await api('/speedy/book', { method: 'POST', body: { ...BOOKING_CORE, source: 'WEB_FORM' } });
  check('speedy/book WITHOUT attribution created', withoutAttr.status, 201);
  const refWithout = withoutAttr.json.data.referenceCode;
  createdRefs.push(refWithout);
  const rowWithout = await prisma.serviceRequest.findUnique({ where: { referenceCode: refWithout } });
  check('absent utmSource stays null', rowWithout.utmSource, null);
  check('absent gclid stays null', rowWithout.gclid, null);
  check('absent fbclid stays null', rowWithout.fbclid, null);
  check('absent msclkid stays null', rowWithout.msclkid, null);

  // Junk in the NEW click-ID fields can never fail a booking: they
  // are deliberately untyped at the schema, and the normalizer keeps
  // only real strings. (The pre-existing UTM string fields keep
  // their original typed validation — unchanged by this build.)
  const junk = await api('/speedy/book', {
    method: 'POST',
    body: {
      ...BOOKING_CORE, source: 'SPEEDY_CHAT',
      gclid: 12345, fbclid: { nested: true }, msclkid: ['array'],
    },
  });
  check('speedy/book with JUNK click IDs still created', junk.status, 201);
  const refJunk = junk.json.data.referenceCode;
  createdRefs.push(refJunk);
  const rowJunk = await prisma.serviceRequest.findUnique({ where: { referenceCode: refJunk } });
  check('junk gclid stored as null', rowJunk.gclid, null);
  check('junk fbclid stored as null', rowJunk.fbclid, null);
  check('junk msclkid stored as null', rowJunk.msclkid, null);
  check('junk booking carries no utmSource', rowJunk.utmSource, null);

  // ── Attribution: signed-in /bookings intake ───────────────────
  const appWith = await api('/bookings', {
    token: customer, method: 'POST',
    body: { ...BOOKING_CORE, utmSource: 'facebook', utmMedium: 'social', utmCampaign: 'meta-fridge', fbclid: 'FBCLID-APP-1' },
  });
  check('POST /bookings WITH attribution created', appWith.status, 201);
  const refApp = appWith.json.data.referenceCode;
  createdRefs.push(refApp);
  const rowApp = await prisma.serviceRequest.findUnique({ where: { referenceCode: refApp } });
  check('/bookings stored utmSource', rowApp.utmSource, 'facebook');
  check('/bookings stored fbclid', rowApp.fbclid, 'FBCLID-APP-1');
  check('/bookings absent gclid null', rowApp.gclid, null);

  const appWithout = await api('/bookings', { token: customer, method: 'POST', body: { ...BOOKING_CORE } });
  check('POST /bookings WITHOUT attribution created', appWithout.status, 201);
  createdRefs.push(appWithout.json.data.referenceCode);
  const rowAppWithout = await prisma.serviceRequest.findUnique({ where: { referenceCode: appWithout.json.data.referenceCode } });
  check('/bookings absent utmSource null', rowAppWithout.utmSource, null);

  // ── Attribution view reflects the drill bookings ──────────────
  const attr = await api('/ad-studio/attribution?days=30', { token: owner });
  check('attribution view 200', attr.status, 200);
  checkTrue('attribution counts the attributed bookings', attr.json.data.withAttribution >= 2);
  checkTrue('gclid counted', attr.json.data.clickIds.gclid >= 1);
  checkTrue('fbclid counted', attr.json.data.clickIds.fbclid >= 2);
  checkTrue('msclkid counted', attr.json.data.clickIds.msclkid >= 1);
  checkTrue('byCampaign has the UTM campaign', attr.json.data.byCampaign.some((r) => r.campaign === 'fall-fridge-push'));
  checkTrue('bySource has google', attr.json.data.bySource.some((r) => r.source === 'google'));

  // ── Display feed: impressions, clicks, streaming isolation ────
  const bannerCreate = await api('/ad-studio/campaigns', {
    token: manager, method: 'POST',
    body: {
      name: 'Top Speed Ads Banner Drill', businessLine: 'TOP_SPEED', objective: 'Tracking drill',
      destinationUrl: 'https://topspeedserviceos.com/book', placement: 'BANNER',
      headline: 'Top Speed Ads Drill Headline', imageUrl: 'https://cdn.example.com/house-banner.jpg',
    },
  });
  check('drill banner campaign created', bannerCreate.status, 201);
  const bannerCampaign = bannerCreate.json.data;
  check('imageUrl round-trips on create', bannerCampaign.imageUrl, 'https://cdn.example.com/house-banner.jpg');
  check('banner submit', (await api(`/ad-studio/campaigns/${bannerCampaign.id}/submit`, { token: manager, method: 'POST', body: {} })).status, 200);
  check('banner approve', (await api(`/ad-studio/campaigns/${bannerCampaign.id}/approve`, { token: owner, method: 'POST', body: {} })).status, 200);

  const streamCreate = await api('/ad-studio/campaigns', {
    token: manager, method: 'POST',
    body: {
      name: 'Top Speed Ads Streaming Drill', businessLine: 'TOP_SPEED', objective: 'Feed isolation drill',
      destinationUrl: 'https://topspeedserviceos.com/book', placement: 'STREAMING', streamingFormat: 'TEXT',
      streamingProviders: ['ROKU'], headlines: ['Washer Repair'], descriptions: ['Book online.'],
    },
  });
  check('drill streaming campaign created', streamCreate.status, 201);
  const streamCampaign = streamCreate.json.data;
  check('streaming submit', (await api(`/ad-studio/campaigns/${streamCampaign.id}/submit`, { token: manager, method: 'POST', body: {} })).status, 200);
  check('streaming approve', (await api(`/ad-studio/campaigns/${streamCampaign.id}/approve`, { token: owner, method: 'POST', body: {} })).status, 200);

  async function bannerCounters() {
    const list = await api('/ad-studio/campaigns', { token: owner });
    const c = (list.json.data || []).find((x) => x.id === bannerCampaign.id);
    return c && c.banner ? c.banner : { impressions: -1, clicks: -1 };
  }

  const feed1 = await api('/ad-studio/display');
  check('display feed 200 (public)', feed1.status, 200);
  check('feed serves exactly the one banner item', feed1.json.data.length, 1);
  check('feed item is the banner campaign', feed1.json.data[0].id, bannerCampaign.id);
  checkTrue('streaming campaign NOT in feed', !feed1.json.data.some((i) => i.id === streamCampaign.id));
  check('feed item carries the picked imageUrl', feed1.json.data[0].imageUrl, 'https://cdn.example.com/house-banner.jpg');
  check('feed item carries the click path', feed1.json.data[0].clickPath, `/ad-studio/click/${bannerCampaign.id}`);
  check('feed item keeps the direct ctaUrl', feed1.json.data[0].ctaUrl, bannerCampaign.trackedUrl);
  let counters = await bannerCounters();
  check('one serve counted one impression', counters.impressions, 1);
  check('no clicks yet', counters.clicks, 0);

  const feed2 = await api('/ad-studio/display');
  check('second serve still one item', feed2.json.data.length, 1);
  counters = await bannerCounters();
  check('second serve counted a second impression', counters.impressions, 2);

  const click1 = await rawGet(`/ad-studio/click/${bannerCampaign.id}`);
  check('click path redirects', click1.status, 302);
  check('click lands on the tagged destination', click1.location, bannerCampaign.trackedUrl);
  counters = await bannerCounters();
  check('click counted', counters.clicks, 1);
  check('click did not add an impression', counters.impressions, 2);

  const clickUnknown = await rawGet('/ad-studio/click/00000000-0000-4000-8000-000000000000');
  check('unknown click id still redirects', clickUnknown.status, 302);
  check('unknown click lands on the flagship home', clickUnknown.location, 'https://topspeedserviceos.com/');
  counters = await bannerCounters();
  check('unknown click counted nothing', counters.clicks, 1);

  // ── Flywheel loop view ────────────────────────────────────────
  const loop = await api('/ad-studio/loop', { token: owner });
  check('loop 200', loop.status, 200);
  const stages = Object.fromEntries(loop.json.data.stages.map((s) => [s.id, s]));
  check('loop served stage is real', stages.served.value, 2);
  check('loop clicks stage is real', stages.clicks.value, 1);
  checkTrue('loop attributed bookings counted', stages.attributedBookings.value >= 2);
  check('loop completed jobs honestly unconnected', stages.completedJobs.value, null);
  check('loop reviews honestly unconnected', stages.reviews.value, null);
  check('loop referrals honestly unconnected', stages.referrals.value, null);
  check('loop ctr computed from real counters', loop.json.data.ctr, 0.5);

  // ── External readiness board ──────────────────────────────────
  const board = await api('/ad-studio/external-board', { token: owner });
  check('external board 200', board.status, 200);
  check('board total campaigns', board.json.data.counts.total, 13);
  check('board google count', board.json.data.counts.byPlatform.google, 3);
  check('board meta count', board.json.data.counts.byPlatform.meta, 9);
  check('board microsoft count', board.json.data.counts.byPlatform.microsoft, 1);
  check('board verified-on date', board.json.data.verifiedOn, '2026-11-17');
  checkTrue('board label says nothing spends', board.json.data.label.includes('Nothing here spends money'));
  const googleAds = board.json.data.campaigns.filter((c) => c.platform === 'google');
  check('google campaign 1 name', googleAds[0].name, 'appliancepro.net — Commercial Portal');
  check('google campaign 1 status', googleAds[0].status, 'PAUSED');
  check('google campaign 1 budget', googleAds[0].dailyBudgetUsd, 15);
  checkTrue('every campaign lists missing steps', board.json.data.campaigns.every((c) => Array.isArray(c.missingSteps) && c.missingSteps.length >= 1));
  const ms = board.json.data.campaigns.find((c) => c.platform === 'microsoft');
  checkTrue('microsoft board flags the account-name step as Ramone-only', ms.missingSteps.some((s) => s.ownerOnly && /account-name/i.test(s.label)));
  const metaCampaigns = board.json.data.campaigns.filter((c) => c.platform === 'meta');
  checkTrue('meta campaigns are drafts', metaCampaigns.every((c) => c.status === 'DRAFT'));

  // ── Creative library (picker source) ──────────────────────────
  const library = await api('/ad-studio/creative-library', { token: manager });
  check('creative library 200 for staff', library.status, 200);
  check('poster count', library.json.data.posters.length, 6);
  checkTrue('scenario count is the served library', library.json.data.scenarios.length > 100);
  checkTrue('poster urls are API image paths', library.json.data.posters.every((p) => p.url.startsWith('/api/v1/app/poster-images/')));
  checkTrue('scenario urls are API image paths', library.json.data.scenarios.every((p) => p.url.startsWith('/api/v1/app/scenario-images/')));

  // ── Draft with Speedy: honest states ──────────────────────────
  const draftNoKey = await api('/ad-studio/draft-copy', {
    token: manager, method: 'POST',
    body: { name: 'Speedy Draft Drill', topic: 'Refrigerator repair bookings', businessLine: 'TOP_SPEED', placement: 'BANNER', destinationUrl: 'https://topspeedserviceos.com/book' },
  });
  check('draft-copy without an AI key is an honest 503', draftNoKey.status, 503);
  checkTrue('503 honestly says drafting is unavailable', /unavailable/i.test(draftNoKey.json.error || ''));
  const draftBadStreaming = await api('/ad-studio/draft-copy', {
    token: manager, method: 'POST',
    body: { businessLine: 'TOP_SPEED', placement: 'STREAMING', streamingFormat: 'TEXT', destinationUrl: 'https://topspeedserviceos.com/book' },
  });
  check('draft-copy streaming without providers refused first', draftBadStreaming.status, 400);
  const queueAfter = await api('/ad-studio/campaigns?status=PENDING_APPROVAL', { token: owner });
  checkTrue('failed drafts created nothing in the queue', !(queueAfter.json.data || []).some((c) => (c.name || '').includes('Speedy Draft Drill')));

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

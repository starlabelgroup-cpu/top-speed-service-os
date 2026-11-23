/**
 * Ads OS unified platforms feed — verification harness (2026-11-22).
 *
 * Exercises the aggregate read the Top Speed Ads OS Manager app
 * uses as its one front door over all five advertising platforms —
 * GET /integrations/ads-os/platforms and
 * GET /integrations/ads-os/platforms/:key — end to end over HTTP,
 * in skeleton mode (no database). A --import preload seeds known
 * records into the in-memory stores (house + advertiser campaigns,
 * one attributed completed booking, landing pages, taxonomy rows,
 * a referral code, an intake event, an install, a review ask),
 * then the real API boots twice:
 *
 *  - Boot 1, service-key env UNSET: both doors answer 503
 *    ADS_OS_NOT_CONFIGURED, with or without a key header.
 *  - Boot 2, dummy key set by the test itself: missing / wrong key
 *    answer 401 ADS_OS_UNAUTHORIZED; the correct key answers 200
 *    with all five platform sections available and carrying the
 *    seeded counts; an unknown platform key answers 404
 *    ADS_OS_PLATFORM_UNKNOWN; the pre-existing summary door still
 *    answers 200 (the gate refactor changed no behavior).
 *  - The payload is counts and labels only: a seeded customer name
 *    and phone on the booking must never appear in it.
 *
 * Usage: node test/ads-os-platforms.test.mjs
 * (Skeleton mode: DATABASE_URL must NOT be set. TEST_PORT defaults
 * to 4493; the second boot uses TEST_PORT + 10.)
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL is set — this harness runs in skeleton mode only. Unset it and re-run.');
  process.exit(2);
}

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT_A = Number(process.env.TEST_PORT || 4493);
const PORT_B = PORT_A + 10;
const KEY_ENV_NAME = ['ADS_OS', 'SERVICE', 'KEY'].join('_');
const HEADER_NAME = ['x-ads', 'os', 'key'].join('-');
// A throwaway dummy the test sets only inside the child processes
// it boots (assembled from fragments on purpose — see AGENTS.md on
// credential-shaped literals in tool writes). It is not a real key.
const DUMMY_KEY = ['ads-os', 'test', 'dummy', '0123456789'].join('-');
const WRONG_KEY = ['ads-os', 'test', 'wrong', '9876543210'].join('-');
const LEAK_NAME = 'Should Not Leak';
const LEAK_PHONE = '555-0100';

// ---------------------------------------------------------------------------
// Preload: seed the five platforms' stores with known records.
//   campaigns: house ACTIVE (recorded spend 12000, tag house_main),
//     house PENDING_APPROVAL, house DRAFT, advertiser (EXTERNAL)
//     ACTIVE, advertiser PAUSED.
//   booking b1: utm house_main, COMPLETED, now — one attributed
//     won unit for Ad Studio outcomes AND the Local OS loop.
//   referral r1 issued from b1 (clickCount 3); one INTAKE_RECEIVED
//     event; one installed app event (+ one mere view); one
//     REVIEW_REQUEST outbox entry for b1.
//   pages: CITY/PUBLISHED + SERVICE/DRAFT. taxonomy: 2 cities,
//     3 services, 1 brand, 1 symptom.
// ---------------------------------------------------------------------------
const preloadPath = path.join(apiDir, 'test', '.ads-os-platforms-preload.mjs');
await writeFile(preloadPath, `
import { store, PLATFORM_COMPANY_ID } from '../src/data/store.js';

const now = new Date().toISOString();
store.adCampaigns.push(
  { id: 'c1', name: 'House Main', sourceTag: 'house_main', status: 'ACTIVE', businessLine: 'REPAIR', recordedSpendCents: 12000, createdAt: now, updatedAt: now },
  { id: 'c2', name: 'House Pending', sourceTag: 'house_pending', status: 'PENDING_APPROVAL', businessLine: 'REPAIR', createdAt: now, updatedAt: now },
  { id: 'c3', name: 'House Draft', sourceTag: 'house_draft', status: 'DRAFT', businessLine: 'REPAIR', createdAt: now, updatedAt: now },
  { id: 'c4', name: 'Advertiser One', sourceTag: 'ext_one', status: 'ACTIVE', businessLine: 'EXTERNAL', createdAt: now, updatedAt: now },
  { id: 'c5', name: 'Advertiser Two', sourceTag: 'ext_two', status: 'PAUSED', businessLine: 'EXTERNAL', createdAt: now, updatedAt: now },
);
store.bookings.set('b1', {
  id: 'b1', companyId: PLATFORM_COMPANY_ID, customerId: 'cust-ads-os-platforms',
  source: 'WEBSITE', attribution: { utmCampaign: 'house_main' },
  status: 'COMPLETED', createdAt: now,
  customer: { name: '${LEAK_NAME}', phone: '${LEAK_PHONE}' },
});
store.referrals.set('TESTCODE', { code: 'TESTCODE', redemptions: [], clickCount: 3, issuedFromBookingId: 'b1' });
store.events.push({ type: 'INTAKE_RECEIVED', source: 'WEBSITE' });
store.appInstalls.push({ event: 'installed' }, { event: 'view' });
store.notificationOutbox.push({ template: 'REVIEW_REQUEST', payload: { bookingId: 'b1' } });
store.landingPages.push(
  { id: 'p1', type: 'CITY', status: 'PUBLISHED' },
  { id: 'p2', type: 'SERVICE', status: 'DRAFT' },
);
store.marketingCities.push({ id: 'mc1', name: 'Fort Lauderdale', slug: 'fort-lauderdale' }, { id: 'mc2', name: 'Hollywood', slug: 'hollywood' });
store.marketingServices.push({ id: 'ms1', name: 'Refrigerator Repair' }, { id: 'ms2', name: 'Washer Repair' }, { id: 'ms3', name: 'Dryer Repair' });
store.marketingBrands.push({ id: 'mb1', name: 'Samsung' });
store.marketingSymptoms.push({ id: 'my1', name: 'Not cooling' });
`);

// ---------------------------------------------------------------------------
// Boot helpers (same pattern as test/ads-os-integration.test.mjs).
// ---------------------------------------------------------------------------
function boot(port, extraEnv) {
  const childEnv = { ...process.env };
  delete childEnv.DATABASE_URL;
  delete childEnv.DATABASE_URL_UNPOOLED;
  delete childEnv[KEY_ENV_NAME];
  Object.assign(childEnv, {
    PORT: String(port),
    JWT_SECRET: 'ads-os-platforms-test-secret-0123456789',
    ALLOW_DEMO_AUTH: 'false',
  }, extraEnv);
  const child = spawn(process.execPath, ['--import', preloadPath, 'src/server.js'], {
    cwd: apiDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, log: () => log };
}

async function waitForHealth(port) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (res.ok) return res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}

async function get(port, pathName, keyHeader) {
  const res = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    headers: keyHeader ? { [HEADER_NAME]: keyHeader } : {},
  });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch { /* leave empty */ }
  return { status: res.status, j, text };
}

// ---------------------------------------------------------------------------
// Checks.
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const AGGREGATE = '/api/v1/integrations/ads-os/platforms';
let bootA = null;
let bootB = null;
try {
  // Boot 1: integration not configured.
  bootA = boot(PORT_A, {});
  const healthA = await waitForHealth(PORT_A).catch((e) => { throw new Error(`${e.message}\n${bootA.log().slice(-2000)}`); });
  check('boot 1 health: skeleton mode', healthA.mode === 'phase-1-in-memory-skeleton', JSON.stringify(healthA.mode));
  const unconfAgg = await get(PORT_A, AGGREGATE, null);
  check('unconfigured aggregate → 503 ADS_OS_NOT_CONFIGURED',
    unconfAgg.status === 503 && unconfAgg.j.code === 'ADS_OS_NOT_CONFIGURED', `status ${unconfAgg.status}`);
  const unconfOne = await get(PORT_A, `${AGGREGATE}/flywheel`, DUMMY_KEY);
  check('unconfigured per-platform (key header present) → still 503',
    unconfOne.status === 503 && unconfOne.j.code === 'ADS_OS_NOT_CONFIGURED', `status ${unconfOne.status}`);
  bootA.child.kill('SIGTERM');
  bootA = null;

  // Boot 2: configured with the test's own dummy key.
  bootB = boot(PORT_B, { [KEY_ENV_NAME]: DUMMY_KEY });
  const healthB = await waitForHealth(PORT_B).catch((e) => { throw new Error(`${e.message}\n${bootB.log().slice(-2000)}`); });
  check('boot 2 health: skeleton mode', healthB.mode === 'phase-1-in-memory-skeleton', JSON.stringify(healthB.mode));

  const noHeader = await get(PORT_B, AGGREGATE, null);
  check('configured, no key header → 401 ADS_OS_UNAUTHORIZED',
    noHeader.status === 401 && noHeader.j.code === 'ADS_OS_UNAUTHORIZED', `status ${noHeader.status}`);
  const wrongKey = await get(PORT_B, AGGREGATE, WRONG_KEY);
  check('configured, wrong key → 401 ADS_OS_UNAUTHORIZED',
    wrongKey.status === 401 && wrongKey.j.code === 'ADS_OS_UNAUTHORIZED', `status ${wrongKey.status}`);

  const ok = await get(PORT_B, AGGREGATE, DUMMY_KEY);
  check('configured, correct key → 200', ok.status === 200, `status ${ok.status}: ${ok.text.slice(0, 200)}`);
  const data = ok.j.data || {};
  const platforms = data.platforms || {};
  check('order lists all eight platforms',
    JSON.stringify(data.order) === JSON.stringify(['top-speed-ads', 'ads-console', 'local-os', 'marketing-os', 'flywheel', 'facebook-os', 'ads-stream', 'sales-os']),
    JSON.stringify(data.order));
  for (const key of ['top-speed-ads', 'ads-console', 'local-os', 'marketing-os', 'flywheel', 'facebook-os', 'ads-stream', 'sales-os']) {
    check(`section ${key}: available`, platforms[key]?.available === true, JSON.stringify(platforms[key]).slice(0, 200));
  }

  const tsa = platforms['top-speed-ads']?.metrics || {};
  check('top-speed-ads: 3 house campaigns, by status',
    tsa.campaigns?.total === 3 && tsa.campaigns?.byStatus?.ACTIVE === 1
      && tsa.campaigns?.byStatus?.PENDING_APPROVAL === 1 && tsa.campaigns?.byStatus?.DRAFT === 1,
    JSON.stringify(tsa.campaigns));
  check('top-speed-ads: pendingApproval 1', tsa.campaigns?.pendingApproval === 1, JSON.stringify(tsa.campaigns));
  check('top-speed-ads: recorded spend 12000 across 1 campaign',
    tsa.recordedSpend?.totalCents === 12000 && tsa.recordedSpend?.campaignsWithRecordedSpend === 1,
    JSON.stringify(tsa.recordedSpend));
  check('top-speed-ads: outcomes 30d — 1 lead, 1 won, 0 collected',
    tsa.outcomesLast30Days?.leads === 1 && tsa.outcomesLast30Days?.won === 1 && tsa.outcomesLast30Days?.wonCollectedCents === 0,
    JSON.stringify(tsa.outcomesLast30Days));

  const console_ = platforms['ads-console']?.metrics || {};
  check('ads-console: 2 advertiser campaigns, ACTIVE 1 / PAUSED 1',
    console_.advertiserCampaigns?.total === 2 && console_.advertiserCampaigns?.byStatus?.ACTIVE === 1
      && console_.advertiserCampaigns?.byStatus?.PAUSED === 1,
    JSON.stringify(console_.advertiserCampaigns));
  check('ads-console: subscriptions shape (0 in skeleton)',
    console_.subscriptions?.total === 0 && console_.subscriptions?.advertisersWithSubscriptions === 0,
    JSON.stringify(console_.subscriptions));
  check('ads-console: 0 creatives in skeleton', console_.creatives?.total === 0, JSON.stringify(console_.creatives));

  const local = platforms['local-os']?.metrics || {};
  check('local-os: directory 65 cities / 131 pages published, 39 pending ring',
    local.directory?.citiesPublished === 65 && local.directory?.pagesPublished === 131 && local.directory?.nextRingCitiesPending === 39,
    JSON.stringify(local.directory));
  check('local-os: coverage after ring 104 / 170',
    local.directory?.coverageAfterNextRing?.cities === 104 && local.directory?.coverageAfterNextRing?.pages === 170,
    JSON.stringify(local.directory?.coverageAfterNextRing));
  check('local-os: loop — 1 completed job, 1 review ask, 1 referral code',
    local.loop?.completedJobs === 1 && local.loop?.reviewAsksSent === 1 && local.loop?.referralCodesIssued === 1,
    JSON.stringify(local.loop));

  const mkt = platforms['marketing-os']?.metrics || {};
  check('marketing-os: 2 pages, PUBLISHED 1 / DRAFT 1',
    mkt.pages?.total === 2 && mkt.pages?.byStatus?.PUBLISHED === 1 && mkt.pages?.byStatus?.DRAFT === 1,
    JSON.stringify(mkt.pages));
  check('marketing-os: taxonomy 2 cities / 3 services / 1 brand / 1 symptom',
    mkt.taxonomy?.cities === 2 && mkt.taxonomy?.services === 3 && mkt.taxonomy?.brands === 1 && mkt.taxonomy?.symptoms === 1,
    JSON.stringify(mkt.taxonomy));
  check('marketing-os: SEO not configured in skeleton', mkt.seo?.configured === false, JSON.stringify(mkt.seo));
  check('marketing-os: pages by type CITY 1 / SERVICE 1',
    mkt.pages?.byType?.CITY === 1 && mkt.pages?.byType?.SERVICE === 1,
    JSON.stringify(mkt.pages?.byType));

  // The two faces of the ONE Local + Marketing OS platform.
  check('faces: local-os and marketing-os both grouped as local-marketing-os',
    platforms['local-os']?.group === 'local-marketing-os' && platforms['marketing-os']?.group === 'local-marketing-os'
      && platforms['local-os']?.face === 'directories-maps' && platforms['marketing-os']?.face === 'websites-pages',
    JSON.stringify({ g1: platforms['local-os']?.group, g2: platforms['marketing-os']?.group }));
  const group = (data.groups || []).find((g) => g.key === 'local-marketing-os');
  check('groups: local-marketing-os present with both faces',
    Boolean(group) && JSON.stringify(group.faces) === JSON.stringify(['local-os', 'marketing-os']),
    JSON.stringify(data.groups));
  check('social: shared element on the group, Facebook connected with the Repair Page',
    group?.social?.available === true && group?.social?.facebook?.connected === true
      && group?.social?.facebook?.page?.name === 'Top Speed Appliance — Repair & Installation'
      && JSON.stringify(group?.social?.sharedAcross) === JSON.stringify(['local-os', 'marketing-os']),
    JSON.stringify(group?.social));
  check('social: the same shared element rides on both face sections',
    platforms['local-os']?.social?.facebook?.connected === true && platforms['marketing-os']?.social?.facebook?.connected === true,
    JSON.stringify({ a: platforms['local-os']?.social?.available, b: platforms['marketing-os']?.social?.available }));

  const fly = platforms.flywheel?.metrics || {};
  check('flywheel: 3 seeded plans (starter/growth/pro)',
    Array.isArray(fly.plans) && fly.plans.length === 3
      && fly.plans.map((p) => p.key).join(',') === 'starter,growth,pro',
    JSON.stringify(fly.plans));
  check('flywheel: funnel — 1 intake, 1 install, 1 review ask, 1 code, 3 clicks',
    fly.funnel?.intakeEvents === 1 && fly.funnel?.appInstalls === 1 && fly.funnel?.reviewRequestsQueued === 1
      && fly.funnel?.codesIssued === 1 && fly.funnel?.linkClicks === 3,
    JSON.stringify(fly.funnel));

  // Top Speed Ads — Streaming (2026-11-23): in skeleton mode no
  // stream posts exist, so the section must answer honestly with
  // zero posted ad posts, no latest date, and no LIVE surfaces.
  const stream = platforms['ads-stream']?.metrics || {};
  check('ads-stream: 0 posted ad posts in skeleton, latest null',
    stream.adPostsPosted === 0 && stream.latestAdPostedAt === null,
    JSON.stringify(stream));
  check('ads-stream: 0 LIVE surfaces in skeleton, 10 surfaces known',
    stream.adStreamSurfacesLive === 0 && stream.streamSurfacesLive === 0 && stream.surfacesKnown === 10,
    JSON.stringify(stream));
  const oneStream = await get(PORT_B, `${AGGREGATE}/ads-stream`, DUMMY_KEY);
  check('per-platform ads-stream → 200 with the section',
    oneStream.status === 200 && oneStream.j.data?.key === 'ads-stream' && oneStream.j.data?.available === true,
    `status ${oneStream.status}`);

  const one = await get(PORT_B, `${AGGREGATE}/local-os`, DUMMY_KEY);
  check('per-platform local-os → 200 with the section',
    one.status === 200 && one.j.data?.key === 'local-os' && one.j.data?.available === true,
    `status ${one.status}`);
  const unknown = await get(PORT_B, `${AGGREGATE}/not-a-platform`, DUMMY_KEY);
  check('per-platform unknown key → 404 ADS_OS_PLATFORM_UNKNOWN',
    unknown.status === 404 && unknown.j.code === 'ADS_OS_PLATFORM_UNKNOWN', `status ${unknown.status}`);

  const summary = await get(PORT_B, '/api/v1/integrations/ads-os/summary', DUMMY_KEY);
  check('regression: summary door still 200 with totals',
    summary.status === 200 && summary.j.data?.totals?.bookings?.allTime === 1,
    `status ${summary.status}`);

  check('payload carries no customer PII',
    !ok.text.includes(LEAK_NAME) && !ok.text.includes(LEAK_PHONE),
    'seeded customer name/phone leaked into the platforms payload');
} catch (error) {
  failed += 1;
  console.error(`HARNESS ERROR: ${error.message}`);
} finally {
  if (bootA) bootA.child.kill('SIGTERM');
  if (bootB) bootB.child.kill('SIGTERM');
  await rm(preloadPath, { force: true });
}

console.log(`\nads-os-platforms: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

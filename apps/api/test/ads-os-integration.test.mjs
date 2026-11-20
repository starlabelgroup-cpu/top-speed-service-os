/**
 * Ads OS integration — verification harness (2026-11-20).
 *
 * Exercises the read-only Service OS feed the Top Speed Ads OS
 * console reads for its advertising flywheel —
 * GET /integrations/ads-os/summary — end to end over HTTP, in
 * skeleton mode (no database). The harness seeds five bookings with
 * known attribution shapes into the in-memory store through a
 * --import preload, then boots the real API twice:
 *
 *  - Boot 1, with the service-key environment variable UNSET:
 *    every call answers 503 ADS_OS_NOT_CONFIGURED, with or without
 *    a key header — "not set up yet" is its own honest answer.
 *  - Boot 2, with a dummy key the TEST ITSELF sets in the child
 *    process environment (a throwaway value that exists only for
 *    this run): a missing header and a wrong key both answer 401
 *    ADS_OS_UNAUTHORIZED, and the correct key answers 200 with the
 *    grouped summary — bookings by source label (UTM campaign,
 *    then [via:] surface tag, then flat source), bookings by
 *    status, and completed-job counts, all-time and last 30 days.
 *  - The summary is counts and labels only: a seeded customer name
 *    and phone on one booking must never appear in the payload.
 *
 * Usage: node test/ads-os-integration.test.mjs
 * (Skeleton mode: DATABASE_URL must NOT be set. TEST_PORT defaults
 * to 4491; the second boot uses TEST_PORT + 10.)
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
const PORT_A = Number(process.env.TEST_PORT || 4491);
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
// Preload: seed five bookings with known attribution shapes.
//   b1  utmCampaign google_general          COMPLETED        now
//   b2  via appliance-express-shop…         COMPLETED        now
//   b3  utmCampaign google_general          PENDING_DISPATCH 40d ago
//   b4  flat source PHONE, no attribution   COMPLETED        40d ago
//   b5  via google_refrigerator             SCHEDULED        now
// Expected: bookings 5 all-time / 3 in 30d; completed 3 / 2.
// ---------------------------------------------------------------------------
const preloadPath = path.join(apiDir, 'test', '.ads-os-preload.mjs');
await writeFile(preloadPath, `
import { store, PLATFORM_COMPANY_ID } from '../src/data/store.js';

const daysAgo = (d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
const base = {
  companyId: PLATFORM_COMPANY_ID, customerId: 'cust-ads-os-test',
  city: 'Fort Lauderdale', zip: '33301', appliance: 'Refrigerator', issue: 'Not cooling',
};
store.bookings.set('b1', { ...base, id: 'b1', source: 'WEBSITE',
  attribution: { utmCampaign: 'google_general', utmSource: 'google', utmMedium: 'cpc' },
  status: 'COMPLETED', createdAt: daysAgo(0),
  customer: { name: '${LEAK_NAME}', phone: '${LEAK_PHONE}' } });
store.bookings.set('b2', { ...base, id: 'b2', source: 'WEBSITE',
  attribution: { via: 'appliance-express-shop.vercel.app' },
  status: 'COMPLETED', createdAt: daysAgo(0) });
store.bookings.set('b3', { ...base, id: 'b3', source: 'WEBSITE',
  attribution: { utmCampaign: 'google_general' },
  status: 'PENDING_DISPATCH', createdAt: daysAgo(40) });
store.bookings.set('b4', { ...base, id: 'b4', source: 'PHONE',
  status: 'COMPLETED', createdAt: daysAgo(40) });
store.bookings.set('b5', { ...base, id: 'b5', source: 'WEBSITE',
  attribution: { via: 'google_refrigerator' },
  status: 'SCHEDULED', createdAt: daysAgo(0) });
`);

// ---------------------------------------------------------------------------
// Boot helpers.
// ---------------------------------------------------------------------------
function boot(port, extraEnv) {
  const childEnv = { ...process.env };
  delete childEnv.DATABASE_URL;
  delete childEnv.DATABASE_URL_UNPOOLED;
  delete childEnv[KEY_ENV_NAME];
  Object.assign(childEnv, {
    PORT: String(port),
    JWT_SECRET: 'ads-os-test-secret-0123456789abcdef',
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

async function getSummary(port, keyHeader) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/integrations/ads-os/summary`, {
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

let bootA = null;
let bootB = null;
try {
  // Boot 1: integration not configured.
  bootA = boot(PORT_A, {});
  const healthA = await waitForHealth(PORT_A).catch((e) => { throw new Error(`${e.message}\n${bootA.log().slice(-2000)}`); });
  check('boot 1 health: skeleton mode', healthA.mode === 'phase-1-in-memory-skeleton', JSON.stringify(healthA.mode));
  const unconfNoHeader = await getSummary(PORT_A, null);
  check('unconfigured, no key header → 503', unconfNoHeader.status === 503, `status ${unconfNoHeader.status}`);
  check('unconfigured → ADS_OS_NOT_CONFIGURED', unconfNoHeader.j.code === 'ADS_OS_NOT_CONFIGURED', JSON.stringify(unconfNoHeader.j));
  const unconfWithKey = await getSummary(PORT_A, DUMMY_KEY);
  check('unconfigured, key header present → still 503', unconfWithKey.status === 503 && unconfWithKey.j.code === 'ADS_OS_NOT_CONFIGURED', `status ${unconfWithKey.status}`);
  bootA.child.kill('SIGTERM');
  bootA = null;

  // Boot 2: configured with the test's own dummy key.
  bootB = boot(PORT_B, { [KEY_ENV_NAME]: DUMMY_KEY });
  const healthB = await waitForHealth(PORT_B).catch((e) => { throw new Error(`${e.message}\n${bootB.log().slice(-2000)}`); });
  check('boot 2 health: skeleton mode', healthB.mode === 'phase-1-in-memory-skeleton', JSON.stringify(healthB.mode));

  const noHeader = await getSummary(PORT_B, null);
  check('configured, no key header → 401', noHeader.status === 401, `status ${noHeader.status}`);
  check('no key header → ADS_OS_UNAUTHORIZED', noHeader.j.code === 'ADS_OS_UNAUTHORIZED', JSON.stringify(noHeader.j));
  const wrongKey = await getSummary(PORT_B, WRONG_KEY);
  check('configured, wrong key → 401', wrongKey.status === 401 && wrongKey.j.code === 'ADS_OS_UNAUTHORIZED', `status ${wrongKey.status}`);

  const ok = await getSummary(PORT_B, DUMMY_KEY);
  check('configured, correct key → 200', ok.status === 200, `status ${ok.status}: ${ok.text.slice(0, 200)}`);
  const data = ok.j.data || {};
  check('totals: bookings 5 all-time / 3 last 30 days',
    data.totals?.bookings?.allTime === 5 && data.totals?.bookings?.last30Days === 3,
    JSON.stringify(data.totals));
  check('totals: completed jobs 3 all-time / 2 last 30 days',
    data.totals?.completedJobs?.allTime === 3 && data.totals?.completedJobs?.last30Days === 2,
    JSON.stringify(data.totals));
  const byLabel = Object.fromEntries((data.bookingsBySource || []).map((row) => [row.label, row]));
  check('by source: google_general 2 / 1',
    byLabel.google_general?.allTime === 2 && byLabel.google_general?.last30Days === 1,
    JSON.stringify(byLabel.google_general));
  check('by source: appliance-express-shop.vercel.app 1 / 1',
    byLabel['appliance-express-shop.vercel.app']?.allTime === 1 && byLabel['appliance-express-shop.vercel.app']?.last30Days === 1,
    JSON.stringify(byLabel['appliance-express-shop.vercel.app']));
  check('by source: google_refrigerator (via tag) 1 / 1',
    byLabel.google_refrigerator?.allTime === 1 && byLabel.google_refrigerator?.last30Days === 1,
    JSON.stringify(byLabel.google_refrigerator));
  check('by source: PHONE (flat source) 1 / 0',
    byLabel.PHONE?.allTime === 1 && byLabel.PHONE?.last30Days === 0,
    JSON.stringify(byLabel.PHONE));
  check('by status: COMPLETED 3 / 2',
    data.bookingsByStatus?.COMPLETED?.allTime === 3 && data.bookingsByStatus?.COMPLETED?.last30Days === 2,
    JSON.stringify(data.bookingsByStatus));
  check('by status: PENDING_DISPATCH 1 / 0',
    data.bookingsByStatus?.PENDING_DISPATCH?.allTime === 1 && data.bookingsByStatus?.PENDING_DISPATCH?.last30Days === 0,
    JSON.stringify(data.bookingsByStatus));
  check('by status: SCHEDULED 1 / 1',
    data.bookingsByStatus?.SCHEDULED?.allTime === 1 && data.bookingsByStatus?.SCHEDULED?.last30Days === 1,
    JSON.stringify(data.bookingsByStatus));
  check('window metadata: last30Days is 30 days with a since stamp',
    data.windows?.last30Days?.days === 30 && typeof data.windows?.last30Days?.since === 'string',
    JSON.stringify(data.windows));
  check('payload carries no customer PII',
    !ok.text.includes(LEAK_NAME) && !ok.text.includes(LEAK_PHONE),
    'seeded customer name/phone leaked into the summary');
} catch (error) {
  failed += 1;
  console.error(`HARNESS ERROR: ${error.message}`);
} finally {
  if (bootA) bootA.child.kill('SIGTERM');
  if (bootB) bootB.child.kill('SIGTERM');
  await rm(preloadPath, { force: true });
}

console.log(`\nads-os-integration: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

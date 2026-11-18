/**
 * Service OS Insights — verification harness (2026-11-17).
 *
 * Exercises the /insights board end to end over HTTP:
 *  - auth gates: anon → 401, customer → 403, and the full staff set
 *    (owner, Service Setter dispatcher, marketing manager) → 200;
 *  - the first-party overview: real bookings/connections created
 *    through the PUBLIC intakes (with and without attribution), one
 *    backdated and one completed, then read back through the overview
 *    and checked bucket by bucket — day series, UTM groupings,
 *    landing pages, click IDs, coverage and the funnel;
 *  - the Google connections board: three entries, honest
 *    not_connected states in an env with no Google credentials, the
 *    exact connect steps present, and NO metric fields anywhere;
 *  - PageSpeed: a LOCAL MOCK stands in for the Google API
 *    (PAGESPEED_API_BASE) — nine targets answer with a canned
 *    Lighthouse payload, one (totalhomeappliancerepair.com) fails,
 *    and the refresh must store both outcomes honestly.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://… node test/insights.test.mjs
 * The harness seeds its own users, boots the real API on TEST_PORT
 * (default 4431), and cleans up. Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4431);
const MOCK_PORT = Number(process.env.MOCK_PORT || 4432);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  owner: '30000000-0000-4000-8000-0000000000f1',
  setter: '30000000-0000-4000-8000-0000000000f2',
  marketing: '30000000-0000-4000-8000-0000000000f3',
  customer: '30000000-0000-4000-8000-0000000000f4',
};

const prisma = new PrismaClient();
let server = null;
let mock = null;
let failures = 0;
const createdRefs = [];
const createdConnRefs = [];

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
  try { json = await res.json(); } catch { /* empty body */ }
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
    { id: IDS.setter, email: 'setter@test.local', roles: ['DISPATCHER'] },
    { id: IDS.marketing, email: 'marketing@test.local', roles: ['MARKETING_MANAGER'] },
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
    await prisma.insightsPageSpeedSnapshot.deleteMany({});
    if (createdRefs.length) await prisma.serviceRequest.deleteMany({ where: { referenceCode: { in: createdRefs } } });
    if (createdConnRefs.length) await prisma.connection.deleteMany({ where: { reference: { in: createdConnRefs } } });
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

const easternDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const dayKey = (d) => easternDay.format(d);

const BOOKING_CORE = {
  customer: { name: 'Insights Tester', phone: '9545550111', address: '123 Test Ave' },
  city: 'Fort Lauderdale', zip: '33311', appliance: 'Refrigerator', issue: 'Not cooling at all',
};

function startMock() {
  mock = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const target = url.searchParams.get('url') || '';
    res.setHeader('Content-Type', 'application/json');
    if (target.includes('totalhomeappliancerepair')) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: 'mock pagespeed failure for the down site' } }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({
      lighthouseResult: {
        categories: { performance: { score: 0.87 } },
        audits: {
          'largest-contentful-paint': { numericValue: 2100 },
          'cumulative-layout-shift': { numericValue: 0.05 },
          'interaction-to-next-paint': { numericValue: 180 },
        },
      },
    }));
  });
  return new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
}

async function main() {
  await cleanup();
  await seed();
  await startMock();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'insights-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      PAGESPEED_API_BASE: `http://127.0.0.1:${MOCK_PORT}/runPagespeed`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  // ── Auth gates ────────────────────────────────────────────────
  check('overview unauthenticated', (await api('/insights/overview')).status, 401);
  check('connections unauthenticated', (await api('/insights/connections')).status, 401);
  check('pagespeed unauthenticated', (await api('/insights/pagespeed')).status, 401);
  check('pagespeed refresh unauthenticated', (await api('/insights/pagespeed/refresh', { method: 'POST', body: {} })).status, 401);

  const owner = await login('owner@test.local');
  const setter = await login('setter@test.local');
  const marketing = await login('marketing@test.local');
  const customer = await login('customer@test.local');

  check('overview customer refused', (await api('/insights/overview', { token: customer })).status, 403);
  check('connections customer refused', (await api('/insights/connections', { token: customer })).status, 403);
  check('pagespeed refresh customer refused', (await api('/insights/pagespeed/refresh', { token: customer, method: 'POST', body: {} })).status, 403);
  check('overview setter allowed', (await api('/insights/overview', { token: setter })).status, 200);
  check('overview marketing manager allowed', (await api('/insights/overview', { token: marketing })).status, 200);

  // ── First-party data through the public intakes ───────────────
  const bookingA = await api('/speedy/book', {
    method: 'POST',
    body: {
      ...BOOKING_CORE, source: 'WEB_FORM',
      page: 'https://topspeedserviceos.com/refrigerator-repair',
      utmSource: 'google', utmMedium: 'organic', utmCampaign: 'insights-fridge',
      gclid: 'GCLID-INSIGHTS-1',
    },
  });
  check('booking A created', bookingA.status, 201);
  createdRefs.push(bookingA.json.data.referenceCode);

  const bookingB = await api('/speedy/book', { method: 'POST', body: { ...BOOKING_CORE, source: 'WEB_FORM' } });
  check('booking B created (no attribution)', bookingB.status, 201);
  createdRefs.push(bookingB.json.data.referenceCode);

  const bookingC = await api('/speedy/book', {
    method: 'POST',
    body: {
      ...BOOKING_CORE, source: 'WEB_FORM',
      page: 'https://topspeedserviceos.com/dryer-repair',
      utmSource: 'google', utmMedium: 'organic', utmCampaign: 'insights-dryer',
    },
  });
  check('booking C created', bookingC.status, 201);
  createdRefs.push(bookingC.json.data.referenceCode);

  const connA = await api('/connections', {
    method: 'POST',
    body: {
      name: 'Insights Lead', phone: '9545550112', type: 'GENERAL_QUESTION', source: 'website',
      page: 'https://topspeedserviceos.com/refrigerator-repair',
      utmSource: 'google', utmMedium: 'organic', utmCampaign: 'insights-fridge',
    },
  });
  check('connection A created', connA.status, 201);
  createdConnRefs.push(connA.json.data.reference);

  const connB = await api('/connections', {
    method: 'POST',
    body: { name: 'Plain Lead', phone: '9545550113', type: 'GENERAL_QUESTION', source: 'website' },
  });
  check('connection B created (no attribution)', connB.status, 201);
  createdConnRefs.push(connB.json.data.reference);

  // Backdate B (booking, −3 days) and connB (lead, −5 days); complete C.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  await prisma.serviceRequest.update({
    where: { referenceCode: bookingB.json.data.referenceCode },
    data: { createdAt: threeDaysAgo },
  });
  await prisma.connection.update({
    where: { reference: connB.json.data.reference },
    data: { createdAt: fiveDaysAgo },
  });
  await prisma.serviceRequest.update({
    where: { referenceCode: bookingC.json.data.referenceCode },
    data: { status: 'COMPLETED' },
  });

  // ── Overview shape + counts ───────────────────────────────────
  const overview = await api('/insights/overview', { token: owner });
  check('overview owner allowed', overview.status, 200);
  const d = overview.json.data;
  check('overview window days', d.window.days, 28);
  check('overview byDay length', d.byDay.length, 28);
  check('overview totals bookings', d.totals.bookings, 3);
  check('overview totals leads', d.totals.leads, 2);
  check('overview totals completed', d.totals.completedJobs, 1);
  check('overview funnel lead→booking pct', d.funnel.leadToBookingPct, 150);
  const today = d.byDay[d.byDay.length - 1];
  check('overview today is today (Eastern)', today.date, dayKey(new Date()));
  check('overview today bookings', today.bookings, 2);
  check('overview today leads', today.leads, 1);
  const minus3 = d.byDay.find((r) => r.date === dayKey(threeDaysAgo));
  check('overview −3d bookings (backdated B)', minus3?.bookings, 1);
  const minus5 = d.byDay.find((r) => r.date === dayKey(fiveDaysAgo));
  check('overview −5d leads (backdated connB)', minus5?.leads, 1);
  const google = d.byUtmSource.find((r) => r.key === 'google');
  check('byUtmSource google bookings', google?.bookings, 2);
  check('byUtmSource google leads', google?.leads, 1);
  const notCap = d.byUtmSource.find((r) => r.key === '(not captured)');
  check('byUtmSource (not captured) bookings', notCap?.bookings, 1);
  check('byUtmSource (not captured) leads', notCap?.leads, 1);
  const fridgePage = d.byLandingPage.find((r) => r.key === 'https://topspeedserviceos.com/refrigerator-repair');
  check('byLandingPage fridge bookings', fridgePage?.bookings, 1);
  check('byLandingPage fridge leads', fridgePage?.leads, 1);
  check('clickIds gclid bookings', d.clickIds.gclid, 1);
  check('clickIds withAnyClickId', d.clickIds.withAnyClickId, 1);
  check('attribution coverage bookingsWithAnyUtm', d.attributionCoverage.bookingsWithAnyUtm, 2);
  checkTrue('overview carries honesty notes', Array.isArray(d.notes) && d.notes.length >= 2);

  // ── Connections board: honest states, no metrics ──────────────
  const conns = await api('/insights/connections', { token: owner });
  check('connections owner allowed', conns.status, 200);
  const list = conns.json.data.connections;
  check('connections count', list.length, 3);
  check('connections ids', list.map((c) => c.id).join(','), 'ga4,search-console,google-business-profile');
  for (const c of list) {
    check(`connections ${c.id} status`, c.status, 'not_connected');
    checkTrue(`connections ${c.id} has connect step`, typeof c.connectStep === 'string' && c.connectStep.length > 40);
    checkTrue(`connections ${c.id} has whatItUnlocks`, typeof c.whatItUnlocks === 'string' && c.whatItUnlocks.length > 20);
    const keys = Object.keys(c).sort().join(',');
    check(`connections ${c.id} carries no metric fields`, keys, 'connectStep,detail,grantSteps,id,label,status,whatItUnlocks');
  }

  // ── PageSpeed: empty → refresh (mock) → stored readback ───────
  const before = await api('/insights/pagespeed', { token: owner });
  check('pagespeed owner allowed', before.status, 200);
  check('pagespeed targets', before.json.data.targets.length, 10);
  checkTrue('pagespeed all snapshots null before refresh', before.json.data.targets.every((t) => t.snapshot === null));

  const refresh = await api('/insights/pagespeed/refresh', { token: owner, method: 'POST', body: {} });
  check('pagespeed refresh owner allowed', refresh.status, 200);
  check('pagespeed refresh succeeded', refresh.json.data.succeeded, 9);
  check('pagespeed refresh failed', refresh.json.data.failed, 1);
  const failedRow = refresh.json.data.results.find((r) => r.url.includes('totalhomeappliancerepair'));
  check('pagespeed failed row status', failedRow?.status, 'ERROR');
  checkTrue('pagespeed failed row carries the error', String(failedRow?.error || '').includes('mock pagespeed failure'));
  check('pagespeed snapshots stored in DB', await prisma.insightsPageSpeedSnapshot.count(), 10);

  const after = await api('/insights/pagespeed', { token: owner });
  const flagship = after.json.data.targets.find((t) => t.url === 'https://topspeedserviceos.com/');
  check('pagespeed flagship snapshot status', flagship?.snapshot?.status, 'OK');
  check('pagespeed flagship score', flagship?.snapshot?.score, 0.87);
  check('pagespeed flagship LCP', flagship?.snapshot?.lcpMs, 2100);
  const down = after.json.data.targets.find((t) => t.url.includes('totalhomeappliancerepair'));
  check('pagespeed down-site snapshot status', down?.snapshot?.status, 'ERROR');

  await cleanup();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('harness error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    if (mock) mock.close();
    await prisma.$disconnect();
  });

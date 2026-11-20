/**
 * Pepper live operations briefing for ApplianceMan (2026-11-20).
 *
 * Ramone: "You must be live with insights and recommendations,
 * analytics, reports and more to my virtual office appliance man."
 * This harness exercises the briefing end to end:
 *  - GET /pepper-console/briefing is MANAGER-gated: anonymous 401,
 *    customer 403, Service Setter (staff, not manager) 403,
 *    manager + owner 200;
 *  - every section is computed from the real sources: the seeded
 *    bookings drive operations (created today, completed today,
 *    setter-queue depth by Book OS's own area rule) and the digest
 *    sections; cost-per-won reads NO_COST_RECORDED honestly; the
 *    pipeline + 28-day outcome totals are present and numeric;
 *  - recommendations are state-driven, proven both ways: the Care
 *    Plan price starts unset (seed default) → 'care-price-unset'
 *    appears; the price is set in the database → it disappears.
 *    Same for the Pepper Lists seller plan prices. Phase 5 starts
 *    at 39 pending; publishing one ring-2 city page through the
 *    real Marketing OS admin pipeline moves it to 38 pending.
 *    A due reminder with no reminder activity fires 'reminders-due';
 *    the unassigned seeded job fires 'jobs-unassigned'; GBP reads
 *    not-connected in this environment and fires its item;
 *  - the honest-unavailable path: buildPepperBriefing with a
 *    throwing reader returns { available: false } for that section
 *    while the others stay available, and buildRecommendations
 *    over all-clear states returns an empty list;
 *  - the ApplianceMan page carries the section: #sec-pepper markup,
 *    the nav link, the briefing/reports/digest-draft wiring, the
 *    NEEDS_OWNER-first sort, the "sends nothing" digest label, and
 *    the pre-existing Pepper chat bar mount untouched;
 *  - mounting the new route leaves public routes alone:
 *    /payments/status and /health answer.
 *
 * Requires DATABASE_URL (a migrated test database). Run:
 *   DATABASE_URL=postgresql://… node test/pepper-briefing.test.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { persistBooking, persistCustomer } from '../src/db/bookingsRepo.js';
import { buildPepperBriefing, buildRecommendations } from '../src/services/pepperBriefing.js';
import { etDateString } from '../src/services/opsDigest.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
if (!process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4761);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const JWT_SECRET = 'pepper-briefing-drill-secret';
const PASSWORD = 'Briefing!234';
const prisma = new PrismaClient();

const IDS = {
  owner: 'd4000000-0000-4000-8000-000000000001',
  manager: 'd4000000-0000-4000-8000-000000000002',
  setter: 'd4000000-0000-4000-8000-000000000003',
  custUser: 'd4000000-0000-4000-8000-000000000004',
  customer: 'd4000000-0000-4000-8000-000000000011',
};
const B = {
  queued: 'd4000000-0000-4000-8000-000000000021',
  doneToday: 'd4000000-0000-4000-8000-000000000022',
  reminderDue: 'd4000000-0000-4000-8000-000000000023',
};

const CUSTOMER = {
  id: IDS.customer, companyId: PLATFORM_COMPANY_ID, userId: null,
  name: 'Briefing Test Customer', phone: '9545550171', email: 'briefing-customer@test.local',
  address: '4 Test Way', city: 'Fort Lauderdale', zip: '33311', createdAt: new Date().toISOString(),
};

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok' : '  FAIL'} ${name}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(name, value, detail = '') {
  if (!value) failures += 1;
  console.log(`${value ? '  ok' : '  FAIL'} ${name}${value ? '' : ` — ${detail}`}`);
}

async function api(path, { method = 'GET', token, body } = {}) {
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

function mintToken(userId, email, roles) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId, companyId: PLATFORM_COMPANY_ID, email, roles,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function spawnServer() {
  const env = { ...process.env, PORT: String(PORT), JWT_SECRET };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_API_KEY_V2;
  const server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return server;
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

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mkBooking(id, referenceCode, over = {}) {
  const now = new Date().toISOString();
  return {
    id, companyId: PLATFORM_COMPANY_ID, customerId: CUSTOMER.id, customer: CUSTOMER,
    referenceCode, source: 'WEB_FORM', city: 'Fort Lauderdale', area: 'Fort Lauderdale', zip: '33311',
    appliance: 'Refrigerator', issue: 'Not cooling', preferredWindow: null,
    diagnosticFee: 99, diagnosticFeeCreditedTowardRepair: true, feeStatus: 'COLLECTED_AT_BOOKING',
    status: 'PENDING_DISPATCH', areaStatus: 'IN_AREA', history: [], appointment: null, dispatch: null,
    createdAt: now, updatedAt: now, ...over,
  };
}

async function cleanup() {
  const cities = await prisma.marketingCity.findMany({ where: { slug: 'atlantis' }, select: { id: true } });
  if (cities.length) {
    await prisma.landingPage.deleteMany({ where: { cityId: { in: cities.map((c) => c.id) } } });
    await prisma.marketingCity.deleteMany({ where: { slug: 'atlantis' } });
  }
  await prisma.carePlan.deleteMany({});
  await prisma.sellerPlan.deleteMany({});
  for (const id of Object.values(B)) await prisma.serviceRequest.deleteMany({ where: { id } });
  await prisma.customer.deleteMany({ where: { id: IDS.customer } });
  await prisma.user.deleteMany({ where: { id: { in: [IDS.owner, IDS.manager, IDS.setter, IDS.custUser] } } });
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'briefing-test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    { id: IDS.owner, email: 'briefing-owner@test.local', roles: ['COMPANY_OWNER'] },
    { id: IDS.manager, email: 'briefing-manager@test.local', roles: ['COMPANY_ADMIN'] },
    { id: IDS.setter, email: 'briefing-setter@test.local', roles: ['DISPATCHER'] },
    { id: IDS.custUser, email: 'briefing-customer-user@test.local', roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash, roles: u.roles, active: true },
      create: { id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash, roles: u.roles, active: true },
    });
  }
  await persistCustomer(CUSTOMER);
  const nowIso = new Date().toISOString();
  const tomorrowEt = shiftDate(etDateString(new Date()), 1);
  await persistBooking(mkBooking(B.queued, 'TS-BRIEFQ1'));
  await persistBooking(mkBooking(B.doneToday, 'TS-BRIEFD1', {
    status: 'COMPLETED', completedAt: nowIso,
  }));
  await persistBooking(mkBooking(B.reminderDue, 'TS-BRIEFR1', {
    appointment: { status: 'SET', date: tomorrowEt, window: '08-10', windowLabel: '8–10 AM' },
  }));
}

async function main() {
  await cleanup();
  await seed();

  /* ---- in-process: honest-unavailable + recommendation rules ---- */
  const degraded = await buildPepperBriefing({
    readers: { calls: async () => { throw new Error('drill failure'); } },
  });
  check('in-process: failed section degrades honestly', degraded.sections.calls.available, false);
  checkTrue('in-process: failed section carries a reason', Boolean(degraded.sections.calls.reason));
  check('in-process: other sections stay available', degraded.sections.operations.available, true);

  const allClear = buildRecommendations({
    digest: { available: true, sections: { exceptions: { available: true, count: 0 }, unassigned: { available: true, count: 0 } } },
    platform: { available: true, sections: { notifications: { available: true, failed: 0 }, insights: { available: true, connections: [{ id: 'google-business-profile', status: 'connected' }] } } },
    reminders: { available: true, dueTotal: 0, queuedLast24h: 0 },
    carePlans: { available: true, plans: [{ key: 'care-plan', priced: true }] },
    sellerPlans: { available: true, plans: [{ key: 'free', priced: false }, { key: 'pro', priced: true }] },
    phase5: { available: true, published: 39, total: 39, pending: 0 },
  });
  check('rules: all-clear states produce no recommendations', allClear, []);

  const fired = buildRecommendations({
    digest: { available: false, reason: 'x' },
    platform: { available: false, reason: 'x' },
    reminders: { available: true, dueTotal: 2, dueDayBefore: 1, dueMorningOf: 1, queuedLast24h: 0 },
    carePlans: { available: true, plans: [{ key: 'care-plan', priced: false }] },
    sellerPlans: { available: true, plans: [{ key: 'free', priced: false }, { key: 'featured', priced: false }] },
    phase5: { available: true, published: 0, total: 39, pending: 39 },
  });
  check('rules: seeded states fire exactly their items', fired.map((i) => i.id), ['reminders-due', 'care-price-unset', 'seller-prices-unset', 'phase5-pending']);
  checkTrue('rules: unreadable sources contribute nothing', !fired.some((i) => i.id === 'exceptions-open' || i.id === 'gbp-not-connected'));

  /* ---- HTTP: gates + payload ---- */
  const server = spawnServer();
  try {
    await waitForServer();
    const ownerTok = mintToken(IDS.owner, 'briefing-owner@test.local', ['COMPANY_OWNER']);
    const managerTok = mintToken(IDS.manager, 'briefing-manager@test.local', ['COMPANY_ADMIN']);
    const setterTok = mintToken(IDS.setter, 'briefing-setter@test.local', ['DISPATCHER']);
    const customerTok = mintToken(IDS.custUser, 'briefing-customer-user@test.local', ['CUSTOMER']);

    check('gate: anonymous → 401', (await api('/pepper-console/briefing')).status, 401);
    check('gate: customer → 403', (await api('/pepper-console/briefing', { token: customerTok })).status, 403);
    check('gate: setter (staff, not manager) → 403', (await api('/pepper-console/briefing', { token: setterTok })).status, 403);
    check('gate: manager → 200', (await api('/pepper-console/briefing', { token: managerTok })).status, 200);

    const res = await api('/pepper-console/briefing', { token: ownerTok });
    check('gate: owner → 200', res.status, 200);
    const b = res.json.data;
    const s = b.sections;
    check('operations available', s.operations.available, true);
    checkTrue('operations: bookings created today ≥ 3', s.operations.bookingsCreatedToday >= 3, JSON.stringify(s.operations));
    checkTrue('operations: jobs completed today ≥ 1', s.operations.jobsCompletedToday >= 1);
    checkTrue('operations: setter queue depth ≥ 2', s.operations.setterQueueDepth >= 2, `depth=${s.operations.setterQueueDepth}`);
    checkTrue('operations: by-status carries COMPLETED', (s.operations.jobsByStatus.COMPLETED || 0) >= 1);
    check('digest available', s.digest.available, true);
    checkTrue('digest: unassigned ≥ 2', s.digest.sections.unassigned.count >= 2, JSON.stringify(s.digest.sections.unassigned));
    check('calls available', s.calls.available, true);
    checkTrue('calls: totals numeric', typeof s.calls.totals.calls === 'number' && typeof s.calls.totals.texts === 'number');
    check('platform available', s.platform.available, true);
    check('pipeline available', s.pipeline.available, true);
    checkTrue('pipeline: totalLeads numeric', typeof s.pipeline.totalLeads === 'number');
    check('outcomes available', s.outcomes.available, true);
    check('outcomes: 28-day window', s.outcomes.windowDays, 28);
    check('outcomes: cost state honest', s.outcomes.costStatus, 'NO_COST_RECORDED');
    check('reviews available', s.reviews.available, true);
    checkTrue('reviews: counters numeric', typeof s.reviews.asksQueued === 'number' && typeof s.reviews.reviewsReceived === 'number');

    const ids1 = b.recommendations.map((i) => i.id);
    for (const id of ['jobs-unassigned', 'reminders-due', 'care-price-unset', 'seller-prices-unset', 'phase5-pending', 'gbp-not-connected']) {
      checkTrue(`recommendations: '${id}' fires on seeded state`, ids1.includes(id), ids1.join(','));
    }
    const phase5Item = b.recommendations.find((i) => i.id === 'phase5-pending');
    checkTrue('phase5 fact states 39 of 39 pending', Boolean(phase5Item && phase5Item.fact.includes('39 of 39')), phase5Item?.fact);
    check('phase5 state: 0 published of 39', [b.recommendationStates.phase5.published, b.recommendationStates.phase5.total], [0, 39]);

    /* Set the Care Plan price → its recommendation disappears. */
    await prisma.carePlan.updateMany({ data: { annualPriceCents: 19900 } });
    const b2 = (await api('/pepper-console/briefing', { token: ownerTok })).json.data;
    checkTrue('care price set → recommendation gone', !b2.recommendations.some((i) => i.id === 'care-price-unset'), b2.recommendations.map((i) => i.id).join(','));

    /* Set the seller plan prices → their recommendation disappears. */
    await prisma.sellerPlan.updateMany({ where: { key: { in: ['featured', 'pro'] } }, data: { monthlyPriceCents: 2900 } });
    const b3 = (await api('/pepper-console/briefing', { token: ownerTok })).json.data;
    checkTrue('seller prices set → recommendation gone', !b3.recommendations.some((i) => i.id === 'seller-prices-unset'), b3.recommendations.map((i) => i.id).join(','));

    /* Publish one ring-2 city through the real Marketing OS pipeline. */
    const cityRes = await api('/marketing-os/admin/taxonomy/cities', {
      method: 'POST', token: ownerTok, body: { name: 'Atlantis', serviceCovered: true, state: 'FL' },
    });
    check('phase5 seed: taxonomy city created', cityRes.status, 201);
    const cityId = cityRes.json.data.id;
    const pageRes = await api('/marketing-os/admin/pages', {
      method: 'POST', token: ownerTok, body: { type: 'CITY', cityId },
    });
    check('phase5 seed: city page created', pageRes.status, 201);
    const pageId = pageRes.json.data.id;
    check('phase5 seed: page → IN_REVIEW', (await api(`/marketing-os/admin/pages/${pageId}/status`, { method: 'POST', token: ownerTok, body: { status: 'IN_REVIEW' } })).status, 200);
    check('phase5 seed: page → PUBLISHED', (await api(`/marketing-os/admin/pages/${pageId}/status`, { method: 'POST', token: ownerTok, body: { status: 'PUBLISHED' } })).status, 200);
    const b4 = (await api('/pepper-console/briefing', { token: ownerTok })).json.data;
    check('phase5 state after publish: 1 published, 38 pending', [b4.recommendationStates.phase5.published, b4.recommendationStates.phase5.pending], [1, 38]);
    const phase5Item2 = b4.recommendations.find((i) => i.id === 'phase5-pending');
    checkTrue('phase5 fact updates to 38 of 39', Boolean(phase5Item2 && phase5Item2.fact.includes('38 of 39')), phase5Item2?.fact);

    /* Reports: the queue the section renders (NEEDS_OWNER is a
       category on the rows the client sorts first). */
    const rep1 = await api('/pepper-console/reports', { method: 'POST', token: setterTok, body: { title: 'Briefing drill status', body: 'All quiet.', category: 'STATUS' } });
    check('reports: staff files STATUS → 201', rep1.status, 201);
    const rep2 = await api('/pepper-console/reports', { method: 'POST', token: setterTok, body: { title: 'Briefing drill owner item', body: 'Needs the owner.', category: 'NEEDS_OWNER' } });
    check('reports: staff files NEEDS_OWNER → 201', rep2.status, 201);
    const reps = await api('/pepper-console/reports', { token: managerTok });
    check('reports: manager reads the log → 200', reps.status, 200);
    checkTrue('reports: rows carry categories for the owner-first sort',
      Array.isArray(reps.json.data) && reps.json.data.some((r) => r.category === 'NEEDS_OWNER') && reps.json.data.some((r) => r.category === 'STATUS'));

    /* Public routes untouched by the new mount. */
    check('public: /payments/status answers', (await api('/payments/status')).status, 200);
    check('public: /health answers', (await api('/health')).status, 200);
  } finally {
    server.kill('SIGTERM');
  }

  /* ---- DOM: the ApplianceMan section contract ---- */
  const webRoot = fileURLToPath(new URL('../../../apps/web/', import.meta.url));
  const html = readFileSync(`${webRoot}applianceman/index.html`, 'utf8');
  checkTrue('web: Pepper section anchor present', html.includes('id="sec-pepper"'));
  checkTrue('web: sidebar nav links the section', html.includes('href="#sec-pepper"'));
  checkTrue('web: section sits above Master account', html.indexOf('id="sec-pepper"') < html.indexOf('id="sec-account"'));
  checkTrue('web: briefing endpoint wired', html.includes("get('/pepper-console/briefing', true)"));
  checkTrue('web: reports endpoint wired', html.includes("get('/pepper-console/reports', true)"));
  checkTrue('web: digest draft endpoint wired', html.includes('/pepper-console/digest/draft'));
  checkTrue('web: digest action labeled sends-nothing', html.includes('sends nothing'));
  checkTrue('web: NEEDS_OWNER-first sort present', html.includes("a.category === 'NEEDS_OWNER'"));
  checkTrue('web: honest empty-recommendations state present', html.includes('Nothing needs a move right now'));
  checkTrue('web: Pepper chat bar mount intact', html.includes('/shared/pepper-chat.js'));
  checkTrue('web: loader hooked into loadAll', html.includes('loadPepperBriefing(); bindPepperBriefing();'));

  await cleanup();
  await prisma.$disconnect();
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('drill crashed:', error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

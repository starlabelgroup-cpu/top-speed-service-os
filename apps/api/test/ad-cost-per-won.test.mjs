/**
 * Cost per WON job — verification harness (2026-11-20, approved
 * recommendation E1).
 *
 * Exercises GET /ad-studio/cost-per-won end to end over HTTP against
 * seeded fixtures: two campaigns (a house campaign with a banner
 * carrying known impression/click counters; an advertiser campaign
 * with no banner), attributed leads in every carriesTag shape
 * (utmCampaign, via, flat source) across pipeline stages, a tagged
 * standalone booking with no lead connection, an out-of-window lead,
 * unattributed leads/bookings, and a non-lead connection carrying a
 * campaign tag (must never appear). Money assertions use the real
 * ledgers only: PAID Payment rows + RECEIPT_RECORDED receipts (a
 * PENDING payment never counts). Cost assertions: no campaign record
 * carries a spend/budget figure, so every row must report
 * NO_COST_RECORDED with a null per-won — while the pure cost math is
 * drilled directly against the service functions.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://… TEST_PORT=4437 node test/ad-cost-per-won.test.mjs
 * The harness seeds its own users/records, boots the real API, and
 * cleans up. Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { carriesCampaignTag, costPerWonCents, recordedCostCents } from '../src/services/adOutcomes.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4437);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const DRILL_JWT = ['cpw', 'drill', 'jwt', 'secret'].join('-');

const TAG_A = 'adstudio-drill-house';
const TAG_B = 'adstudio-drill-ext';

const IDS = {
  owner: '30000000-0000-4000-8000-0000000000f1',
  customerUser: '30000000-0000-4000-8000-0000000000f2',
  campA: '30000000-0000-4000-8000-0000000000a1',
  campB: '30000000-0000-4000-8000-0000000000a2',
  bannerA: '30000000-0000-4000-8000-0000000000b1',
};
const cust = (n) => `c0000000-0000-4000-8000-0000000000${n}`;
const book = (n) => `b0000000-0000-4000-8000-0000000000${n}`;
const conn = (n) => `d0000000-0000-4000-8000-0000000000${n}`;
const pay = (n) => `e0000000-0000-4000-8000-0000000000${n}`;

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

const daysAgo = (days) => new Date(Date.now() - days * 86400000);
const isoDaysAgo = (days) => daysAgo(days).toISOString();
const receipt = (id, amountCents, days) => ({
  type: 'RECEIPT_RECORDED', actor: 'drill', at: isoDaysAgo(days),
  receipt: { id, method: 'CASH', amountCents, at: isoDaysAgo(days), recordedBy: 'drill' },
});
const created = (reference, days) => ({
  type: 'BOOKING_CREATED', actor: 'lead-intake', at: isoDaysAgo(days), connectionReference: reference, segment: 'RESIDENTIAL',
});

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'cpw-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [id, email, roles] of [
    [IDS.owner, 'owner@cpw.test', ['COMPANY_OWNER']],
    [IDS.customerUser, 'customer@cpw.test', ['CUSTOMER']],
  ]) {
    await prisma.user.upsert({
      where: { id }, update: { passwordHash },
      create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }

  // Campaigns + the house campaign's banner counters.
  await prisma.banner.create({
    data: {
      id: IDS.bannerA, placement: 'FOOTER', advertiserName: 'Top Speed Appliance', headline: 'Fridge repair',
      ctaUrl: 'https://topspeedserviceos.com/book', active: true, impressions: 1200, clicks: 30,
    },
  });
  await prisma.adCampaign.create({
    data: {
      id: IDS.campA, name: 'Drill House Fridge', businessLine: 'TOP_SPEED', objective: 'Bookings',
      status: 'ACTIVE', destinationUrl: 'https://topspeedserviceos.com/book', sourceTag: TAG_A,
      placement: 'BANNER', bannerId: IDS.bannerA,
    },
  });
  await prisma.adCampaign.create({
    data: {
      id: IDS.campB, name: 'Drill Advertiser Air', businessLine: 'EXTERNAL', objective: 'Leads',
      status: 'ACTIVE', destinationUrl: 'https://example.com/', sourceTag: TAG_B,
      placement: 'NONE', advertiserName: 'Drill Air Co',
    },
  });

  const mkCustomer = (n, name) => prisma.customer.create({
    data: { id: cust(n), companyId: PLATFORM_COMPANY_ID, name, phone: `95455503${n}`, city: 'Davie', zip: '33314' },
  });
  const mkBooking = (n, customerId, data) => prisma.serviceRequest.create({
    data: {
      id: book(n), companyId: PLATFORM_COMPANY_ID, customerId, city: 'Davie', zip: '33314',
      appliance: 'Refrigerator', issue: 'Not cooling', history: [], ...data,
    },
  });
  const mkConn = (n, data) => prisma.connection.create({
    data: { id: conn(n), name: 'Drill Lead', phone: '9545550399', type: 'SERVICE_REQUEST', source: 'drill', ...data },
  });

  // ── Campaign A ────────────────────────────────────────────────
  // A1: lead (utmCampaign) → COMPLETED booking, estimate $309,
  //     PAID $99 payment + $210 receipt (+ a PENDING $50 that must
  //     never count) → WON, collected 30900, pipeline value 30900.
  await mkCustomer('a1', 'Won Wanda');
  await mkConn('a1', { reference: 'TS-CPWA1', utmCampaign: TAG_A, createdAt: daysAgo(5) });
  await mkBooking('a1', cust('a1'), {
    referenceCode: 'TS-CPWA1B', status: 'COMPLETED', createdAt: daysAgo(5),
    history: [
      created('TS-CPWA1', 5),
      { type: 'ESTIMATE_SAVED', actor: 'drill', at: isoDaysAgo(4), estimate: { id: 'est-a1', version: 1, kind: 'REPAIR', totalCents: 30900 } },
      receipt('rc-a1', 21000, 3),
    ],
  });
  await prisma.payment.create({
    data: { id: pay('a1'), companyId: PLATFORM_COMPANY_ID, serviceRequestId: book('a1'), customerId: cust('a1'), purpose: 'DIAGNOSTIC', amountCents: 9900, status: 'PAID', paidAt: daysAgo(4) },
  });
  await prisma.payment.create({
    data: { id: pay('a2'), companyId: PLATFORM_COMPANY_ID, serviceRequestId: book('a1'), customerId: cust('a1'), purpose: 'DIAGNOSTIC', amountCents: 5000, status: 'PENDING' },
  });
  // A2: lead (via tag) → booking with an estimate, not won → ESTIMATE.
  await mkCustomer('a2', 'Estimate Ed');
  await mkConn('a2', { reference: 'TS-CPWA2', viaTag: TAG_A, createdAt: daysAgo(4) });
  await mkBooking('a2', cust('a2'), {
    referenceCode: 'TS-CPWA2B', status: 'CONFIRMED', createdAt: daysAgo(4),
    history: [
      created('TS-CPWA2', 4),
      { type: 'ESTIMATE_SAVED', actor: 'drill', at: isoDaysAgo(3), estimate: { id: 'est-a2', version: 1, kind: 'REPAIR', totalCents: 45000 } },
    ],
  });
  // A3: lead (flat source = tag), no booking → NEW.
  await mkConn('a3', { reference: 'TS-CPWA3', source: TAG_A, createdAt: daysAgo(3) });
  // A4: standalone tagged booking, COMPLETED, $150 receipt → WON.
  await mkCustomer('a4', 'Direct Deb');
  await mkBooking('a4', cust('a4'), {
    referenceCode: 'TS-CPWA4B', status: 'COMPLETED', createdAt: daysAgo(2), utmCampaign: TAG_A,
    history: [receipt('rc-a4', 15000, 2)],
  });
  // A-old: tagged lead 45 days out — outside the 30-day window,
  // inside the 90-day window. COMPLETED, $70 receipt.
  await mkCustomer('a5', 'Old Olga');
  await mkConn('a5', { reference: 'TS-CPWA5', utmCampaign: TAG_A, createdAt: daysAgo(45) });
  await mkBooking('a5', cust('a5'), {
    referenceCode: 'TS-CPWA5B', status: 'COMPLETED', createdAt: daysAgo(45),
    history: [created('TS-CPWA5', 45), receipt('rc-a5', 7000, 44)],
  });

  // ── Campaign B ────────────────────────────────────────────────
  // B1: lead whose SETTER-STORED stage is WON (booking only
  //     CONFIRMED) + PAID $99 → WON, collected 9900.
  await mkCustomer('b1', 'Stored Stan');
  await mkConn('b1', { reference: 'TS-CPWB1', utmCampaign: TAG_B, pipelineStage: 'WON', createdAt: daysAgo(2) });
  await mkBooking('b1', cust('b1'), {
    referenceCode: 'TS-CPWB1B', status: 'CONFIRMED', createdAt: daysAgo(2),
    history: [created('TS-CPWB1', 2)],
  });
  await prisma.payment.create({
    data: { id: pay('b1'), companyId: PLATFORM_COMPANY_ID, serviceRequestId: book('b1'), customerId: cust('b1'), purpose: 'DIAGNOSTIC', amountCents: 9900, status: 'PAID', paidAt: daysAgo(2) },
  });
  // B2: tagged lead, no booking → NEW.
  await mkConn('b2', { reference: 'TS-CPWB2', utmCampaign: TAG_B, createdAt: daysAgo(1) });

  // ── Unattributed ──────────────────────────────────────────────
  // U1: untagged lead → COMPLETED booking, $50 receipt → WON.
  await mkCustomer('c1', 'Plain Pam');
  await mkConn('c1', { reference: 'TS-CPWU1', createdAt: daysAgo(2) });
  await mkBooking('c1', cust('c1'), {
    referenceCode: 'TS-CPWU1B', status: 'COMPLETED', createdAt: daysAgo(2),
    history: [created('TS-CPWU1', 2), receipt('rc-u1', 5000, 2)],
  });
  // U2: untagged standalone booking → NEW unit.
  await mkCustomer('c2', 'Plain Pete');
  await mkBooking('c2', cust('c2'), {
    referenceCode: 'TS-CPWU2B', status: 'CONFIRMED', createdAt: daysAgo(1), history: [],
  });

  // X1: a NON-lead connection carrying campaign A's tag — the
  // pipeline universe excludes it, so it must appear nowhere.
  await prisma.connection.create({
    data: {
      id: conn('f1'), name: 'Provider Pat', phone: '9545550398', type: 'PROVIDER_APPLICATION',
      source: 'drill', reference: 'TS-CPWX1', utmCampaign: TAG_A, createdAt: daysAgo(1),
    },
  });
}

function startServer() {
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: DRILL_JWT,
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL,
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_V2: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return proc;
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('server did not come up');
}

async function main() {
  // ── Pure cost math (the "cost exists" branch, drilled directly) ──
  check('costPerWon divides recorded cost by won jobs', costPerWonCents(50000, 4), 12500);
  check('costPerWon rounds to integer cents', costPerWonCents(10000, 3), 3333);
  check('costPerWon with zero won jobs is null', costPerWonCents(50000, 0), null);
  check('costPerWon with no recorded cost is null', costPerWonCents(null, 4), null);
  check('a recorded zero cost is a real figure ($0.00 per won)', costPerWonCents(0, 4), 0);
  check('recordedCostCents: a plain campaign record has none', recordedCostCents({ name: 'x', sourceTag: 't' }), null);
  check('recordedCostCents reads a recorded spend figure when one exists', recordedCostCents({ spendCents: 12345 }), 12345);
  check('recordedCostCents rejects a negative figure', recordedCostCents({ spendCents: -5 }), null);
  check('recordedCostCents rejects a string figure', recordedCostCents({ spendCents: '5000' }), null);
  checkTrue('carriesTag: flat source', carriesCampaignTag({ source: 't' }, 't'));
  checkTrue('carriesTag: attribution via', carriesCampaignTag({ attribution: { via: 't' } }, 't'));
  checkTrue('carriesTag: attribution utmCampaign', carriesCampaignTag({ attribution: { utmCampaign: 't' } }, 't'));
  check('carriesTag: utmSource alone does not attribute', carriesCampaignTag({ attribution: { utmSource: 't' } }, 't'), false);
  check('carriesTag: null record', carriesCampaignTag(null, 't'), false);

  await seed();
  server = startServer();
  try {
    await waitForServer();

    // ── Gate ──────────────────────────────────────────────────────
    const anon = await api('/ad-studio/cost-per-won');
    check('anonymous read is refused (401)', anon.status, 401);
    const customerToken = await login('customer@cpw.test');
    const asCustomer = await api('/ad-studio/cost-per-won', { token: customerToken });
    check('customer read is refused (403)', asCustomer.status, 403);

    const ownerToken = await login('owner@cpw.test');

    // ── 30-day window ─────────────────────────────────────────────
    const r30 = await api('/ad-studio/cost-per-won?days=30', { token: ownerToken });
    check('owner read succeeds', r30.status, 200);
    const d30 = r30.json?.data || {};
    check('window echoes 30 days', d30.windowDays, 30);
    const rowA = (d30.rows || []).find((r) => r.sourceTag === TAG_A) || {};
    const rowB = (d30.rows || []).find((r) => r.sourceTag === TAG_B) || {};
    check('row A kind is HOUSE', rowA.kind, 'HOUSE');
    check('row A leads (3 tagged leads + 1 tagged standalone booking)', rowA.leads, 4);
    check('row A stage NEW (tag-only lead)', rowA.stageCounts?.NEW, 1);
    check('row A stage ESTIMATE (estimate on file)', rowA.stageCounts?.ESTIMATE, 1);
    check('row A stage WON (completed lead + standalone booking)', rowA.stageCounts?.WON, 2);
    check('row A estimates count', rowA.estimates, 2);
    check('row A won count', rowA.won, 2);
    check('row A won collected = PAID payment + receipts (PENDING excluded)', rowA.wonCollectedCents, 45900);
    check('row A won pipeline value = the estimate total where known', rowA.wonPipelineValueCents, 30900);
    check('row A won pipeline value known count', rowA.wonPipelineValueKnown, 1);
    check('row A impressions are the banner counter', rowA.impressions, 1200);
    check('row A clicks are the banner counter', rowA.clicks, 30);
    check('row A impressions scope labeled ALL_TIME', rowA.impressionsClicksScope, 'ALL_TIME');
    check('row A cost status is NO_COST_RECORDED', rowA.cost?.status, 'NO_COST_RECORDED');
    check('row A recorded cost is null', rowA.cost?.recordedCents, null);
    check('row A cost per won is null (never divided by an invented number)', rowA.cost?.perWonCents, null);

    check('row B kind is ADVERTISER', rowB.kind, 'ADVERTISER');
    check('row B leads', rowB.leads, 2);
    check('row B won (setter-stored stage wins)', rowB.won, 1);
    check('row B won collected = the PAID payment', rowB.wonCollectedCents, 9900);
    check('row B won pipeline value unknown → null', rowB.wonPipelineValueCents, null);
    check('row B impressions null (no banner — nothing counted)', rowB.impressions, null);
    check('row B clicks null (no banner)', rowB.clicks, null);
    check('row B cost status is NO_COST_RECORDED', rowB.cost?.status, 'NO_COST_RECORDED');

    const un = d30.unattributed || {};
    check('unattributed label', un.label, 'Not attributed to any campaign');
    check('unattributed leads (untagged lead + untagged booking; non-lead conn excluded)', un.leads, 2);
    check('unattributed won', un.won, 1);
    check('unattributed won collected', un.wonCollectedCents, 5000);
    check('totals leads = campaigns + unattributed', d30.totals?.leads, 8);
    check('totals won', d30.totals?.won, 4);
    check('totals won collected', d30.totals?.wonCollectedCents, 60800);
    checkTrue('cost note states the gap plainly', typeof d30.costNote === 'string' && d30.costNote.includes('No cost recorded'));

    // ── 90-day window pulls the old lead in ───────────────────────
    const r90 = await api('/ad-studio/cost-per-won?days=90', { token: ownerToken });
    const d90 = r90.json?.data || {};
    const rowA90 = (d90.rows || []).find((r) => r.sourceTag === TAG_A) || {};
    check('90-day window: row A leads include the 45-day lead', rowA90.leads, 5);
    check('90-day window: row A won', rowA90.won, 3);
    check('90-day window: row A won collected', rowA90.wonCollectedCents, 52900);
    check('90-day window: totals leads', d90.totals?.leads, 9);

    // ── Window parameter discipline (attribution idiom) ───────────
    const rClamp = await api('/ad-studio/cost-per-won?days=9999', { token: ownerToken });
    check('days clamps to 365', rClamp.json?.data?.windowDays, 365);
    const rJunk = await api('/ad-studio/cost-per-won?days=abc', { token: ownerToken });
    check('junk days falls back to 30', rJunk.json?.data?.windowDays, 30);

    // ── Regression smoke: the neighbors still answer ──────────────
    const results = await api('/ad-studio/results', { token: ownerToken });
    check('ad-studio results still answers', results.status, 200);
    const board = await api('/crm/pipeline', { token: ownerToken });
    check('crm pipeline board still answers', board.status, 200);
    check('pipeline board counts its own universe (7 lead connections, all time)', board.json?.data?.totalLeads, 7);
  } finally {
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  if (server) server.kill('SIGTERM');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

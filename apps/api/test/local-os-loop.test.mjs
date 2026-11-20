/**
 * Local OS loop — verification harness (2026-11-20, fixes 1, 2, 4).
 *
 * Drills the three interlink fixes end to end over HTTP against a
 * LOCAL test database:
 *
 * FIX 1 — the Flywheel loop's outcome stages are counted from real
 * records with the same campaign-tag join as cost per won job:
 * completed jobs (attributed bookings COMPLETED), reviews (F1
 * funnel asks in the outbox + Review rows on attributed bookings),
 * referrals (codes issued from attributed bookings → journeys →
 * credits). Untagged records must never leak into the counts, and
 * the totals are exact against the seeded fixtures.
 *
 * FIX 2 — recorded spend: AdCampaign.recordedSpendCents feeds the
 * cost-per-won seam. Staff record/correct/clear it through
 * PATCH /ad-studio/campaigns/:id/spend (any campaign status) and
 * through the general campaign edit; each change emits
 * AD_SPEND_RECORDED. Cost-per-won: no spend → NO_COST_RECORDED
 * (unchanged); spend + won → exact per-won division; spend + zero
 * won → spend shown, per-won null, status RECORDED. Advertisers
 * cannot set spend anywhere; anon is 401.
 *
 * FIX 4 — the interconnect registry carries console-to-console
 * edges (top-level `edges`) beyond the CRM surface's own list:
 * book-os → dispatch, dispatch → tech-app, book-os → ad-studio,
 * media-os → marketing-os, tech-app → finance. State derives per
 * request: 'live' ONLY from a real signal event in the feed.
 *
 * Usage:
 *   DATABASE_URL=postgresql://… TEST_PORT=4443 node test/local-os-loop.test.mjs
 * The harness seeds its own users/records, boots the real API, and
 * cleans up. Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { recordedCostCents } from '../src/services/adOutcomes.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4443);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const DRILL_JWT = ['loop', 'drill', 'jwt', 'secret'].join('-');

const TAG_LOOP = 'loop-drill';
const TAG_SPEND = 'loop-spend';
const TAG_ZEROWON = 'loop-spend-zerowon';
const TAG_ZERO = 'loop-zero';
const TAG_PATCH = 'loop-patch';
const TAG_ADV = 'loop-adv';

const IDS = {
  owner: '40000000-0000-4000-8000-0000000000f1',
  staff: '40000000-0000-4000-8000-0000000000f2',
  advertiser: '40000000-0000-4000-8000-0000000000f3',
  campSpend: '40000000-0000-4000-8000-0000000000a1',
  campZeroWon: '40000000-0000-4000-8000-0000000000a2',
  campZero: '40000000-0000-4000-8000-0000000000a3',
  campPatch: '40000000-0000-4000-8000-0000000000a4',
  campAdv: '40000000-0000-4000-8000-0000000000a5',
  campLoop: '40000000-0000-4000-8000-0000000000a6',
  referral: '40000000-0000-4000-8000-0000000000e1',
  journey: '40000000-0000-4000-8000-0000000000e2',
  credit: '40000000-0000-4000-8000-0000000000e3',
};
const cust = (n) => `c1000000-0000-4000-8000-0000000000${n}`;
const book = (n) => `b1000000-0000-4000-8000-0000000000${n}`;
const conn = (n) => `d1000000-0000-4000-8000-0000000000${n}`;
const pay = (n) => `e1000000-0000-4000-8000-0000000000${n}`;

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
const created = (reference, days) => ({
  type: 'BOOKING_CREATED', actor: 'lead-intake', at: isoDaysAgo(days), connectionReference: reference, segment: 'RESIDENTIAL',
});

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'loop-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [id, email, roles] of [
    [IDS.owner, 'owner@loop.test', ['COMPANY_OWNER']],
    [IDS.staff, 'staff@loop.test', ['COMPANY_ADMIN']],
    [IDS.advertiser, 'advertiser@loop.test', ['ADVERTISER']],
  ]) {
    await prisma.user.upsert({
      where: { id }, update: { passwordHash },
      create: {
        id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550110', roles, active: true,
        // The advertiser predates the Flywheel plans launch, so the
        // plans system grandfathers it onto the baseline features
        // (campaigns included) — the state a real long-standing
        // advertiser account is in.
        ...(email === 'advertiser@loop.test' ? { createdAt: new Date('2025-06-01T00:00:00Z') } : {}),
      },
    });
  }

  const mkCampaign = (id, name, sourceTag, extra = {}) => prisma.adCampaign.create({
    data: {
      id, name, businessLine: 'TOP_SPEED', objective: 'Bookings', status: 'ACTIVE',
      destinationUrl: 'https://topspeedserviceos.com/book', sourceTag, placement: 'NONE', ...extra,
    },
  });
  await mkCampaign(IDS.campLoop, 'Loop Drill Campaign', TAG_LOOP);
  await mkCampaign(IDS.campSpend, 'Spend Drill Campaign', TAG_SPEND);
  await mkCampaign(IDS.campZeroWon, 'Spend Zero Won Campaign', TAG_ZEROWON);
  await mkCampaign(IDS.campZero, 'All Zero Campaign', TAG_ZERO);
  await mkCampaign(IDS.campPatch, 'General Patch Campaign', TAG_PATCH, { status: 'DRAFT' });
  await mkCampaign(IDS.campAdv, 'Advertiser Own Campaign', TAG_ADV, {
    businessLine: 'EXTERNAL', advertiserName: 'Loop Advertiser', createdById: IDS.advertiser, status: 'DRAFT',
  });

  const mkCustomer = (n, name) => prisma.customer.create({
    data: { id: cust(n), companyId: PLATFORM_COMPANY_ID, name, phone: `95455504${n}`, city: 'Davie', zip: '33314' },
  });
  const mkBooking = (n, customerId, data) => prisma.serviceRequest.create({
    data: {
      id: book(n), companyId: PLATFORM_COMPANY_ID, customerId, city: 'Davie', zip: '33314',
      appliance: 'Refrigerator', issue: 'Not cooling', history: [], ...data,
    },
  });
  const mkConn = (n, data) => prisma.connection.create({
    data: { id: conn(n), name: 'Loop Lead', phone: '9545550499', type: 'SERVICE_REQUEST', source: 'drill', ...data },
  });

  // ── FIX 1 fixtures (tag loop-drill) ───────────────────────────
  // L1: lead (utmCampaign) → COMPLETED booking; review ask + review
  //     received; referral code issued from it → journey → credit.
  await mkCustomer('a1', 'Loop Laura');
  await mkConn('a1', { reference: 'TS-LOOP1', utmCampaign: TAG_LOOP, createdAt: daysAgo(4) });
  await mkBooking('a1', cust('a1'), {
    referenceCode: 'TS-LOOP1B', status: 'COMPLETED', createdAt: daysAgo(4),
    history: [created('TS-LOOP1', 4)],
  });
  // L2: lead (flat source = tag) → booking still CONFIRMED.
  await mkCustomer('a2', 'Loop Larry');
  await mkConn('a2', { reference: 'TS-LOOP2', source: TAG_LOOP, createdAt: daysAgo(3) });
  await mkBooking('a2', cust('a2'), {
    referenceCode: 'TS-LOOP2B', status: 'CONFIRMED', createdAt: daysAgo(3),
    history: [created('TS-LOOP2', 3)],
  });
  // L3: standalone tagged booking (utmCampaign on the booking),
  //     COMPLETED, no connection.
  await mkCustomer('a3', 'Loop Lena');
  await mkBooking('a3', cust('a3'), {
    referenceCode: 'TS-LOOP3B', status: 'COMPLETED', createdAt: daysAgo(2), utmCampaign: TAG_LOOP, history: [],
  });
  // U1: UNTAGGED completed booking with its own review ask + review
  //     — must never leak into the loop counts.
  await mkCustomer('a4', 'Plain Uma');
  await mkBooking('a4', cust('a4'), {
    referenceCode: 'TS-LOOPU1B', status: 'COMPLETED', createdAt: daysAgo(2), history: [],
  });

  // F1 review funnel records: asks are REVIEW_REQUEST outbox
  // entries (one per channel — two channels for L1 count ONCE);
  // received reviews are Review rows on the booking.
  const mkAsk = (bookingId, channel) => prisma.notificationOutbox.create({
    data: {
      companyId: PLATFORM_COMPANY_ID, channel, template: 'REVIEW_REQUEST', to: 'customer@example.com',
      payload: { bookingId }, status: 'SENT', eventKey: `booking:${bookingId}:review:${channel.toLowerCase()}`,
    },
  });
  await mkAsk(book('a1'), 'EMAIL');
  await mkAsk(book('a1'), 'SMS');
  await mkAsk(book('a4'), 'EMAIL');
  await prisma.review.create({
    data: { companyId: PLATFORM_COMPANY_ID, customerId: cust('a1'), bookingId: book('a1'), rating: 5, title: 'Fixed fast', body: 'Great work', status: 'PUBLISHED' },
  });
  await prisma.review.create({
    data: { companyId: PLATFORM_COMPANY_ID, customerId: cust('a4'), bookingId: book('a4'), rating: 4, title: 'Good', body: 'Untagged review', status: 'PUBLISHED' },
  });

  // Referral chain generated by the attributed booking L1.
  await prisma.referral.create({
    data: { id: IDS.referral, companyId: PLATFORM_COMPANY_ID, code: 'LOOPCODE1', issuedFromBookingId: book('a1'), customerId: cust('a1') },
  });
  await prisma.referralJourney.create({
    data: { id: IDS.journey, companyId: PLATFORM_COMPANY_ID, referralId: IDS.referral, code: 'LOOPCODE1', bookingId: book('a3'), status: 'CREDIT_ISSUED' },
  });
  await prisma.referralCredit.create({
    data: { id: IDS.credit, companyId: PLATFORM_COMPANY_ID, customerId: cust('a1'), journeyId: IDS.journey, amountCents: 2500, issuedBy: 'drill' },
  });

  // ── FIX 2 fixtures (tag loop-spend): one won job in window ────
  await mkCustomer('b1', 'Spend Sue');
  await mkConn('b1', { reference: 'TS-LOOPSPEND', utmCampaign: TAG_SPEND, createdAt: daysAgo(2) });
  await mkBooking('b1', cust('b1'), {
    referenceCode: 'TS-LOOPSPENDB', status: 'COMPLETED', createdAt: daysAgo(2),
    history: [created('TS-LOOPSPEND', 2)],
  });
  await prisma.payment.create({
    data: { id: pay('b1'), companyId: PLATFORM_COMPANY_ID, serviceRequestId: book('b1'), customerId: cust('b1'), purpose: 'DIAGNOSTIC', amountCents: 9900, status: 'PAID', paidAt: daysAgo(1) },
  });

  // ── FIX 4 fixtures: real signal events for three of the five
  //    edges. The media/marketing pair deliberately gets NONE, so
  //    it must stay 'linked'. ────────────────────────────────────
  const mkEvent = (type) => prisma.platformEvent.create({
    data: { type, source: 'loop-drill', actor: 'drill', entityType: 'BOOKING', entityId: book('a1'), details: {} },
  });
  await mkEvent('DISPATCH_MATCHED');
  await mkEvent('JOB_COMPLETED');
  await mkEvent('PAYMENT_RECEIVED');
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

async function cleanup() {
  const ids = Object.values(IDS);
  await prisma.referralCredit.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.referralJourney.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.referral.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.review.deleteMany({ where: { bookingId: { in: [book('a1'), book('a4')] } } }).catch(() => {});
  await prisma.notificationOutbox.deleteMany({ where: { template: 'REVIEW_REQUEST' } }).catch(() => {});
  await prisma.platformEvent.deleteMany({ where: { source: 'loop-drill' } }).catch(() => {});
  await prisma.payment.deleteMany({ where: { id: { in: [pay('b1')] } } }).catch(() => {});
  await prisma.serviceRequest.deleteMany({ where: { referenceCode: { startsWith: 'TS-LOOP' } } }).catch(() => {});
  await prisma.connection.deleteMany({ where: { id: { in: [conn('a1'), conn('a2'), conn('b1')] } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { id: { in: [cust('a1'), cust('a2'), cust('a3'), cust('a4'), cust('b1')] } } }).catch(() => {});
  await prisma.adCampaign.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
}

async function main() {
  // ── The seam reads the new field first (pure, drilled directly) ──
  check('recordedCostCents reads recordedSpendCents', recordedCostCents({ recordedSpendCents: 4200 }), 4200);
  check('recordedCostCents prefers recordedSpendCents over legacy keys', recordedCostCents({ recordedSpendCents: 100, spendCents: 999 }), 100);
  check('recordedCostCents: recorded zero is a real figure', recordedCostCents({ recordedSpendCents: 0 }), 0);
  check('recordedCostCents: null recorded spend is no cost', recordedCostCents({ recordedSpendCents: null }), null);

  await seed();
  server = startServer();
  try {
    await waitForServer();
    const owner = await login('owner@loop.test');
    const staff = await login('staff@loop.test');
    const advertiser = await login('advertiser@loop.test');

    // ── FIX 4: registry console edges ────────────────────────────
    check('registry unauthenticated', (await api('/interconnect/registry')).status, 401);
    const registry = await api('/interconnect/registry', { token: staff });
    check('registry 200', registry.status, 200);
    const edges = registry.json.data.edges || [];
    check('registry carries the five console edges', edges.length, 5);
    const edge = (from, to) => edges.find((e) => e.from === from && e.to === to);
    checkTrue('edge book-os → dispatch present', edge('book-os', 'dispatch'));
    checkTrue('edge dispatch → tech-app present', edge('dispatch', 'tech-app'));
    checkTrue('edge book-os → ad-studio present', edge('book-os', 'ad-studio'));
    checkTrue('edge media-os → marketing-os present', edge('media-os', 'marketing-os'));
    checkTrue('edge tech-app → finance present', edge('tech-app', 'finance'));
    check('book-os → dispatch is live from the seeded DISPATCH_MATCHED', edge('book-os', 'dispatch')?.state, 'live');
    check('book-os → dispatch last signal type', edge('book-os', 'dispatch')?.lastSignal?.type, 'DISPATCH_MATCHED');
    check('dispatch → tech-app is live from the seeded JOB_COMPLETED', edge('dispatch', 'tech-app')?.state, 'live');
    check('book-os → ad-studio is live from the seeded JOB_COMPLETED', edge('book-os', 'ad-studio')?.state, 'live');
    check('tech-app → finance is live from the seeded PAYMENT_RECEIVED', edge('tech-app', 'finance')?.state, 'live');
    check('media-os → marketing-os stays linked (no signal seeded)', edge('media-os', 'marketing-os')?.state, 'linked');
    check('media-os → marketing-os has no last signal', edge('media-os', 'marketing-os')?.lastSignal, null);
    check('linked edge label names the data link', edge('media-os', 'marketing-os')?.label, 'Linked — shared records');
    // The CRM surface's own edge list is untouched by fix 4.
    const surfaces = registry.json.data.surfaces || [];
    check('registry still carries 14 surfaces', surfaces.length, 14);
    const crm = surfaces.find((s) => s.id === 'crm');
    check('crm surface still carries its 7 edges', (crm?.edges || []).length, 7);

    // ── FIX 1: loop stages compute exactly ───────────────────────
    const loop = await api('/ad-studio/loop', { token: staff });
    check('loop 200', loop.status, 200);
    const stages = Object.fromEntries(loop.json.data.stages.map((s) => [s.id, s]));
    // The loop is platform-wide: L1 + L3 (loop-drill) plus the
    // spend campaign's own won job (loop-spend) are the three
    // attributed COMPLETED bookings; L2 is still CONFIRMED and the
    // untagged U1 completion must not leak in.
    check('loop completed jobs = the three attributed COMPLETED bookings', stages.completedJobs.value, 3);
    check('loop reviews received = the review on an attributed booking', stages.reviews.value, 1);
    check('loop review asks = distinct attributed bookings asked (2 channels count once)', stages.reviews.asksSent, 1);
    check('loop referrals = journeys under codes from attributed bookings', stages.referrals.value, 1);
    check('loop referral codes issued', stages.referrals.codesIssued, 1);
    check('loop referral credits issued', stages.referrals.creditsIssued, 1);

    // ── FIX 2: cost-per-won before any spend is recorded ─────────
    const cpwRow = (j, tag) => (j.json.data.rows || []).find((r) => r.sourceTag === tag);
    let cpw = await api('/ad-studio/cost-per-won?days=30', { token: staff });
    check('cost-per-won 200', cpw.status, 200);
    check('spend campaign won its one job', cpwRow(cpw, TAG_SPEND)?.won, 1);
    check('no spend recorded yet → recordedCents null', cpwRow(cpw, TAG_SPEND)?.cost?.recordedCents, null);
    check('no spend recorded yet → perWon null', cpwRow(cpw, TAG_SPEND)?.cost?.perWonCents, null);
    check('no spend recorded yet → NO_COST_RECORDED preserved', cpwRow(cpw, TAG_SPEND)?.cost?.status, 'NO_COST_RECORDED');
    check('all-zero campaign reads honest zeros', cpwRow(cpw, TAG_ZERO)?.leads, 0);
    check('all-zero campaign cost is NO_COST_RECORDED', cpwRow(cpw, TAG_ZERO)?.cost?.status, 'NO_COST_RECORDED');

    // ── FIX 2: role gates on the spend route ─────────────────────
    check('anon spend PATCH is 401', (await api(`/ad-studio/campaigns/${IDS.campSpend}/spend`, { method: 'PATCH', body: { recordedSpendCents: 100 } })).status, 401);
    check('advertiser spend PATCH on a house campaign is 403', (await api(`/ad-studio/campaigns/${IDS.campSpend}/spend`, { token: advertiser, method: 'PATCH', body: { recordedSpendCents: 100 } })).status, 403);
    check('advertiser spend PATCH on their OWN campaign is still 403', (await api(`/ad-studio/campaigns/${IDS.campAdv}/spend`, { token: advertiser, method: 'PATCH', body: { recordedSpendCents: 100 } })).status, 403);
    check('negative spend is 400', (await api(`/ad-studio/campaigns/${IDS.campSpend}/spend`, { token: staff, method: 'PATCH', body: { recordedSpendCents: -5 } })).status, 400);
    check('fractional spend is 400', (await api(`/ad-studio/campaigns/${IDS.campSpend}/spend`, { token: staff, method: 'PATCH', body: { recordedSpendCents: 10.5 } })).status, 400);
    check('unknown campaign spend PATCH is 404', (await api('/ad-studio/campaigns/40000000-0000-4000-8000-000000000099/spend', { token: staff, method: 'PATCH', body: { recordedSpendCents: 100 } })).status, 404);

    // The advertiser's own edit route has no spend field: the value
    // is stripped, never set.
    const advEdit = await api(`/ad-studio/my-campaigns/${IDS.campAdv}`, { token: advertiser, method: 'PATCH', body: { name: 'Advertiser Own Campaign Renamed', recordedSpendCents: 12345 } });
    check('advertiser own-campaign edit still works', advEdit.status, 200);
    const advRead = await api(`/ad-studio/campaigns/${IDS.campAdv}`, { token: staff });
    check('advertiser edit did NOT set spend', advRead.json.data.recordedSpendCents, null);

    // ── FIX 2: record spend on an ACTIVE campaign (the dedicated
    //    route is not status-locked — spend is known after a run) ──
    const spendSet = await api(`/ad-studio/campaigns/${IDS.campSpend}/spend`, { token: staff, method: 'PATCH', body: { recordedSpendCents: 10000 } });
    check('staff records spend on an ACTIVE campaign', spendSet.status, 200);
    check('spend PATCH returns the recorded figure', spendSet.json.data.recordedSpendCents, 10000);
    const spendRow = await prisma.adCampaign.findUnique({ where: { id: IDS.campSpend } });
    check('recorded spend persisted to the record', spendRow.recordedSpendCents, 10000);

    cpw = await api('/ad-studio/cost-per-won?days=30', { token: staff });
    check('spend recorded → recordedCents shows', cpwRow(cpw, TAG_SPEND)?.cost?.recordedCents, 10000);
    check('spend recorded → status RECORDED', cpwRow(cpw, TAG_SPEND)?.cost?.status, 'RECORDED');
    check('spend recorded → per-won is the exact division (10000 / 1 won)', cpwRow(cpw, TAG_SPEND)?.cost?.perWonCents, 10000);

    // The spend change is on the platform feed.
    const feed = await api('/platform/events?type=AD_SPEND_RECORDED&limit=50', { token: staff });
    const spendEvents = (feed.json.data || []).filter((e) => e.entityId === IDS.campSpend);
    checkTrue('AD_SPEND_RECORDED emitted for the campaign', spendEvents.length >= 1);
    check('AD_SPEND_RECORDED carries the recorded cents', spendEvents[0]?.details?.recordedSpendCents, 10000);

    // Correct the figure → per-won follows exactly.
    const spendFix = await api(`/ad-studio/campaigns/${IDS.campSpend}/spend`, { token: owner, method: 'PATCH', body: { recordedSpendCents: 5000 } });
    check('owner corrects the recorded spend', spendFix.status, 200);
    cpw = await api('/ad-studio/cost-per-won?days=30', { token: staff });
    check('corrected spend → per-won follows (5000 / 1 won)', cpwRow(cpw, TAG_SPEND)?.cost?.perWonCents, 5000);

    // Spend with zero won: spend shows, per-won stays null.
    const zeroWonSet = await api(`/ad-studio/campaigns/${IDS.campZeroWon}/spend`, { token: staff, method: 'PATCH', body: { recordedSpendCents: 7777 } });
    check('staff records spend on the zero-won campaign', zeroWonSet.status, 200);
    cpw = await api('/ad-studio/cost-per-won?days=30', { token: staff });
    check('zero-won campaign: recorded spend shows', cpwRow(cpw, TAG_ZEROWON)?.cost?.recordedCents, 7777);
    check('zero-won campaign: per-won stays null', cpwRow(cpw, TAG_ZEROWON)?.cost?.perWonCents, null);
    check('zero-won campaign: status is RECORDED (spend exists)', cpwRow(cpw, TAG_ZEROWON)?.cost?.status, 'RECORDED');

    // The general campaign edit carries the field too (DRAFT campaign).
    const generalPatch = await api(`/ad-studio/campaigns/${IDS.campPatch}`, { token: staff, method: 'PATCH', body: { recordedSpendCents: 2500 } });
    check('general campaign PATCH accepts recordedSpendCents', generalPatch.status, 200);
    check('general PATCH returns the recorded figure', generalPatch.json.data.recordedSpendCents, 2500);

    // Clearing returns the campaign to NO_COST_RECORDED.
    const cleared = await api(`/ad-studio/campaigns/${IDS.campSpend}/spend`, { token: staff, method: 'PATCH', body: { recordedSpendCents: null } });
    check('staff clears the recorded spend', cleared.status, 200);
    check('cleared spend reads null on the record', cleared.json.data.recordedSpendCents, null);
    cpw = await api('/ad-studio/cost-per-won?days=30', { token: staff });
    check('cleared → NO_COST_RECORDED again', cpwRow(cpw, TAG_SPEND)?.cost?.status, 'NO_COST_RECORDED');
    check('cleared → per-won null again', cpwRow(cpw, TAG_SPEND)?.cost?.perWonCents, null);

    // Neighbouring surfaces still answer.
    check('ad-studio campaigns list still answers', (await api('/ad-studio/campaigns', { token: staff })).status, 200);
    check('interconnect registry still answers', (await api('/interconnect/registry', { token: staff })).status, 200);
    check('bogus login still refused', (await api('/auth/login', { method: 'POST', body: { email: 'owner@loop.test', password: 'wrong-password' } })).status, 401);
  } finally {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  if (server) server.kill('SIGTERM');
  await cleanup().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

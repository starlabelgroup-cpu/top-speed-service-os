// Wave 3 ops drills (2026-11-20): D6 win-back campaigns + D7 dispatch
// map / distance ordering, against a LOCAL test database only.
//
// Proves:
//  - Segment math on seeded customers: lapsed-6 membership, and the
//    too-recent / booked-since / active-now / no-completed-job counts.
//  - Exclusions are absolute: a staff-recorded opt-out, an SMS-STOP
//    opt-out, an open complaint (escalated review with no staff
//    reply), and a no-contact record never receive a send.
//  - Sends are staff-triggered and logged: one campaign, real outbox
//    entries for the one eligible customer only, and an immediate
//    re-send reaches nobody (90-day recently-contacted rule).
//  - A recipient's texted reply is recorded as a WINBACK_REPLY and
//    surfaces on the CRM win-back replies list; a STOP text records
//    the opt-out with source SMS_STOP and the webhook still answers
//    with the standard TwiML.
//  - Distance math: haversine on known coordinates (Fort Lauderdale
//    center to Miami), zero for a point to itself.
//  - Suggestions carry straight-line distances ordered nearest-first
//    (GPS tech, then current-job-area tech, then farther GPS, then
//    no-position last) — and neither the suggestions read nor the
//    dispatch-map read creates an assignment (human approval only).
//  - The dispatch map positions today's Fort Lauderdale job at its
//    area center, leaves an unresolved-area job unpositioned, and
//    reports tech positions with their basis (GPS / current job area).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

process.env.WAVE3_OPS_TEST_DATABASE_URL ||=
  'postgres' + '://postgres@127.0.0.1:5591/wave3_ops_test';
process.env.DATABASE_URL = process.env.WAVE3_OPS_TEST_DATABASE_URL;
process.env.JWT_SECRET = 'wave3-ops-test-secret';

const { PrismaClient } = await import('@prisma/client');
const { PLATFORM_COMPANY_ID } = await import('../src/data/store.js');
const { persistAssignment, persistBooking, persistCustomer, persistProvider } = await import('../src/db/bookingsRepo.js');
const { createReview } = await import('../src/db/reviewsRepo.js');
const { hashPassword } = await import('../src/services/passwords.js');
const { haversineMiles, roundMiles } = await import('../src/services/dispatchMap.js');
const { findWinbackRecipient } = await import('../src/services/winback.js');

const prisma = new PrismaClient();
const PORT = 3317;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const COMPANY = PLATFORM_COMPANY_ID;

const IDS = {
  staff: '40000000-0000-4000-8000-0000000000a1',
  customerUser: '40000000-0000-4000-8000-0000000000a2',
};
const CUST = {
  lapsed: '40000000-0000-4000-8000-0000000000b1',
  recent: '40000000-0000-4000-8000-0000000000b2',
  bookedSince: '40000000-0000-4000-8000-0000000000b3',
  activeNow: '40000000-0000-4000-8000-0000000000b4',
  optedOut: '40000000-0000-4000-8000-0000000000b5',
  complained: '40000000-0000-4000-8000-0000000000b6',
  noContact: '40000000-0000-4000-8000-0000000000b7',
  neverCompleted: '40000000-0000-4000-8000-0000000000b8',
  stopTexter: '40000000-0000-4000-8000-0000000000b9',
};
let seq = 0;
const bid = () => `40000000-0000-4000-8000-00000000${String(0xc0 + (seq += 1)).padStart(4, '0')}`;

function monthsAgo(n, extraDays = 0) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setDate(d.getDate() - extraDays);
  return d.toISOString();
}
const nowIso = () => new Date().toISOString();

async function seedUser(id, email, roles) {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.user.upsert({
    where: { id },
    update: { passwordHash, roles, active: true },
    create: { id, companyId: COMPANY, email, passwordHash, roles, active: true },
  });
}

async function seedCustomer(id, name, phone, email) {
  const customer = {
    id, companyId: COMPANY, userId: null, name, phone, email,
    address: '1 Test Way', city: 'Fort Lauderdale', zip: '33311', createdAt: monthsAgo(14),
  };
  await persistCustomer(customer);
  return customer;
}

async function seedBooking(customer, { status, createdAt, completedAt = null, city = 'Fort Lauderdale', appliance = 'Refrigerator', ref }) {
  const booking = {
    id: bid(), companyId: COMPANY, customerId: customer.id, customer,
    referenceCode: ref, source: 'TEST', city, zip: '33311',
    serviceAddress: customer.address, appliance, issue: 'test issue',
    preferredWindow: null, diagnosticFee: 99, diagnosticFeeCreditedTowardRepair: true,
    feeStatus: 'COLLECTED_AT_BOOKING', status,
    dispatch: { mode: 'HYBRID', stage: 'BOOKED', candidateProviderIds: [], assignmentIds: [] },
    history: [], createdAt, updatedAt: completedAt || createdAt, completedAt,
  };
  await persistBooking(booking);
  // bookingToRow does not carry createdAt/updatedAt (Prisma stamps
  // them at insert — correct for real bookings, which persist at
  // creation). Backdated drill rows get their intended times written
  // directly so the server's boot hydration reads them.
  await prisma.serviceRequest.update({
    where: { id: booking.id },
    data: { createdAt: new Date(createdAt), updatedAt: new Date(completedAt || createdAt) },
  });
  return booking;
}

async function seedProvider(id, businessName, specialties = ['Refrigerator']) {
  const provider = {
    id, companyId: COMPANY, userId: null, businessName, type: 'INTERNAL_TEAM',
    specialties, serviceCities: ['Fort Lauderdale', 'Davie', 'Coral Springs'],
    rating: 5, active: true, createdAt: monthsAgo(12),
  };
  await persistProvider(provider);
  return provider;
}

async function seedAssignment(providerId, bookingId, extra = {}) {
  const assignment = {
    id: bid(), companyId: COMPANY, bookingId, providerId,
    providerCompanyId: COMPANY, status: 'COMPLETED', dispatchMode: 'HYBRID',
    approvalRequired: true, approvedBy: 'Service Setters', approvedAt: monthsAgo(1),
    createdAt: monthsAgo(1), updatedAt: monthsAgo(1), ...extra,
  };
  await persistAssignment(assignment);
  return assignment;
}

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
  } catch {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* TwiML */ }
  return { status: res.status, json, text };
}

async function postForm(path, fields) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, text: await res.text() };
}

async function login(email) {
  const res = await call('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return res.json?.token;
}

async function waitForServer() {
  for (let i = 0; i < 150; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}

async function pollUntil(fn, timeoutMs = 6000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ------------------------------- seed ------------------------------- */

await prisma.company.upsert({
  where: { id: COMPANY },
  update: {},
  create: { id: COMPANY, name: 'Top Speed Appliance', slug: 'wave3-ops-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
});
await seedUser(IDS.staff, 'wave3-staff@test.local', ['DISPATCHER']);
await seedUser(IDS.customerUser, 'wave3-customer@test.local', ['CUSTOMER']);

const custA = await seedCustomer(CUST.lapsed, 'Lapsed Lena', '9545550101', 'lena@test.local');
const custB = await seedCustomer(CUST.recent, 'Recent Raj', '9545550102', 'raj@test.local');
const custC = await seedCustomer(CUST.bookedSince, 'Booked Bea', '9545550103', 'bea@test.local');
const custD = await seedCustomer(CUST.activeNow, 'Active Al', '9545550104', 'al@test.local');
const custE = await seedCustomer(CUST.optedOut, 'Optout Ola', '9545550105', 'ola@test.local');
const custF = await seedCustomer(CUST.complained, 'Complain Cora', '9545550106', 'cora@test.local');
const custG = await seedCustomer(CUST.noContact, 'Nocontact Ned', null, null);
const custH = await seedCustomer(CUST.neverCompleted, 'Never Nia', '9545550108', 'nia@test.local');
const custI = await seedCustomer(CUST.stopTexter, 'Stoptext Sue', '9545550109', 'sue@test.local');

await seedBooking(custA, { status: 'COMPLETED', createdAt: monthsAgo(7, 2), completedAt: monthsAgo(7), ref: 'TS-W3A01' });
await seedBooking(custB, { status: 'COMPLETED', createdAt: monthsAgo(2, 2), completedAt: monthsAgo(2), ref: 'TS-W3B01' });
await seedBooking(custC, { status: 'COMPLETED', createdAt: monthsAgo(8, 2), completedAt: monthsAgo(8), ref: 'TS-W3C01' });
await seedBooking(custC, { status: 'CONFIRMED', createdAt: monthsAgo(1), ref: 'TS-W3C02' });
await seedBooking(custD, { status: 'COMPLETED', createdAt: monthsAgo(8, 2), completedAt: monthsAgo(8), ref: 'TS-W3D01' });
await seedBooking(custD, { status: 'IN_PROGRESS', createdAt: monthsAgo(9), ref: 'TS-W3D02' });
await seedBooking(custE, { status: 'COMPLETED', createdAt: monthsAgo(7, 2), completedAt: monthsAgo(7), ref: 'TS-W3E01' });
const fBooking = await seedBooking(custF, { status: 'COMPLETED', createdAt: monthsAgo(7, 2), completedAt: monthsAgo(7), ref: 'TS-W3F01' });
await seedBooking(custG, { status: 'COMPLETED', createdAt: monthsAgo(7, 2), completedAt: monthsAgo(7), ref: 'TS-W3G01' });
await seedBooking(custH, { status: 'CANCELLED', createdAt: monthsAgo(9), ref: 'TS-W3H01' });
await seedBooking(custI, { status: 'COMPLETED', createdAt: monthsAgo(7, 2), completedAt: monthsAgo(7), ref: 'TS-W3I01' });

// Open complaint for Cora: an escalated review the office never answered.
await createReview({
  companyId: COMPANY, customerId: custF.id, bookingId: fBooking.id,
  rating: 1, title: 'Still waiting', body: 'Nobody called me back.',
  status: 'PUBLISHED', escalated: true, escalationReason: 'NO_CALLBACK',
});

// Today's job in Fort Lauderdale + one in an unresolvable area, both
// for a walk-in customer with no history (today's bookings must not
// disturb the win-back segment seeds above).
const custJ = await seedCustomer('40000000-0000-4000-8000-0000000000ba', 'Walkin Wes', '9545550110', 'wes@test.local');
const jobToday = await seedBooking(custJ, { status: 'CONFIRMED', createdAt: nowIso(), ref: 'TS-W3JOB1' });
await seedBooking(custJ, { status: 'CONFIRMED', createdAt: nowIso(), city: 'Atlantis', ref: 'TS-W3JOB2' });

// Providers for distance ordering against the Fort Lauderdale job.
const P = {
  gpsNear: '40000000-0000-4000-8000-0000000000d1',
  gpsFar: '40000000-0000-4000-8000-0000000000d2',
  jobArea: '40000000-0000-4000-8000-0000000000d3',
  noPos: '40000000-0000-4000-8000-0000000000d4',
};
await seedProvider(P.gpsNear, 'Near GPS Tech');
await seedProvider(P.gpsFar, 'Far GPS Tech');
await seedProvider(P.jobArea, 'Davie Job Tech');
await seedProvider(P.noPos, 'No Position Tech');
// GPS at the Fort Lauderdale center itself (the job's own position).
await seedAssignment(P.gpsNear, fBooking.id, { lastLat: 26.1224, lastLng: -80.1373, lastLocationAt: nowIso() });
// GPS at the Coral Springs center.
await seedAssignment(P.gpsFar, fBooking.id, { lastLat: 26.2712, lastLng: -80.2706, lastLocationAt: nowIso() });
// No GPS; an open job in Davie positions this tech by that job's area.
const davieJob = await seedBooking(custJ, { status: 'IN_PROGRESS', createdAt: nowIso(), city: 'Davie', ref: 'TS-W3D03' });
await seedAssignment(P.jobArea, davieJob.id, { status: 'ACCEPTED' });

/* --------------------------- unit: distance -------------------------- */

const flToMiami = haversineMiles({ lat: 26.1224, lng: -80.1373 }, { lat: 25.7617, lng: -80.1918 });
checkTrue('haversine: Fort Lauderdale center to Miami is 23–28 mi', flToMiami > 23 && flToMiami < 28);
check('haversine: a point to itself is zero', haversineMiles({ lat: 26.1224, lng: -80.1373 }, { lat: 26.1224, lng: -80.1373 }), 0);
check('roundMiles: one decimal', roundMiles(13.26), 13.3);

// Reply matching prefers the surviving record over a merged-away
// duplicate that kept the same phone as an alias (CRM merge, D5).
const mergeHit = findWinbackRecipient({
  customers: [
    { id: 'tombstone-1', phone: '9545550199', mergedIntoId: 'survivor-1' },
    { id: 'survivor-1', phone: '9545550199' },
  ],
  outbox: [{
    template: 'WINBACK_OFFER', status: 'QUEUED', createdAt: nowIso(),
    payload: { customerId: 'survivor-1', campaignId: 'camp-merge' },
  }],
  fromPhone: '+19545550199',
  now: new Date(),
});
check('reply match: the survivor wins over the tombstone', mergeHit?.customer?.id, 'survivor-1');

/* ------------------------------ server ------------------------------ */

const server = spawn('node', ['src/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

try {
  await waitForServer();
  const staffToken = await login('wave3-staff@test.local');
  const customerToken = await login('wave3-customer@test.local');
  checkTrue('staff login issued a token', staffToken);
  checkTrue('customer login issued a token', customerToken);

  /* ------------------------------ gates ------------------------------ */
  check('gate: anon win-back segments is 401', (await call('/crm/winback/segments')).status, 401);
  check('gate: customer win-back segments is 403', (await call('/crm/winback/segments', { token: customerToken })).status, 403);
  check('gate: anon dispatch map is 401', (await call('/bookos/dispatch-map')).status, 401);
  check('gate: customer dispatch map is 403', (await call('/bookos/dispatch-map', { token: customerToken })).status, 403);
  check('send: unknown segment is 400', (await call('/crm/winback/send', { method: 'POST', token: staffToken, body: { segment: 'lapsed-99' } })).status, 400);
  check('send: a non-win-back offer is 400', (await call('/crm/winback/send', { method: 'POST', token: staffToken, body: { segment: 'lapsed-6', offerSlug: 'commercial-service' } })).status, 400);

  /* --------------------- opt-out endpoint (staff) -------------------- */
  const optRes = await call(`/crm/customers/${CUST.optedOut}/marketing-opt-out`, { method: 'POST', token: staffToken, body: { optedOut: true } });
  check('opt-out endpoint: 200', optRes.status, 200);
  check('opt-out endpoint: source recorded as STAFF', optRes.json?.data?.customer?.marketingOptOut?.source, 'STAFF');

  /* ------------------------- segment math ---------------------------- */
  const segRes = await call('/crm/winback/segments', { token: staffToken });
  check('segments: 200', segRes.status, 200);
  const lapsed6 = (segRes.json?.data?.segments || []).find((s) => s.id === 'lapsed-6');
  check('segments: lapsed-6 eligible is the two clean lapsed customers', lapsed6?.eligible, 2);

  const preview = await call('/crm/winback/preview?segment=lapsed-6', { token: staffToken });
  check('preview: 200', preview.status, 200);
  const members = preview.json?.data?.members || [];
  const excluded = preview.json?.data?.excluded || [];
  const counts = preview.json?.data?.counts || {};
  check('preview: the members are the two clean lapsed customers',
    members.map((m) => m.customerId).sort(), [CUST.lapsed, CUST.stopTexter].sort());
  check('preview: member monthsSince is 7', members.find((m) => m.customerId === CUST.lapsed)?.monthsSince, 7);
  const reasonFor = (id) => excluded.find((x) => x.customerId === id)?.reason;
  check('preview: staff opt-out excluded as OPTED_OUT', reasonFor(CUST.optedOut), 'OPTED_OUT');
  check('preview: open complaint excluded as OPEN_COMPLAINT', reasonFor(CUST.complained), 'OPEN_COMPLAINT');
  check('preview: no-contact excluded as NO_CONTACT', reasonFor(CUST.noContact), 'NO_CONTACT');
  checkTrue('preview: counts include the too-recent customer', counts.tooRecent >= 1);
  checkTrue('preview: counts include the booked-since customer', counts.bookedSince >= 1);
  checkTrue('preview: counts include the active-now customer', counts.activeNow >= 1);
  checkTrue('preview: counts include the never-completed customer', counts.noCompletedJob >= 1);

  /* ------------------------------ send ------------------------------- */
  const send1 = await call('/crm/winback/send', { method: 'POST', token: staffToken, body: { segment: 'lapsed-6' } });
  check('send: 200', send1.status, 200);
  check('send: exactly the two eligible recipients', send1.json?.data?.recipients, 2);
  check('send: SMS + email queued per recipient (no providers configured, entries stay queued)', send1.json?.data?.queuedEntries, 4);
  const campaignId = send1.json?.data?.campaignId;
  checkTrue('send: a campaign id was issued', campaignId);

  const campaigns = await call('/crm/winback/campaigns', { token: staffToken });
  const campaignRows = campaigns.json?.data?.campaigns || [];
  check('campaigns: the send is in the history', campaignRows.length, 1);
  check('campaigns: recipient count is 2', campaignRows[0]?.recipientCount, 2);
  check('campaigns: default offer is the published seasonal checkup', campaignRows[0]?.offerSlug, 'seasonal-checkup');
  check('campaigns: no replies yet', campaignRows[0]?.replyCount, 0);

  const send2 = await call('/crm/winback/send', { method: 'POST', token: staffToken, body: { segment: 'lapsed-6' } });
  check('re-send: the same customer is NOT contacted twice (90-day rule)', send2.json?.data?.recipients, 0);
  check('re-send: nothing queued', send2.json?.data?.queuedEntries, 0);
  const preview2 = await call('/crm/winback/preview?segment=lapsed-6', { token: staffToken });
  check('re-send: preview now excludes her as RECENTLY_CONTACTED',
    (preview2.json?.data?.excluded || []).find((x) => x.customerId === CUST.lapsed)?.reason, 'RECENTLY_CONTACTED');

  /* --------------------------- reply routing -------------------------- */
  const replySms = await postForm('/api/v1/twilio/sms/incoming', {
    From: '+19545550101', To: '+18444607038', Body: 'Yes please, book my tune-up', MessageSid: 'SMwave3reply1',
  });
  check('reply sms: webhook answers 200', replySms.status, 200);
  checkTrue('reply sms: standard TwiML auto-reply is intact', replySms.text.includes('Thanks for texting Top Speed Appliance'));
  const replyRow = await pollUntil(async () => {
    const r = await call('/crm/winback/replies', { token: staffToken });
    return (r.json?.data?.replies || []).find((x) => x.customerId === CUST.lapsed) || null;
  });
  checkTrue('reply routing: the reply reached the win-back replies list', replyRow);
  check('reply routing: the reply carries the campaign id', replyRow?.campaignId, campaignId);
  const campaigns2 = await call('/crm/winback/campaigns', { token: staffToken });
  check('reply routing: the campaign now counts one reply', (campaigns2.json?.data?.campaigns || [])[0]?.replyCount, 1);

  /* ------------------------------ STOP -------------------------------- */
  const stopSms = await postForm('/api/v1/twilio/sms/incoming', {
    From: '+19545550109', To: '+18444607038', Body: 'STOP', MessageSid: 'SMwave3stop1',
  });
  check('STOP sms: webhook answers 200', stopSms.status, 200);
  const sueDetail = await pollUntil(async () => {
    const r = await call(`/crm/customers/${CUST.stopTexter}`, { token: staffToken });
    return r.json?.data?.customer?.marketingOptOut ? r.json.data.customer : null;
  });
  checkTrue('STOP: the opt-out was recorded', sueDetail);
  check('STOP: the opt-out source is SMS_STOP', sueDetail?.marketingOptOut?.source, 'SMS_STOP');
  const preview3 = await call('/crm/winback/preview?segment=lapsed-6', { token: staffToken });
  check('STOP: she is now excluded as OPTED_OUT',
    (preview3.json?.data?.excluded || []).find((x) => x.customerId === CUST.stopTexter)?.reason, 'OPTED_OUT');

  /* ------------------------- D7: suggestions -------------------------- */
  const assignCountBefore = await prisma.dispatchAssignment.count();
  const sugg = await call(`/bookos/bookings/${jobToday.id}/assignment-suggestions`, { token: staffToken });
  check('suggestions: 200', sugg.status, 200);
  checkTrue('suggestions: the distance note labels straight-line honestly',
    String(sugg.json?.data?.distanceNote || '').includes('straight-line'));
  const byId = Object.fromEntries((sugg.json?.data?.candidates || []).map((c) => [c.providerId, c]));
  checkTrue('distance: GPS tech at the job area center is ~0 mi', byId[P.gpsNear]?.distanceMiles != null && byId[P.gpsNear].distanceMiles < 0.6);
  check('distance: GPS tech basis is GPS', byId[P.gpsNear]?.distanceBasis, 'GPS');
  checkTrue('distance: Coral Springs GPS tech is 12–14.5 mi', byId[P.gpsFar]?.distanceMiles > 12 && byId[P.gpsFar].distanceMiles < 14.5);
  check('distance: Davie job tech basis is CURRENT_JOB_AREA', byId[P.jobArea]?.distanceBasis, 'CURRENT_JOB_AREA');
  checkTrue('distance: Davie job tech is 6.5–9.5 mi', byId[P.jobArea]?.distanceMiles > 6.5 && byId[P.jobArea].distanceMiles < 9.5);
  check('distance: no-position tech has no distance', byId[P.noPos]?.distanceMiles, null);
  // (The platform also seeds a network-partner provider at boot; the
  // assertion is over the four drilled providers' relative order.)
  const order = (sugg.json?.data?.candidatesByDistance || [])
    .map((c) => c.providerId)
    .filter((id) => Object.values(P).includes(id));
  check('distance order: nearest GPS, job-area, far GPS, no-position last',
    order, [P.gpsNear, P.jobArea, P.gpsFar, P.noPos]);

  /* ------------------------- D7: dispatch map ------------------------- */
  const map = await call('/bookos/dispatch-map', { token: staffToken });
  check('dispatch map: 200', map.status, 200);
  const mapJob = (map.json?.data?.jobs || []).find((j) => j.bookingId === jobToday.id);
  checkTrue('dispatch map: today\'s job is plotted', mapJob);
  check('dispatch map: the job sits at its area center', mapJob?.position?.basis, 'AREA_CENTER');
  check('dispatch map: the job area is Fort Lauderdale', mapJob?.area, 'Fort Lauderdale');
  checkTrue('dispatch map: the unresolved-area job is listed unpositioned',
    (map.json?.data?.unpositionedJobs || []).some((j) => j.referenceCode === 'TS-W3JOB2'));
  const mapTech = Object.fromEntries((map.json?.data?.techs || []).map((t) => [t.providerId, t]));
  check('dispatch map: GPS tech position basis', mapTech[P.gpsNear]?.position?.basis, 'GPS');
  check('dispatch map: job-area tech position basis', mapTech[P.jobArea]?.position?.basis, 'CURRENT_JOB_AREA');
  check('dispatch map: no-position tech has no position', mapTech[P.noPos]?.position, null);
  checkTrue('dispatch map: the note never claims drive time',
    String(map.json?.data?.note || '').includes('not drive time'));

  const assignCountAfter = await prisma.dispatchAssignment.count();
  check('no auto-dispatch: suggestions + map reads created zero assignments', assignCountAfter, assignCountBefore);
} finally {
  server.kill('SIGTERM');
  await prisma.$disconnect();
}

console.log(`\nwave3-ops drills: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length) {
  console.log(serverLog.slice(-3000));
  process.exit(1);
}

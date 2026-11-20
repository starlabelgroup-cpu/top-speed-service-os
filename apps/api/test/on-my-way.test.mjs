/**
 * "On My Way" alerts (A3) + Honest cost-structure estimator (A4) —
 * verification harness (2026-11-20).
 *
 * A3 proofs, over HTTP against the real API with Resend + Twilio
 * stubbed at their API bases (captured payloads are exactly what the
 * providers would receive):
 *   - A tech with a first name and a real profile photo (set through
 *     the real PATCH /provider/profile) taps En route on an assigned
 *     job whose appointment is SET for today, window 10 AM–12 PM:
 *     exactly ONE SMS + ONE email reach the customer. The SMS names
 *     the tech, carries the window + ETA, and is an MMS whose
 *     MediaUrl is the token-gated photo URL; the email names the
 *     tech + window and carries the photo as an attachment. The
 *     outbox holds exactly two TECH_EN_ROUTE entries keyed to
 *     departure 1, both SENT.
 *   - A second En route tap with no stage change in between sends
 *     NOTHING new (one alert per departure); after Arrived, a new
 *     En route tap is departure 2 and alerts again.
 *   - The token in the MMS URL opens the public tracking read
 *     (technician.firstName + photoAvailable) and serves the exact
 *     photo bytes; a bogus token 404s. The signed-in customer who
 *     owns the booking reads the same photo; another account 404s.
 *   - A tech with NO first name and NO photo, on a booking with NO
 *     appointment and NO preferred window: the alert still fires
 *     once, with the plain fallback wording, no window text, no
 *     MediaUrl, no attachment — and the photo route 404s (never a
 *     placeholder, never a broken image).
 *
 * A4 proofs, in a vm against the real shared component file: for
 * every appliance × service × customer combination, the rendered
 * panel contains ONLY the locked figures (repair+home: $99 + $210;
 * install+home: $150; commercial: no dollar amounts at all, with
 * custom-quote copy), never a range, and always ends at the
 * form-first /book CTA.
 *
 * Runs against a LOCAL test database only. Usage:
 *   set DATABASE_URL to a local TEST database connection string
 *   node test/on-my-way.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID, store } from '../src/data/store.js';
import { persistAssignment, persistBooking, persistCustomer } from '../src/db/bookingsRepo.js';

const DB_URL = process.env['DATABASE_' + 'URL'];
if (!DB_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env['DATABASE_' + 'URL_UNPOOLED'] ||= DB_URL;

const PORT = Number(process.env.TEST_PORT || 4491);
const STUB_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'onmyway-drill-1234';

// A real 1x1 JPEG (magic bytes FF D8 FF) — the tech's profile photo.
const PHOTO_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==';
const PHOTO_URL = `data:image/jpeg;base64,${PHOTO_B64}`;
const PHOTO_BYTES = Buffer.from(PHOTO_B64, 'base64');

const IDS = {
  providerCompanyA: '20000000-0000-4000-8000-0000000000a1',
  providerA: '20000000-0000-4000-8000-0000000000a2',
  techA: '20000000-0000-4000-8000-0000000000a3',
  customerUser: '20000000-0000-4000-8000-0000000000a4',
  customerA: '20000000-0000-4000-8000-0000000000a5',
  bookingA: '20000000-0000-4000-8000-0000000000a6',
  assignmentA: '20000000-0000-4000-8000-0000000000a7',
  providerCompanyB: '20000000-0000-4000-8000-0000000000b1',
  providerB: '20000000-0000-4000-8000-0000000000b2',
  techB: '20000000-0000-4000-8000-0000000000b3',
  customerB: '20000000-0000-4000-8000-0000000000b4',
  bookingB: '20000000-0000-4000-8000-0000000000b5',
  assignmentB: '20000000-0000-4000-8000-0000000000b6',
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;
let checks = 0;
const emailCaptures = [];
const smsCaptures = [];

function check(label, actual, expected) {
  checks += 1;
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

async function waitFor(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return predicate();
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}

function bootServer() {
  const childEnv = { ...process.env, PORT: String(PORT) };
  childEnv['JWT_' + 'SECRET'] = 'on-my-way-drill-secret';
  childEnv['RESEND_' + 'API_KEY'] = 'drill-resend-key';
  childEnv['RESEND_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
  childEnv['EMAIL_' + 'FROM'] = 'Top Speed Appliance <service@topspeedappliance.net>';
  childEnv['TWILIO_' + 'ACCOUNT_SID'] = 'ACOnMyWayDrill';
  childEnv['TWILIO_' + 'AUTH_TOKEN'] = 'drill-twilio-token';
  childEnv['TWILIO_' + 'PHONE_NUMBER'] = '+18445550100';
  childEnv['TWILIO_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return waitForServer();
}

async function stopServer() {
  if (!server) return;
  const stopped = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]);
  server = null;
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [companyId, providerId, slug] of [
    [IDS.providerCompanyA, IDS.providerA, 'onmyway-provider-a'],
    [IDS.providerCompanyB, IDS.providerB, 'onmyway-provider-b'],
  ]) {
    await prisma.company.upsert({
      where: { id: companyId },
      update: {},
      create: { id: companyId, name: 'OnMyWay Test Provider Co', slug, type: 'INDEPENDENT_PROVIDER' },
    });
    await prisma.provider.upsert({
      where: { id: providerId },
      update: {},
      create: { id: providerId, companyId, businessName: 'OnMyWay Test Provider Co', type: 'INDEPENDENT_PROVIDER', specialties: [], serviceCities: [] },
    });
  }
  // Tech A: HAS a first name. Photo is set later, through the real
  // PATCH /provider/profile, exactly like the Settings screen does.
  await prisma.user.upsert({
    where: { id: IDS.techA },
    update: { passwordHash, firstName: 'Marcus', techSettings: {} },
    create: { id: IDS.techA, companyId: IDS.providerCompanyA, email: 'tech-a@test.local', passwordHash, firstName: 'Marcus', lastName: 'Alvarez', phone: '9545550110', roles: ['PROVIDER_TECH'], active: true },
  });
  // Tech B: NO first name, NO photo — the fallback path.
  await prisma.user.upsert({
    where: { id: IDS.techB },
    update: { passwordHash, firstName: null, techSettings: {} },
    create: { id: IDS.techB, companyId: IDS.providerCompanyB, email: 'tech-b@test.local', passwordHash, phone: '9545550111', roles: ['PROVIDER_TECH'], active: true },
  });
  // The customer behind booking A also holds a login (email match).
  await prisma.user.upsert({
    where: { id: IDS.customerUser },
    update: { passwordHash },
    create: { id: IDS.customerUser, companyId: PLATFORM_COMPANY_ID, email: 'customer-a@test.local', passwordHash, firstName: 'Casey', phone: '9545550178', roles: ['CUSTOMER'], active: true },
  });

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const customerA = {
    id: IDS.customerA, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'Casey Customer', phone: '9545550178', email: 'customer-a@test.local',
    address: '742 Test Terrace', city: 'Fort Lauderdale', zip: '33311', createdAt: now,
  };
  const bookingA = {
    id: IDS.bookingA, companyId: PLATFORM_COMPANY_ID, customerId: customerA.id,
    customer: customerA, referenceCode: 'TS-OMW0A1', source: 'TEST',
    city: 'Fort Lauderdale', zip: '33311', appliance: 'Washer', issue: 'Not draining',
    preferredWindow: null, diagnosticFee: 99, feeStatus: 'COLLECTED_AT_BOOKING',
    status: 'CONFIRMED',
    appointment: { date: today, window: '10-12', status: 'SET', setAt: now, setBy: 'drill' },
    dispatch: { mode: 'HYBRID', stage: 'ASSIGNED', candidateProviderIds: [], assignmentIds: [IDS.assignmentA] },
    history: [], createdAt: now, updatedAt: now,
  };
  const assignmentA = {
    id: IDS.assignmentA, companyId: PLATFORM_COMPANY_ID, bookingId: bookingA.id,
    providerId: IDS.providerA, providerCompanyId: IDS.providerCompanyA,
    status: 'APPROVED', dispatchMode: 'HYBRID', approvalRequired: true,
    approvedBy: 'Service Setters', approvedAt: now,
  };
  const customerB = {
    id: IDS.customerB, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'Blair Customer', phone: '9545550179', email: 'customer-b@test.local',
    address: '918 Test Avenue', city: 'Sunrise', zip: '33322', createdAt: now,
  };
  const bookingB = {
    id: IDS.bookingB, companyId: PLATFORM_COMPANY_ID, customerId: customerB.id,
    customer: customerB, referenceCode: 'TS-OMW0B2', source: 'TEST',
    city: 'Sunrise', zip: '33322', appliance: 'Dryer', issue: 'No heat',
    preferredWindow: null, diagnosticFee: 99, feeStatus: 'COLLECTED_AT_BOOKING',
    status: 'CONFIRMED',
    dispatch: { mode: 'HYBRID', stage: 'ASSIGNED', candidateProviderIds: [], assignmentIds: [IDS.assignmentB] },
    history: [], createdAt: now, updatedAt: now,
  };
  const assignmentB = {
    id: IDS.assignmentB, companyId: PLATFORM_COMPANY_ID, bookingId: bookingB.id,
    providerId: IDS.providerB, providerCompanyId: IDS.providerCompanyB,
    status: 'APPROVED', dispatchMode: 'HYBRID', approvalRequired: true,
    approvedBy: 'Service Setters', approvedAt: now,
  };
  for (const [customer, booking, assignment] of [[customerA, bookingA, assignmentA], [customerB, bookingB, assignmentB]]) {
    store.customers.set(customer.id, customer);
    store.bookings.set(booking.id, booking);
    store.dispatchAssignments.set(assignment.id, assignment);
    await persistCustomer(customer);
    await persistBooking(booking);
    await persistAssignment(assignment);
  }
}

async function cleanup() {
  const ids = Object.values(IDS);
  try {
    await prisma.notificationOutbox.deleteMany({ where: { OR: [{ eventKey: { contains: IDS.bookingA } }, { eventKey: { contains: IDS.bookingB } }] } });
    await prisma.trackingToken.deleteMany({ where: { bookingId: { in: [IDS.bookingA, IDS.bookingB] } } });
    await prisma.dispatchAssignment.deleteMany({ where: { id: { in: ids } } });
    await prisma.booking.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.provider.deleteMany({ where: { id: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: [IDS.providerCompanyA, IDS.providerCompanyB] } } });
  } catch { /* best-effort cleanup on a throwaway database */ }
}

function enRouteOutbox(bookingId) {
  return prisma.notificationOutbox.findMany({
    where: { template: 'TECH_EN_ROUTE', eventKey: { contains: bookingId } },
    orderBy: { createdAt: 'asc' },
  });
}

/* ------------------------------ A4 ------------------------------ */

function estimatorChecks() {
  const file = fileURLToPath(new URL('../../web/shared/cost-estimator.js', import.meta.url));
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: 'cost-estimator.js' });
  const est = sandbox.window.TSCostEstimator;
  checkTrue('A4: component exposes the renderer', est && typeof est.render === 'function');
  if (!est) return;
  const appliances = est.APPLIANCES;
  check('A4: picker carries the 8 canonical appliances', appliances.length, 8);
  const amounts = (html) => [...new Set([...html.matchAll(/\$(\d[\d,]*)/g)].map((m) => m[1]))].sort().join(',');
  for (const appliance of appliances) {
    const repair = est.render({ appliance, service: 'repair', customer: 'home' });
    check(`A4 ${appliance} repair/home: only $99 + $210`, amounts(repair), '210,99');
    checkTrue(`A4 ${appliance} repair/home: no price range`, !/\$\d+\s*[-\u2013]\s*\$\d+/.test(repair));
    checkTrue(`A4 ${appliance} repair/home: credited wording`, repair.includes('credited in full toward an approved repair'));
    checkTrue(`A4 ${appliance} repair/home: ends at the booking form`, repair.includes('href="/book"'));

    const install = est.render({ appliance, service: 'install', customer: 'home' });
    check(`A4 ${appliance} install/home: only $150`, amounts(install), '150');
    checkTrue(`A4 ${appliance} install/home: no $99 diagnostic on an install`, !install.includes('$99'));
    checkTrue(`A4 ${appliance} install/home: ends at the booking form`, install.includes('href="/book"'));

    for (const service of ['repair', 'install']) {
      const commercial = est.render({ appliance, service, customer: 'business' });
      check(`A4 ${appliance} ${service}/business: zero dollar amounts`, amounts(commercial), '');
      checkTrue(`A4 ${appliance} ${service}/business: custom-quote copy`, commercial.includes('custom quote'));
      checkTrue(`A4 ${appliance} ${service}/business: ends at the booking form`, commercial.includes('href="/book"'));
    }
  }
}

/* ------------------------------ A3 ------------------------------ */

async function scenarioA(techToken, customerToken) {
  // The photo goes on through the real Settings save path.
  const patched = await api('/provider/profile', { token: techToken, method: 'PATCH', body: { photo: PHOTO_URL } });
  check('A3: PATCH profile photo accepted', patched.status, 200);
  check('A3: profile view reports the photo set', patched.json?.data?.photo?.set, true);
  const badPhoto = await api('/provider/profile', { token: techToken, method: 'PATCH', body: { photo: 'data:image/jpeg;base64,AAAA' } });
  check('A3: PATCH rejects non-image bytes as a photo', badPhoto.status, 400);

  // Departure 1.
  const tap = await api(`/provider/assignments/${IDS.assignmentA}/job-status`, {
    token: techToken, method: 'POST', body: { action: 'EN_ROUTE', etaMinutes: 25 },
  });
  checkTrue('A3: en-route tap accepted (200/201)', tap.status === 200 || tap.status === 201);
  checkTrue('A3: SMS + email delivered to the customer', await waitFor(() => smsCaptures.length >= 1 && emailCaptures.length >= 1));

  const sms = smsCaptures.find((c) => c.To && c.To.includes('9545550178'));
  checkTrue('A3: SMS went to the booking customer', Boolean(sms));
  if (sms) {
    checkTrue('A3: SMS names the tech by first name', sms.Body.includes('Marcus is on the way'));
    checkTrue('A3: SMS carries the appointment window', sms.Body.includes('10 AM\u201312 PM'));
    checkTrue('A3: SMS carries the ETA', sms.Body.includes('about 25 min away'));
    checkTrue('A3: SMS is an MMS with the token photo URL', typeof sms.MediaUrl === 'string' && /\/tracking\/by-token\/[^/]+\/tech-photo$/.test(sms.MediaUrl));
    checkTrue('A3: SMS track link carries the same token', sms.Body.includes('track?t='));
  }
  const email = emailCaptures.find((c) => Array.isArray(c.to) && c.to.includes('customer-a@test.local'));
  checkTrue('A3: email went to the booking customer', Boolean(email));
  if (email) {
    checkTrue('A3: email names the tech', email.text.includes('Marcus is on the way'));
    checkTrue('A3: email carries the window', email.text.includes('10 AM\u201312 PM'));
    check('A3: email carries exactly one attachment', (email.attachments || []).length, 1);
    check('A3: attachment is the tech photo bytes', email.attachments?.[0]?.content, PHOTO_B64);
  }
  let outbox = await enRouteOutbox(IDS.bookingA);
  check('A3: outbox holds exactly the departure-1 pair', outbox.length, 2);
  check('A3: outbox keys are departure 1', outbox.map((e) => e.eventKey).sort().join(' | '), [`booking:${IDS.bookingA}:enroute:1:email`, `booking:${IDS.bookingA}:enroute:1:sms`].sort().join(' | '));
  checkTrue('A3: both outbox entries delivered (SENT)', outbox.every((e) => e.status === 'SENT'));

  // Double-tap: same departure, nothing new.
  const smsBefore = smsCaptures.length;
  const emailBefore = emailCaptures.length;
  const tap2 = await api(`/provider/assignments/${IDS.assignmentA}/job-status`, {
    token: techToken, method: 'POST', body: { action: 'EN_ROUTE', etaMinutes: 20 },
  });
  checkTrue('A3: second en-route tap still accepted (200/201)', tap2.status === 200 || tap2.status === 201);
  await new Promise((r) => setTimeout(r, 3500));
  check('A3: double-tap sends no second SMS', smsCaptures.length, smsBefore);
  check('A3: double-tap sends no second email', emailCaptures.length, emailBefore);
  outbox = await enRouteOutbox(IDS.bookingA);
  check('A3: outbox unchanged after the double-tap', outbox.length, 2);

  // The photo + tracking reads behind the MMS token.
  const rawToken = sms?.MediaUrl ? /by-token\/([^/]+)\/tech-photo/.exec(sms.MediaUrl)?.[1] : null;
  checkTrue('A3: raw token recoverable from the MMS URL', Boolean(rawToken));
  if (rawToken) {
    const tracked = await api(`/tracking/by-token/${rawToken}`, { method: 'GET' });
    check('A3: token tracking read succeeds', tracked.status, 200);
    check('A3: tracking shows the tech first name', tracked.json?.data?.technician?.firstName, 'Marcus');
    check('A3: tracking reports the photo available', tracked.json?.data?.technician?.photoAvailable, true);
    const photoRes = await fetch(`${BASE}/tracking/by-token/${rawToken}/tech-photo`);
    check('A3: token photo read succeeds', photoRes.status, 200);
    check('A3: token photo is the JPEG', photoRes.headers.get('content-type'), 'image/jpeg');
    const served = Buffer.from(await photoRes.arrayBuffer());
    checkTrue('A3: served photo bytes are the profile photo', served.equals(PHOTO_BYTES));
  }
  const bogus = await fetch(`${BASE}/tracking/by-token/not-a-real-token/tech-photo`);
  check('A3: bogus token photo 404s', bogus.status, 404);

  // Signed-in owner reads it; a non-owner does not.
  const mine = await api('/tracking/mine', { token: customerToken, method: 'GET' });
  const myJob = (mine.json?.data || []).find((j) => j.id === IDS.bookingA);
  checkTrue('A3: signed-in customer sees the job', Boolean(myJob));
  check('A3: signed-in tracking shows the first name', myJob?.technician?.firstName, 'Marcus');
  const ownPhoto = await fetch(`${BASE}/tracking/bookings/${IDS.bookingA}/tech-photo`, { headers: { Authorization: `Bearer ${customerToken}` } });
  check('A3: owner photo read succeeds', ownPhoto.status, 200);
  const otherPhoto = await fetch(`${BASE}/tracking/bookings/${IDS.bookingA}/tech-photo`, { headers: { Authorization: `Bearer ${techToken}` } });
  check('A3: non-owner photo read 404s', otherPhoto.status, 404);
  const guestPhoto = await fetch(`${BASE}/tracking/by-reference/TS-OMW0A1/tech-photo?phone=9545550178`);
  check('A3: guest (ref + phone) photo read succeeds', guestPhoto.status, 200);
  const guestWrong = await fetch(`${BASE}/tracking/by-reference/TS-OMW0A1/tech-photo?phone=9545550000`);
  check('A3: guest with the wrong phone 403s', guestWrong.status, 403);

  // Departure 2: Arrived, then En route again — a new alert.
  await api(`/provider/assignments/${IDS.assignmentA}/job-status`, { token: techToken, method: 'POST', body: { action: 'ARRIVED' } });
  const tap3 = await api(`/provider/assignments/${IDS.assignmentA}/job-status`, {
    token: techToken, method: 'POST', body: { action: 'EN_ROUTE', etaMinutes: 10 },
  });
  checkTrue('A3: second departure tap accepted (200/201)', tap3.status === 200 || tap3.status === 201);
  checkTrue('A3: second departure delivers a fresh pair', await waitFor(() => smsCaptures.length >= smsBefore + 1 && emailCaptures.length >= emailBefore + 1));
  outbox = await enRouteOutbox(IDS.bookingA);
  check('A3: outbox now holds both departures', outbox.length, 4);
  checkTrue('A3: departure-2 keys exist', outbox.some((e) => e.eventKey === `booking:${IDS.bookingA}:enroute:2:sms`));
}

async function scenarioB(techToken) {
  const before = { sms: smsCaptures.length, email: emailCaptures.length };
  const tap = await api(`/provider/assignments/${IDS.assignmentB}/job-status`, {
    token: techToken, method: 'POST', body: { action: 'EN_ROUTE' },
  });
  checkTrue('A3/B: en-route tap accepted (200/201)', tap.status === 200 || tap.status === 201);
  checkTrue('A3/B: fallback SMS + email delivered', await waitFor(() => smsCaptures.length > before.sms && emailCaptures.length > before.email));
  const sms = smsCaptures.slice(before.sms).find((c) => c.To && c.To.includes('9545550179'));
  checkTrue('A3/B: SMS went to the booking customer', Boolean(sms));
  if (sms) {
    checkTrue('A3/B: fallback wording (no name on file)', sms.Body.includes('your technician is on the way'));
    checkTrue('A3/B: no window text invented', !/window/.test(sms.Body));
    checkTrue('A3/B: no MediaUrl without a photo', !sms.MediaUrl);
    checkTrue('A3/B: plain track link (no token minted)', sms.Body.includes('https://topspeedserviceos.com/track') && !sms.Body.includes('track?t='));
  }
  const email = emailCaptures.slice(before.email).find((c) => Array.isArray(c.to) && c.to.includes('customer-b@test.local'));
  checkTrue('A3/B: email went to the booking customer', Boolean(email));
  if (email) check('A3/B: no attachment without a photo', (email.attachments || []).length, 0);
  const outbox = await enRouteOutbox(IDS.bookingB);
  check('A3/B: outbox holds exactly one pair', outbox.length, 2);
  // No token exists for this job's photo — every photo door 404s.
  const guestPhoto = await fetch(`${BASE}/tracking/by-reference/TS-OMW0B2/tech-photo?phone=9545550179`);
  check('A3/B: photo route 404s when the tech has no photo', guestPhoto.status, 404);
}

/* ------------------------------ main ------------------------------ */

async function main() {
  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/emails') {
        try { emailCaptures.push(JSON.parse(raw)); } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'stub-email-id' }));
        return;
      }
      if (req.method === 'POST' && req.url.includes('/Messages.json')) {
        const form = Object.fromEntries(new URLSearchParams(raw));
        smsCaptures.push(form);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sid: 'SMstub' }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
  try {
    estimatorChecks();
    await seed();
    await bootServer();
    const techAToken = await login('tech-a@test.local');
    const techBToken = await login('tech-b@test.local');
    const customerToken = await login('customer-a@test.local');
    await scenarioA(techAToken, customerToken);
    await scenarioB(techBToken);
  } finally {
    await stopServer();
    stub.close();
    await cleanup().catch(() => {});
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? `\nALL ${checks} ON-MY-WAY / ESTIMATOR CHECKS PASSED` : `\n${failures} OF ${checks} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();

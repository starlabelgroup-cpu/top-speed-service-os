/**
 * Customer app Web Push — verification harness (2026-11-20, approved
 * recommendation B1).
 *
 * Exercises push as the THIRD channel of the notification outbox end
 * to end over HTTP:
 *   - GET /app/push/status + POST /app/push/subscribe|unsubscribe are
 *     signed-in, own-only doors (anon → 401; unsubscribing another
 *     account's endpoint → 404 and the row stays active).
 *   - Subscriptions are per-device rows in PushSubscription (endpoint
 *     unique; re-subscribe refreshes keys / revives a revoked row).
 *   - The booking lifecycle fans out to push beside email/SMS:
 *     booking created → BOOKING_CONFIRMATION push, dispatch approve →
 *     DISPATCH_APPROVED push, job completed → REVIEW_REQUEST push —
 *     to the booking customer's subscriptions ONLY (a subscribed
 *     bystander receives nothing).
 *   - Delivery runs through a local stub (WEB_PUSH_STUB_URL — the
 *     RESEND_API_BASE idiom): 2xx marks the outbox entry SENT; a 410
 *     revokes the subscription (SUBSCRIPTION_GONE) while the booking
 *     flow still returns 201; a 500 fails the entry, keeps the
 *     subscription, and the booking flow is unaffected.
 *   - With VAPID keys unset (second boot), status reports
 *     { available: false, publicKey: null } and subscribe → 503: the
 *     feature is cleanly OFF.
 *   - Static checks: the /app settings panel ships hidden and is only
 *     revealed by the status gate in the page script; sw.js carries
 *     the push + notificationclick handlers at CACHE_VERSION v4.
 *
 * Runs against a LOCAL test database only. Usage:
 *   set DATABASE_URL to a local TEST database connection string
 *   node test/app-push.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { generateVAPIDKeys } from 'web-push';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const DB_URL = process.env['DATABASE_' + 'URL'];
if (!DB_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env['DATABASE_' + 'URL_UNPOOLED'] ||= DB_URL;

const PORT = Number(process.env.TEST_PORT || 4491);
const STUB_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PW = 'drill-pass-12345';

const VAPID = generateVAPIDKeys();

const IDS = {
  customerA: '20000000-0000-4000-8000-0000000000a1',
  customerB: '20000000-0000-4000-8000-0000000000a2',
  staff: '20000000-0000-4000-8000-0000000000a3',
  providerCompany: '20000000-0000-4000-8000-0000000000a4',
  provider: '30000000-0000-4000-8000-0000000000a1',
};
const EMAILS = {
  a: 'push-a@test.local',
  b: 'push-b@test.local',
  staff: 'push-setter@test.local',
};
const ENDPOINTS = {
  a1: 'https://fcm.googleapis.com/fcm/send/drill-a1-ok',
  a2: 'https://fcm.googleapis.com/fcm/send/drill-a2-ok',
  b1: 'https://fcm.googleapis.com/fcm/send/drill-b1-ok',
  a410: 'https://fcm.googleapis.com/fcm/send/drill-a3-gone410',
  a500: 'https://fcm.googleapis.com/fcm/send/drill-a4-fail500',
};
const KEYS = {
  p256dh: 'BDrillP256dhKeyForPushSubscriptionTestsOnly0123456789abcdef',
  auth: 'drill-auth-secret-1',
};
const KEYS_ROTATED = {
  p256dh: 'BDrillP256dhKeyRotatedForPushSubscriptionTests0123456789zz',
  auth: 'drill-auth-secret-2',
};

const prisma = new PrismaClient();
let server = null;
let stub = null;
let failures = 0;
const deliveries = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function checkIncludes(label, haystack, needle) {
  const ok = String(haystack || '').includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (want ${JSON.stringify(needle)} inside ${JSON.stringify(String(haystack || '').slice(0, 140))})`);
}

async function api(path, { method = 'POST', body, token } = {}) {
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

async function waitFor(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
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

function bootServer({ withVapid }) {
  const childEnv = { ...process.env, PORT: String(PORT) };
  childEnv['JWT_' + 'SECRET'] = 'app-push-drill-secret';
  childEnv['WEB_PUSH_' + 'STUB_URL'] = `http://127.0.0.1:${STUB_PORT}/push`;
  childEnv['RESEND_' + 'API_KEY'] = 'drill-resend-key';
  childEnv['RESEND_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
  childEnv['EMAIL_' + 'FROM'] = 'Top Speed Appliance <service@topspeedappliance.net>';
  if (withVapid) {
    childEnv['VAPID_' + 'PUBLIC_KEY'] = VAPID.publicKey;
    childEnv['VAPID_' + 'PRIVATE_KEY'] = VAPID.privateKey;
  } else {
    delete childEnv['VAPID_' + 'PUBLIC_KEY'];
    delete childEnv['VAPID_' + 'PRIVATE_KEY'];
  }
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

function startStub() {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(raw || '{}'); } catch { parsed = null; }
      if (req.url === '/push' && parsed?.endpoint) {
        deliveries.push({ endpoint: parsed.endpoint, payload: parsed.payload });
        if (parsed.endpoint.includes('gone410')) { res.writeHead(410); return res.end('gone'); }
        if (parsed.endpoint.includes('gone404')) { res.writeHead(404); return res.end('gone'); }
        if (parsed.endpoint.includes('fail500')) { res.writeHead(500); return res.end('boom'); }
        res.writeHead(201); return res.end('accepted');
      }
      // Anything else is the Resend-shaped email capture: accept.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'stub-email-id' }));
    });
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
}

async function seed() {
  const passwordHash = await hashPassword(PW);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: IDS.providerCompany },
    update: {},
    create: { id: IDS.providerCompany, name: 'Drill Refrigeration Co', slug: 'drill-refrigeration', type: 'NETWORK_BUSINESS', isPlatformOwner: false },
  });
  const users = [
    { id: IDS.customerA, email: EMAILS.a, firstName: 'Push', lastName: 'Alpha', roles: ['CUSTOMER'] },
    { id: IDS.customerB, email: EMAILS.b, firstName: 'Push', lastName: 'Bystander', roles: ['CUSTOMER'] },
    { id: IDS.staff, email: EMAILS.staff, firstName: 'Drill', lastName: 'Setter', roles: ['DISPATCHER'] },
  ];
  for (const user of users) {
    await prisma.user.upsert({
      where: { id: user.id },
      update: { passwordHash, email: user.email, roles: user.roles },
      create: { ...user, companyId: PLATFORM_COMPANY_ID, passwordHash, active: true },
    });
  }
  await prisma.provider.upsert({
    where: { id: IDS.provider },
    update: { active: true },
    create: {
      id: IDS.provider,
      companyId: IDS.providerCompany,
      businessName: 'Drill Refrigeration',
      type: 'NETWORK_BUSINESS',
      specialties: ['Refrigerator'],
      serviceCities: ['Fort Lauderdale'],
      active: true,
    },
  });
  await prisma.pushSubscription.deleteMany({ where: { userId: { in: [IDS.customerA, IDS.customerB] } } });
}

async function login(email) {
  const session = await api('/auth/login', { body: { email, password: PW } });
  return session;
}

async function pushEntriesFor(bookingId, template) {
  const rows = await prisma.notificationOutbox.findMany({ where: { channel: 'push', template } });
  return rows.filter((row) => row.payload?.bookingId === bookingId);
}

async function subByEndpoint(endpoint) {
  return prisma.pushSubscription.findUnique({ where: { endpoint } });
}

function deliveriesTo(endpoint) {
  return deliveries.filter((d) => d.endpoint === endpoint);
}

async function createBooking(token) {
  return api('/bookings', {
    token,
    body: {
      customer: { name: 'Push Alpha', phone: '(954) 555-0132', email: EMAILS.a, address: '1200 Drill Way' },
      city: 'Fort Lauderdale',
      zip: '33301',
      appliance: 'Refrigerator',
      issue: 'Not cooling at all',
    },
  });
}

// ---------------------------------------------------------------------
// Phase 1 — VAPID configured: subscriptions, own-only rules, the full
// lifecycle fan-out, dead-subscription revocation, failure isolation.
// ---------------------------------------------------------------------
async function phaseOne() {
  const anonStatus = await api('/app/push/status', { method: 'GET' });
  check('status anonymous: 401', anonStatus.status, 401);
  const anonSub = await api('/app/push/subscribe', { body: { subscription: { endpoint: ENDPOINTS.a1, keys: KEYS } } });
  check('subscribe anonymous: 401', anonSub.status, 401);

  const sessionA = await login(EMAILS.a);
  check('customer A login: 200', sessionA.status, 200);
  const tokA = sessionA.json?.token;
  const sessionB = await login(EMAILS.b);
  const tokB = sessionB.json?.token;
  const sessionStaff = await login(EMAILS.staff);
  check('staff login: 200', sessionStaff.status, 200);
  const tokStaff = sessionStaff.json?.token;

  const status0 = await api('/app/push/status', { method: 'GET', token: tokA });
  check('status: 200', status0.status, 200);
  check('status: available true', status0.json?.data?.available, true);
  check('status: public key is the configured VAPID key', status0.json?.data?.publicKey, VAPID.publicKey);
  check('status: not subscribed yet', status0.json?.data?.subscribed, false);

  const sub1 = await api('/app/push/subscribe', { token: tokA, body: { subscription: { endpoint: ENDPOINTS.a1, keys: KEYS }, userAgent: 'drill-browser' } });
  check('subscribe device 1: 201', sub1.status, 201);
  check('subscribe device 1: subscribed flag', sub1.json?.data?.subscribed, true);
  const row1 = await subByEndpoint(ENDPOINTS.a1);
  check('row: stored for account A', row1?.userId, IDS.customerA);
  check('row: p256dh stored', row1?.p256dh, KEYS.p256dh);
  check('row: auth stored', row1?.auth, KEYS.auth);
  check('row: starts unrevoked', row1?.revokedAt, null);

  const sub2 = await api('/app/push/subscribe', { token: tokA, body: { subscription: { endpoint: ENDPOINTS.a2, keys: KEYS } } });
  check('subscribe device 2: 201', sub2.status, 201);
  const status2 = await api('/app/push/status', { method: 'GET', token: tokA });
  check('status: two device subscriptions', status2.json?.data?.subscriptions, 2);

  const resub = await api('/app/push/subscribe', { token: tokA, body: { subscription: { endpoint: ENDPOINTS.a1, keys: KEYS_ROTATED } } });
  check('re-subscribe same device: 200', resub.status, 200);
  const row1b = await subByEndpoint(ENDPOINTS.a1);
  check('re-subscribe: same row id', row1b?.id, row1?.id);
  check('re-subscribe: keys rotated', row1b?.p256dh, KEYS_ROTATED.p256dh);

  const subB = await api('/app/push/subscribe', { token: tokB, body: { subscription: { endpoint: ENDPOINTS.b1, keys: KEYS } } });
  check('bystander subscribe: 201', subB.status, 201);

  const badUnsub = await api('/app/push/unsubscribe', { token: tokB, body: { endpoint: ENDPOINTS.a1 } });
  check("unsubscribe another account's endpoint: 404", badUnsub.status, 404);
  const row1c = await subByEndpoint(ENDPOINTS.a1);
  check("other account's row still active", row1c?.revokedAt, null);

  const unsub2 = await api('/app/push/unsubscribe', { token: tokA, body: { endpoint: ENDPOINTS.a2 } });
  check('unsubscribe own device 2: 200', unsub2.status, 200);
  const row2 = await subByEndpoint(ENDPOINTS.a2);
  check('device 2 row revoked', row2?.revokedAt !== null, true);
  const statusAfterUnsub = await api('/app/push/status', { method: 'GET', token: tokA });
  check('status: one subscription left', statusAfterUnsub.json?.data?.subscriptions, 1);

  // --- Lifecycle: confirmed → assigned → completed, A only. ---
  const bookingRes = await createBooking(tokA);
  check('booking create: 201', bookingRes.status, 201);
  const booking = bookingRes.json?.data;
  check('booking carries a reference', typeof booking?.referenceCode, 'string');

  check('confirmation push queued for A device 1', await waitFor(async () => (await pushEntriesFor(booking.id, 'BOOKING_CONFIRMATION')).length === 1), true);
  const confirmEntries = await pushEntriesFor(booking.id, 'BOOKING_CONFIRMATION');
  check('confirmation push addressed to device 1', confirmEntries[0]?.to, ENDPOINTS.a1);
  check('confirmation payload title', confirmEntries[0]?.payload?.title, 'Booking confirmed');
  checkIncludes('confirmation payload body names the appliance', confirmEntries[0]?.payload?.body, 'Refrigerator');
  check('confirmation payload subscription id', confirmEntries[0]?.payload?.subscriptionId, row1?.id);
  checkIncludes('confirmation payload url opens tracking', confirmEntries[0]?.payload?.url, '/app?view=track&ref=');
  check('confirmation push delivered to device 1', await waitFor(() => deliveriesTo(ENDPOINTS.a1).some((d) => d.payload?.title === 'Booking confirmed')), true);
  check('delivered payload carries the booking reference', deliveriesTo(ENDPOINTS.a1).find((d) => d.payload?.title === 'Booking confirmed')?.payload?.referenceCode, booking.referenceCode);
  check('confirmation push marked SENT', await waitFor(async () => (await pushEntriesFor(booking.id, 'BOOKING_CONFIRMATION'))[0]?.status === 'SENT'), true);
  check('bystander received nothing', deliveriesTo(ENDPOINTS.b1).length, 0);

  const match = await api('/dispatch/match', { token: tokStaff, body: { bookingId: booking.id } });
  check('dispatch match: 200', match.status, 200);
  const approve = await api('/dispatch/approve', { token: tokStaff, body: { bookingId: booking.id, providerId: IDS.provider, approvedBy: 'Drill Setter' } });
  check('dispatch approve: 200', approve.status, 200);
  check('assigned push queued', await waitFor(async () => (await pushEntriesFor(booking.id, 'DISPATCH_APPROVED')).length === 1), true);
  check('assigned push delivered to device 1', await waitFor(() => deliveriesTo(ENDPOINTS.a1).some((d) => d.payload?.title === 'Technician assigned')), true);
  check('bystander still received nothing', deliveriesTo(ENDPOINTS.b1).length, 0);

  const complete = await api(`/bookings/${booking.id}/complete`, { token: tokStaff, body: { completedBy: 'Drill Setter' } });
  check('job complete: 200', complete.status, 200);
  check('completed push queued', await waitFor(async () => (await pushEntriesFor(booking.id, 'REVIEW_REQUEST')).length === 1), true);
  check('completed push delivered to device 1', await waitFor(() => deliveriesTo(ENDPOINTS.a1).some((d) => d.payload?.title === 'Job completed')), true);
  check('bystander never received anything', deliveriesTo(ENDPOINTS.b1).length, 0);

  // --- 410: the subscription is revoked; the booking flow is fine. ---
  const sub410 = await api('/app/push/subscribe', { token: tokA, body: { subscription: { endpoint: ENDPOINTS.a410, keys: KEYS } } });
  check('subscribe doomed device: 201', sub410.status, 201);
  const booking2Res = await createBooking(tokA);
  check('booking with doomed device: still 201', booking2Res.status, 201);
  const booking2 = booking2Res.json?.data;
  check('410 push attempted', await waitFor(() => deliveriesTo(ENDPOINTS.a410).length >= 1), true);
  check('410 subscription revoked at delivery', await waitFor(async () => (await subByEndpoint(ENDPOINTS.a410))?.revokedAt !== null), true);
  check('410 entry failed as SUBSCRIPTION_GONE', await waitFor(async () => {
    const entries = await pushEntriesFor(booking2.id, 'BOOKING_CONFIRMATION');
    const doomed = entries.find((e) => e.to === ENDPOINTS.a410);
    return doomed?.status === 'FAILED' && doomed?.reason === 'SUBSCRIPTION_GONE';
  }), true);
  check('healthy device still got booking 2', await waitFor(() => deliveriesTo(ENDPOINTS.a1).filter((d) => d.payload?.referenceCode === booking2.referenceCode).length >= 1), true);

  // --- 500: entry fails, subscription survives, flow unaffected. ---
  const sub500 = await api('/app/push/subscribe', { token: tokA, body: { subscription: { endpoint: ENDPOINTS.a500, keys: KEYS } } });
  check('subscribe failing device: 201', sub500.status, 201);
  const booking3Res = await createBooking(tokA);
  check('booking with failing device: still 201', booking3Res.status, 201);
  const booking3 = booking3Res.json?.data;
  check('500 entry marked FAILED', await waitFor(async () => {
    const entries = await pushEntriesFor(booking3.id, 'BOOKING_CONFIRMATION');
    return entries.find((e) => e.to === ENDPOINTS.a500)?.status === 'FAILED';
  }), true);
  const row500 = await subByEndpoint(ENDPOINTS.a500);
  check('500 subscription NOT revoked', row500?.revokedAt, null);
}

// ---------------------------------------------------------------------
// Phase 2 — VAPID unset: the feature reports itself OFF, honestly.
// ---------------------------------------------------------------------
async function phaseTwo() {
  const sessionA = await login(EMAILS.a);
  check('phase 2 login: 200', sessionA.status, 200);
  const tokA = sessionA.json?.token;
  const status = await api('/app/push/status', { method: 'GET', token: tokA });
  check('phase 2 status: 200', status.status, 200);
  check('phase 2 status: available false', status.json?.data?.available, false);
  check('phase 2 status: publicKey null', status.json?.data?.publicKey, null);
  const sub = await api('/app/push/subscribe', { token: tokA, body: { subscription: { endpoint: ENDPOINTS.a1, keys: KEYS } } });
  check('phase 2 subscribe: 503', sub.status, 503);
  check('phase 2 subscribe: available false', sub.json?.available, false);
}

// ---------------------------------------------------------------------
// Static checks — the /app panel ships hidden behind the status gate,
// and the service worker carries the push handlers at v4.
// ---------------------------------------------------------------------
function staticChecks() {
  const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));
  const appHtml = readFileSync(`${webRoot}app/index.html`, 'utf8');
  const sw = readFileSync(`${webRoot}sw.js`, 'utf8');
  check('app page: push panel ships hidden', appHtml.includes('id="pushPanel" style="display:none;'), true);
  check('app page: panel label present', appHtml.includes('Booking updates on this device'), true);
  check('app page: status gate consulted', appHtml.includes("/app/push/status"), true);
  check('app page: unsupported browsers hide the toggle (PushManager check)', appHtml.includes("'PushManager' in window"), true);
  check('app page: permission requested before subscribing', appHtml.includes('Notification.requestPermission()'), true);
  check('app page: subscribe posts the browser subscription', appHtml.includes("/app/push/subscribe"), true);
  check('sw: cache version bumped to v4', sw.includes("const CACHE_VERSION = 'v4'"), true);
  check('sw: push handler present', sw.includes("addEventListener('push'"), true);
  check('sw: notificationclick handler present', sw.includes("addEventListener('notificationclick'"), true);
  check('sw: click opens the payload url', sw.includes('event.notification.data.url'), true);
}

async function main() {
  await startStub();
  await seed();
  await bootServer({ withVapid: true });
  await phaseOne();
  await stopServer();
  await bootServer({ withVapid: false });
  await phaseTwo();
  await stopServer();
  staticChecks();
  if (stub) stub.close();
  await prisma.$disconnect();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('HARNESS ERROR', error);
  await stopServer().catch(() => {});
  if (stub) stub.close();
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

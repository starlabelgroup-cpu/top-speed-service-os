/**
 * Owner-only booking delete — unified intake delete (2026-11-19).
 * POST /admin/bookings/delete { reference } has existed since the
 * Book OS Remove buttons, but it removed only the ServiceRequest
 * half of an intake. A lead-type public intake lives in TWO tables:
 * the Connection (its own TS- reference) and a lead booking minted
 * beside it (a DIFFERENT TS- reference, linked by the BOOKING_CREATED
 * history entry). This suite drills the unified behavior:
 *
 *  - Same gate as always: anon → 401, DISPATCHER → 403, COMPANY_ADMIN
 *    → 403, owner → 200; missing reference → 400, unknown → 404.
 *  - Deleting by the BOOKING reference removes the connection half,
 *    the lead customer and both references' outbox entries too.
 *  - Deleting by the CONNECTION reference on the bookings route
 *    resolves and removes the whole intake as well.
 *  - Single-side records (a Speedy/web-form booking with no
 *    connection; a provider application with no booking) delete
 *    cleanly from EITHER route — the absent side reports 0, never
 *    an error — and re-deleting is a 404 on both routes.
 *
 * Records are created through the REAL public intakes (POST
 * /connections lead types + POST /speedy/book). Runs against a LOCAL
 * test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/admin-bookings-delete.test.mjs
 * Exit code 0 = every check passed.
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

const PORT = Number(process.env.TEST_PORT || 4481);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  owner: '90000000-0000-4000-8000-0000000000c1',
  manager: '90000000-0000-4000-8000-0000000000c2',
  setter: '90000000-0000-4000-8000-0000000000c3',
};
const EMAILS = {
  owner: 'bd-owner@test.local',
  manager: 'bd-manager@test.local',
  setter: 'bd-setter@test.local',
};

const prisma = new PrismaClient();
let server = null;
let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function login(email) {
  const res = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return res.json?.token || null;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
const bookingCount = () => prisma.serviceRequest.count();
const connectionCount = () => prisma.connection.count();
const outboxReferencing = async (reference) =>
  (await prisma.notificationOutbox.findMany()).filter((e) => JSON.stringify(e).includes(reference)).length;
const leadBookingOf = async (connRef) => {
  const rows = await prisma.serviceRequest.findMany();
  return rows.find((r) => (Array.isArray(r.history) ? r.history : []).some(
    (h) => (h?.type || h?.event) === 'BOOKING_CREATED' && h?.connectionReference === connRef,
  )) || null;
};

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'bd-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    [IDS.owner, EMAILS.owner, ['COMPANY_OWNER']],
    [IDS.manager, EMAILS.manager, ['COMPANY_ADMIN']],
    [IDS.setter, EMAILS.setter, ['DISPATCHER']],
  ];
  for (const [id, email, roles] of users) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash },
      create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }
}

async function cleanup() {
  try {
    await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

function startServer() {
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'admin-bookings-delete-test-secret',
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
  await seed();
  server = startServer();
  await waitForServer();

  // ---- Public + gated route sanity (shared-prefix trap check) ----
  check('health 200', (await api('/health')).status, 200);
  check('payments/status 200', (await api('/payments/status')).status, 200);

  const ownerToken = await login(EMAILS.owner);
  const managerToken = await login(EMAILS.manager);
  const setterToken = await login(EMAILS.setter);
  checkTrue('owner login returns a token', ownerToken);
  checkTrue('manager login returns a token', managerToken);
  checkTrue('setter login returns a token', setterToken);

  // ---- Dual intake #1: SERVICE_REQUEST connection + lead booking ----
  const dual1 = await api('/connections', {
    method: 'POST',
    body: {
      type: 'SERVICE_REQUEST', name: 'Dual Fake Two', email: 'dual2@test.local',
      phone: '9545550188', source: 'flagship-service', message: 'Fridge warm — spam service request',
    },
  });
  check('dual #1 connection created → 201', dual1.status, 201);
  const refDual1Conn = dual1.json?.data?.reference || '';
  await settle();
  const dual1Booking = await leadBookingOf(refDual1Conn);
  checkTrue('dual #1 minted a lead booking', dual1Booking);
  const refDual1Booking = dual1Booking?.referenceCode || '';
  checkTrue('dual #1 halves carry different references', Boolean(refDual1Booking) && refDual1Booking !== refDual1Conn);
  const bookingsBaseline = await bookingCount();
  const connectionsBaseline = await connectionCount();

  // ---- The gate: nobody but the owner can delete ----
  const anon = await api('/admin/bookings/delete', { method: 'POST', body: { reference: refDual1Booking } });
  check('anon delete → 401', anon.status, 401);
  const setterTry = await api('/admin/bookings/delete', { token: setterToken, method: 'POST', body: { reference: refDual1Booking } });
  check('dispatcher delete → 403', setterTry.status, 403);
  const managerTry = await api('/admin/bookings/delete', { token: managerToken, method: 'POST', body: { reference: refDual1Booking } });
  check('manager (COMPANY_ADMIN) delete → 403', managerTry.status, 403);
  checkTrue('booking survives the unauthorized attempts', await prisma.serviceRequest.findUnique({ where: { referenceCode: refDual1Booking } }));
  checkTrue('connection survives the unauthorized attempts', await prisma.connection.findUnique({ where: { reference: refDual1Conn } }));

  // ---- Owner-side request discipline ----
  const missing = await api('/admin/bookings/delete', { token: ownerToken, method: 'POST', body: {} });
  check('owner, missing reference → 400', missing.status, 400);
  check('missing reference error text', missing.json?.error, 'A booking reference is required');
  const unknown = await api('/admin/bookings/delete', { token: ownerToken, method: 'POST', body: { reference: 'TS-ZZZZZ9' } });
  check('owner, unknown reference → 404', unknown.status, 404);
  check('unknown reference error text', unknown.json?.error, 'No booking found with that reference');

  // ---- Delete dual #1 by the BOOKING reference ----
  const del1 = await api('/admin/bookings/delete', { token: ownerToken, method: 'POST', body: { reference: refDual1Booking } });
  check('owner delete by booking reference → 200', del1.status, 200);
  check('del1 ok flag', del1.json?.ok, true);
  check('del1 deleted.reference echoes the booking reference', del1.json?.deleted?.reference, refDual1Booking);
  check('del1 deleted.bookings is 1', del1.json?.deleted?.bookings, 1);
  check('del1 deleted.connections is 1', del1.json?.deleted?.connections, 1);
  check('del1 deleted.customer is 1', del1.json?.deleted?.customer, 1);
  check('del1 remainingBookings dropped by one', del1.json?.remainingBookings, bookingsBaseline - 1);
  await settle();
  check('dual #1 booking gone from the database', await prisma.serviceRequest.findUnique({ where: { referenceCode: refDual1Booking } }), null);
  check('dual #1 connection gone from the database', await prisma.connection.findUnique({ where: { reference: refDual1Conn } }), null);
  check('dual #1 lead customer gone from the database', await prisma.customer.findUnique({ where: { id: dual1Booking.customerId } }), null);
  check('outbox entries for the booking reference are gone', await outboxReferencing(refDual1Booking), 0);
  check('outbox entries for the connection reference are gone', await outboxReferencing(refDual1Conn), 0);
  const queue1 = await api('/bookos/setter-queue', { token: setterToken });
  checkTrue('setter queue no longer shows dual #1', !(queue1.json?.data?.queue || []).some((q) => q.referenceCode === refDual1Booking));
  const again1 = await api('/admin/bookings/delete', { token: ownerToken, method: 'POST', body: { reference: refDual1Booking } });
  check('re-delete dual #1 (bookings route) → 404', again1.status, 404);
  const again1c = await api('/admin/connections/delete', { token: ownerToken, method: 'POST', body: { reference: refDual1Conn } });
  check('re-delete dual #1 (connections route) → 404', again1c.status, 404);

  // ---- Dual intake #2: deleted by the CONNECTION reference on the bookings route ----
  const dual2 = await api('/connections', {
    method: 'POST',
    body: {
      type: 'COMMERCIAL_ACCOUNT_REQUEST', name: 'Dual Fake Three', email: 'dual3@test.local',
      phone: '9545550199', source: 'flagship-commercial', message: 'Open a commercial account — spam',
    },
  });
  check('dual #2 connection created → 201', dual2.status, 201);
  const refDual2Conn = dual2.json?.data?.reference || '';
  await settle();
  const dual2Booking = await leadBookingOf(refDual2Conn);
  checkTrue('dual #2 minted a lead booking', dual2Booking);
  const del2 = await api('/admin/bookings/delete', { token: ownerToken, method: 'POST', body: { reference: refDual2Conn } });
  check('owner delete by connection reference (bookings route) → 200', del2.status, 200);
  check('del2 deleted.bookings is 1', del2.json?.deleted?.bookings, 1);
  check('del2 deleted.connections is 1', del2.json?.deleted?.connections, 1);
  await settle();
  check('dual #2 connection gone from the database', await prisma.connection.findUnique({ where: { reference: refDual2Conn } }), null);
  check('dual #2 lead booking gone from the database', await prisma.serviceRequest.findUnique({ where: { referenceCode: dual2Booking.referenceCode } }), null);
  check('booking count back to baseline', await bookingCount(), bookingsBaseline - 1);
  check('connection count back to baseline', await connectionCount(), connectionsBaseline - 1);

  // ---- Single-side booking (Speedy/web-form): no connection exists ----
  const soloBody = {
    customer: { name: 'Solo Tester', phone: '9545550123', email: 'solo@test.local' },
    city: 'Fort Lauderdale', zip: '33311', appliance: 'Refrigerator',
    issue: 'Not cooling at all', source: 'WEB_FORM',
  };
  const solo1 = await api('/speedy/book', { method: 'POST', body: soloBody });
  check('solo booking #1 created → 201', solo1.status, 201);
  const refSolo1 = solo1.json?.data?.referenceCode || '';
  checkTrue('solo booking #1 carries a TS- reference', /^TS-/.test(refSolo1));
  await settle();
  check('solo booking #1 has NO connection row', await prisma.connection.findUnique({ where: { reference: refSolo1 } }), null);
  const solo1Row = await prisma.serviceRequest.findUnique({ where: { referenceCode: refSolo1 } });
  const solo1Created = (Array.isArray(solo1Row?.history) ? solo1Row.history : []).find((h) => (h?.type || h?.event) === 'BOOKING_CREATED');
  checkTrue('solo booking #1 has no lead link', !solo1Created?.connectionReference);
  const delSolo1 = await api('/admin/bookings/delete', { token: ownerToken, method: 'POST', body: { reference: refSolo1 } });
  check('owner delete solo booking (bookings route) → 200', delSolo1.status, 200);
  check('solo1 deleted.bookings is 1', delSolo1.json?.deleted?.bookings, 1);
  check('solo1 deleted.connections is 0', delSolo1.json?.deleted?.connections, 0);
  check('solo booking #1 gone from the database', await prisma.serviceRequest.findUnique({ where: { referenceCode: refSolo1 } }), null);

  const solo2 = await api('/speedy/book', { method: 'POST', body: { ...soloBody, customer: { ...soloBody.customer, name: 'Solo Tester Two', phone: '9545550124' } } });
  check('solo booking #2 created → 201', solo2.status, 201);
  const refSolo2 = solo2.json?.data?.referenceCode || '';
  await settle();
  const delSolo2 = await api('/admin/connections/delete', { token: ownerToken, method: 'POST', body: { reference: refSolo2 } });
  check('owner delete solo booking (connections route) → 200', delSolo2.status, 200);
  check('solo2 deleted.connections is 0', delSolo2.json?.deleted?.connections, 0);
  check('solo2 deleted.bookings is 1', delSolo2.json?.deleted?.bookings, 1);
  check('solo booking #2 gone from the database', await prisma.serviceRequest.findUnique({ where: { referenceCode: refSolo2 } }), null);

  // ---- Single-side connection (provider application): no booking exists ----
  const appOnly = await api('/connections', {
    method: 'POST',
    body: {
      type: 'PROVIDER_APPLICATION', name: 'App Only', email: 'apponly@test.local',
      phone: '6045550143', source: 'network-site-provider-join', message: 'Spam application — no booking half',
    },
  });
  check('application-only connection created → 201', appOnly.status, 201);
  const refAppOnly = appOnly.json?.data?.reference || '';
  await settle();
  check('application-only intake minted NO lead booking', await leadBookingOf(refAppOnly), null);
  const delApp = await api('/admin/bookings/delete', { token: ownerToken, method: 'POST', body: { reference: refAppOnly } });
  check('owner delete application-only (bookings route) → 200', delApp.status, 200);
  check('app-only deleted.bookings is 0', delApp.json?.deleted?.bookings, 0);
  check('app-only deleted.connections is 1', delApp.json?.deleted?.connections, 1);
  check('application-only connection gone from the database', await prisma.connection.findUnique({ where: { reference: refAppOnly } }), null);
  const againApp = await api('/admin/connections/delete', { token: ownerToken, method: 'POST', body: { reference: refAppOnly } });
  check('re-delete application-only (connections route) → 404', againApp.status, 404);

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed;
}

main()
  .then(async (failuresCount) => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    process.exit(failuresCount === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect();
    process.exit(1);
  });

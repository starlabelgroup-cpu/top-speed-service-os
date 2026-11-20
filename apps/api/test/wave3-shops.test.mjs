/**
 * Wave 3 shops — verification harness (2026-11-20, recommendations
 * C20 + C21, both approved by Ramone with the full 55-item list).
 *
 * C20 — Cleanout Vents recurring plans + photo reports:
 *   - The flagship Cleanout Vents page's plan form posts type
 *     VENT_PLAN_REQUEST to the public intake (POST /connections). The
 *     record must land with its reference, be visible to staff in
 *     GET /connections, and mint NO setter-queue booking (vent plans
 *     are quoted by the office, never dispatched like repairs).
 *   - The per-visit photo report: a job's JOB_PHOTO_ADDED history
 *     (minus JOB_PHOTO_REMOVED) is exposed to the customer as
 *     photoReport on the guest track (reference + matching phone),
 *     the signed-in /tracking/mine view, and the by-token track —
 *     and to nobody else (wrong phone → 403, no token → 401).
 *
 * C21 — CocoCane online ordering + wholesale desk:
 *   - The flagship CocoCane page posts COCOCANE_ORDER (order-ahead
 *     pickup at the locked price list) and COCOCANE_WHOLESALE
 *     (quantity / deposit / delivery date) to the same intake. Both
 *     land as staff-visible records with references a buyer can
 *     quote; neither mints a booking. The intake shield still
 *     applies: a filled honeypot returns the success shape but
 *     persists nothing, and an impossible phone is a 400.
 *
 * Runs against a LOCAL test database only. Usage:
 *   set DATABASE_URL to a local TEST database connection string
 *   node test/wave3-shops.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const DB_URL = process.env['DATABASE_' + 'URL'];
if (!DB_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env['DATABASE_' + 'URL_UNPOOLED'] ||= DB_URL;

const PORT = Number(process.env.TEST_PORT || 4591);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PW = 'drill-pass-12345';

const IDS = {
  staff: '30000000-0000-4000-8000-0000000000a1',
  customerUser: '30000000-0000-4000-8000-0000000000a2',
  customer: '30000000-0000-4000-8000-0000000000a3',
  ventBooking: '30000000-0000-4000-8000-0000000000a4',
  plainBooking: '30000000-0000-4000-8000-0000000000a5',
  trackToken: '30000000-0000-4000-8000-0000000000a6',
};
const PHONE = '9545550142';
const TRACK_RAW = 'drill-track-token-vent20';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP======';

const prisma = new PrismaClient();
let server = null;
let failures = 0;
let checks = 0;

function check(label, actual, expected) {
  checks += 1;
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

async function api(path, { method = 'GET', body, token } = {}) {
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

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
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
  childEnv['JWT_' + 'SECRET'] = 'wave3-shops-drill-secret';
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
  const passwordHash = await hashPassword(PW);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.user.upsert({
    where: { id: IDS.staff },
    update: { passwordHash },
    create: { id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: 'setter@test.local', firstName: 'Drill', lastName: 'Setter', passwordHash, roles: ['DISPATCHER'], active: true },
  });
  await prisma.user.upsert({
    where: { id: IDS.customerUser },
    update: { passwordHash },
    create: { id: IDS.customerUser, companyId: PLATFORM_COMPANY_ID, email: 'vent-customer@test.local', firstName: 'Vent', lastName: 'Customer', phone: PHONE, passwordHash, roles: ['CUSTOMER'], active: true },
  });
  await prisma.customer.upsert({
    where: { id: IDS.customer },
    update: {},
    create: { id: IDS.customer, companyId: PLATFORM_COMPANY_ID, userId: IDS.customerUser, name: 'Vent Customer', phone: PHONE, email: 'vent-customer@test.local', city: 'Fort Lauderdale', zip: '33301', source: 'DRILL' },
  });
  const at = new Date().toISOString();
  const history = [
    { type: 'BOOKING_CREATED', actor: 'office', at },
    { type: 'JOB_PHOTO_ADDED', actor: 'tech@test.local', at, photo: { id: 'ph-b1', category: 'BEFORE', dataUrl: JPEG, caption: 'Vent line before cleaning', at } },
    { type: 'JOB_PHOTO_ADDED', actor: 'tech@test.local', at, photo: { id: 'ph-d1', category: 'DURING', dataUrl: JPEG, caption: 'Mid-clean — removed later', at } },
    { type: 'JOB_PHOTO_REMOVED', actor: 'tech@test.local', at, photoId: 'ph-d1' },
    { type: 'JOB_PHOTO_ADDED', actor: 'tech@test.local', at, photo: { id: 'ph-a1', category: 'AFTER', dataUrl: JPEG, caption: 'Vent line after cleaning', at } },
  ];
  await prisma.serviceRequest.upsert({
    where: { id: IDS.ventBooking },
    update: { history },
    create: {
      id: IDS.ventBooking, companyId: PLATFORM_COMPANY_ID, customerId: IDS.customer,
      city: 'Fort Lauderdale', zip: '33301', appliance: 'Dryer Vent Cleaning',
      issue: 'Annual Vent Care Plan visit', referenceCode: 'TS-VENT20', source: 'OFFICE',
      status: 'COMPLETED', completedAt: new Date(), history,
    },
  });
  await prisma.serviceRequest.upsert({
    where: { id: IDS.plainBooking },
    update: { history: [] },
    create: {
      id: IDS.plainBooking, companyId: PLATFORM_COMPANY_ID, customerId: IDS.customer,
      city: 'Fort Lauderdale', zip: '33301', appliance: 'Dryer',
      issue: 'Dryer not heating', referenceCode: 'TS-PLAIN20', source: 'WEB_FORM',
      status: 'COMPLETED', completedAt: new Date(), history: [],
    },
  });
  const tokenHash = createHash('sha256').update(TRACK_RAW).digest('hex');
  await prisma.trackingToken.upsert({
    where: { id: IDS.trackToken },
    update: { tokenHash, expiresAt: new Date(Date.now() + 3600_000), revokedAt: null },
    create: { id: IDS.trackToken, tokenHash, bookingId: IDS.ventBooking, issuedBy: 'drill', expiresAt: new Date(Date.now() + 3600_000) },
  });
  await prisma.connection.deleteMany({ where: { phone: { in: [PHONE, '9545550199'] } } });
}

async function main() {
  await seed();
  await bootServer();
  try {
    // ---------------- Intake: the three new record types ----------------
    const bookingsBefore = await prisma.serviceRequest.count();

    const vent = await api('/connections', { method: 'POST', body: {
      type: 'VENT_PLAN_REQUEST', name: 'Harbor HOA Manager', phone: PHONE,
      email: 'manager@harbor-hoa.test', source: 'cleanout-vents-site', companyWebsite: '',
      message: 'Vent Care Plan request — Harbor HOA (HOA / condo association, Fort Lauderdale). Units with dryers: 120. Preferred start: Next 30–60 days. Every visit includes a before/after photo report on the job record.',
    } });
    check('C20 vent plan: status', vent.status, 201);
    check('C20 vent plan: reference shape', /^TS-[A-Z0-9]+$/.test(vent.json?.data?.reference || ''), true);
    check('C20 vent plan: type echoed', vent.json?.data?.type, 'VENT_PLAN_REQUEST');

    const order = await api('/connections', { method: 'POST', body: {
      type: 'COCOCANE_ORDER', name: 'Pickup Pat', phone: PHONE, source: 'cococane-site', companyWebsite: '',
      message: 'CocoCane order-ahead pickup. Items:\n2 x Bottled Coconut Water — Gallon @ $30 = $60\n1 x Sugarcane Sticks (per bundle) @ $7 = $7\nTotal: $67\nPickup: 2026-11-21 · Morning',
    } });
    check('C21 order: status', order.status, 201);
    check('C21 order: reference shape', /^TS-[A-Z0-9]+$/.test(order.json?.data?.reference || ''), true);

    const wholesale = await api('/connections', { method: 'POST', body: {
      type: 'COCOCANE_WHOLESALE', name: 'Bulk Buyer', phone: PHONE, email: 'bulk@buyer.test', source: 'cococane-site', companyWebsite: '',
      message: 'CocoCane WHOLESALE request. Product: Whole coconuts (bulk). Quantity: 300\nDeposit the buyer can place: $100\nDelivery date needed: 2026-11-28\nDelivery area: Fort Lauderdale',
    } });
    check('C21 wholesale: status', wholesale.status, 201);
    check('C21 wholesale: reference shape', /^TS-[A-Z0-9]+$/.test(wholesale.json?.data?.reference || ''), true);

    // Shield behavior is unchanged for the new types.
    const honey = await api('/connections', { method: 'POST', body: {
      type: 'COCOCANE_ORDER', name: 'Bot Honeypot', phone: '9545550199', source: 'cococane-site',
      companyWebsite: 'http://spam.example', message: 'filled by a bot',
    } });
    check('shield: honeypot gets success shape', honey.status, 201);
    const badPhone = await api('/connections', { method: 'POST', body: {
      type: 'VENT_PLAN_REQUEST', name: 'Bad Phone', phone: '123-456-7890', source: 'cleanout-vents-site', message: 'x',
    } });
    check('shield: impossible phone refused', badPhone.status, 400);
    check('shield: impossible phone code', badPhone.json?.code, 'INVALID_PHONE');

    // Staff visibility + no minted bookings.
    const staffLogin = await api('/auth/login', { method: 'POST', body: { email: 'setter@test.local', password: PW } });
    check('staff login: status', staffLogin.status, 200);
    const staffTok = staffLogin.json?.token;
    const list = await api('/connections', { token: staffTok });
    check('staff list: status', list.status, 200);
    const rows = list.json?.data || [];
    const ventRow = rows.find((r) => r.type === 'VENT_PLAN_REQUEST' && r.name === 'Harbor HOA Manager');
    check('C20 vent plan: staff-visible', Boolean(ventRow), true);
    check('C20 vent plan: units in message', (ventRow?.message || '').includes('Units with dryers: 120'), true);
    check('C21 order: staff-visible', rows.some((r) => r.type === 'COCOCANE_ORDER' && r.name === 'Pickup Pat'), true);
    check('C21 wholesale: staff-visible', rows.some((r) => r.type === 'COCOCANE_WHOLESALE' && (r.message || '').includes('Quantity: 300')), true);
    check('shield: honeypot persisted nothing', rows.some((r) => r.name === 'Bot Honeypot'), false);
    const anon = await api('/connections');
    check('staff list: anon refused', anon.status, 401);
    const bookingsAfter = await prisma.serviceRequest.count();
    check('intake mints no bookings for shop/plan types', bookingsAfter, bookingsBefore);

    // ---------------- C20 photo report ----------------
    const guest = await api(`/bookings/track/TS-VENT20?phone=${PHONE}`);
    check('photo report guest: status', guest.status, 200);
    check('photo report guest: total excludes removed', guest.json?.data?.photoReport?.total, 2);
    check('photo report guest: before count', guest.json?.data?.photoReport?.before?.length, 1);
    check('photo report guest: before caption', guest.json?.data?.photoReport?.before?.[0]?.caption, 'Vent line before cleaning');
    check('photo report guest: after count', guest.json?.data?.photoReport?.after?.length, 1);
    check('photo report guest: during empty after removal', guest.json?.data?.photoReport?.during?.length, 0);

    const wrongPhone = await api('/bookings/track/TS-VENT20?phone=9545559999');
    check('photo report guest: wrong phone refused', wrongPhone.status, 403);
    check('photo report guest: wrong phone leaks nothing', wrongPhone.json?.data?.photoReport ?? null, null);
    const unknown = await api(`/bookings/track/TS-NOPE99?phone=${PHONE}`);
    check('photo report guest: unknown ref', unknown.status, 404);

    const custLogin = await api('/auth/login', { method: 'POST', body: { email: 'vent-customer@test.local', password: PW } });
    check('customer login: status', custLogin.status, 200);
    const mine = await api('/tracking/mine', { token: custLogin.json?.token });
    check('photo report mine: status', mine.status, 200);
    const ventJob = (mine.json?.data || []).find((j) => j.reference === 'TS-VENT20');
    const plainJob = (mine.json?.data || []).find((j) => j.reference === 'TS-PLAIN20');
    check('photo report mine: vent job total', ventJob?.photoReport?.total, 2);
    check('photo report mine: photoless job is null', plainJob?.photoReport ?? null, null);
    const mineAnon = await api('/tracking/mine');
    check('photo report mine: anon refused', mineAnon.status, 401);

    const byToken = await api(`/tracking/by-token/${TRACK_RAW}`);
    check('photo report by-token: status', byToken.status, 200);
    check('photo report by-token: total', byToken.json?.data?.photoReport?.total, 2);
  } finally {
    await stopServer();
    await prisma.$disconnect();
  }
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await stopServer().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

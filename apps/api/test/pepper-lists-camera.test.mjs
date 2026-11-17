/**
 * Pepper Lists Camera Platform — verification harness (2026-11-17).
 *
 * Exercises the camera build's API surface end to end over HTTP:
 *  - POST /pepper-lists/listing-draft: the Speedy listing draft. With
 *    no OpenAI key in the local drill env the route must answer the
 *    HONEST 503 (fill it in by hand; posting works the same) — the
 *    manual path is the fallback, never a fake draft.
 *  - POST /pepper-lists/listings: the seller's CONFIRMED listing.
 *    Must land as a PEPPER_LISTS_SELL connection record and must NOT
 *    create a dispatch booking (ServiceRequest count unchanged),
 *    while a SCAN_SEND submission in the same run DOES create one —
 *    the contrast proves a sale never enters the setter queue.
 *  - Validation: price is required (the seller's own number — the AI
 *    draft never carries one), listings take photos only, category
 *    and condition come from the fixed enums, anonymous is refused.
 *  - Staff can open the confirmed listing's photo through the
 *    existing submissions media route.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... TEST_PORT=4431 node test/pepper-lists-camera.test.mjs
 * The harness seeds its own users, boots the real API on TEST_PORT
 * (default 4431), and cleans up. Exit code 0 = every check passed.
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

const PORT = Number(process.env.TEST_PORT || 4431);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const PHONE = '9545550199';

// A real 1x1 JPEG (magic bytes FF D8 FF) — passes the magic-byte gate.
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==';

const IDS = {
  seller: '20000000-0000-4000-8000-0000000000d1',
  staff: '20000000-0000-4000-8000-0000000000d2',
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;

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
  try { json = await res.json(); } catch { /* no body */ }
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
    { id: IDS.seller, email: 'cam-seller@test.local', roles: ['CUSTOMER'] },
    { id: IDS.staff, email: 'cam-staff@test.local', roles: ['COMPANY_ADMIN'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash, phone: PHONE, roles: u.roles, active: true },
    });
  }
}

async function cleanup() {
  try {
    await prisma.connection.deleteMany({ where: { phone: PHONE } });
    await prisma.serviceRequest.deleteMany({ where: { customer: { phone: PHONE } } }).catch(() => {});
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

async function main() {
  await cleanup();
  await seed();
  const childEnv = { ...process.env, PORT: String(PORT), JWT_SECRET: 'plcam-test-secret' };
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.OPENAI_API_KEY_V2;
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  // ── Auth gates ────────────────────────────────────────────────
  check('listings unauthenticated', (await api('/pepper-lists/listings', { method: 'POST', body: {} })).status, 401);
  check('listing-draft unauthenticated', (await api('/pepper-lists/listing-draft', { method: 'POST', body: {} })).status, 401);

  const seller = await login('cam-seller@test.local');
  const staff = await login('cam-staff@test.local');

  // ── Listing draft: honest fallback with no AI key locally ─────
  const draft = await api('/pepper-lists/listing-draft', {
    token: seller, method: 'POST',
    body: { imageDataUrl: `data:image/jpeg;base64,${JPEG_B64}` },
  });
  check('listing-draft without AI key is honest 503', draft.status, 503);
  checkTrue('503 copy points at the manual path', String(draft.json?.error || '').includes('by hand'));

  // ── Listing validation ────────────────────────────────────────
  const baseListing = {
    title: 'Box of fresh coconuts',
    description: 'Picked this week, Fort Lauderdale pickup.',
    category: 'Produce & fruit',
    condition: 'New',
    priceCents: 2500,
    phone: PHONE,
    media: [{ kind: 'photo', mime: 'image/jpeg', dataBase64: JPEG_B64 }],
  };
  const noPrice = { ...baseListing };
  delete noPrice.priceCents;
  check('listing without seller price refused', (await api('/pepper-lists/listings', { token: seller, method: 'POST', body: noPrice })).status, 400);
  check('listing with video media refused', (await api('/pepper-lists/listings', {
    token: seller, method: 'POST',
    body: { ...baseListing, media: [{ kind: 'video', mime: 'video/webm', dataBase64: JPEG_B64 }] },
  })).status, 400);
  check('listing with invented category refused', (await api('/pepper-lists/listings', {
    token: seller, method: 'POST', body: { ...baseListing, category: 'Yachts' },
  })).status, 400);

  // ── Confirmed listing: records, never books ───────────────────
  const bookingsBefore = await prisma.serviceRequest.count({ where: { companyId: PLATFORM_COMPANY_ID } });
  const created = await api('/pepper-lists/listings', { token: seller, method: 'POST', body: baseListing });
  check('confirmed listing 201', created.status, 201);
  checkTrue('listing returns a reference', typeof created.json?.data?.reference === 'string' && created.json.data.reference.length > 0);
  check('listing bookingReference is null', created.json?.data?.bookingReference, null);
  check('listing mediaCount', created.json?.data?.mediaCount, 1);

  const record = await prisma.connection.findFirst({ where: { reference: created.json.data.reference } });
  checkTrue('connection record persisted', Boolean(record));
  check('connection type is PEPPER_LISTS_SELL', record?.type, 'PEPPER_LISTS_SELL');
  checkTrue('record carries the title', String(record?.message || '').includes('Listing title: Box of fresh coconuts'));
  checkTrue('record carries the seller-set price', String(record?.message || '').includes('Price: $25.00 (set by the seller)'));

  const bookingsAfterListing = await prisma.serviceRequest.count({ where: { companyId: PLATFORM_COMPANY_ID } });
  check('listing created NO dispatch booking', bookingsAfterListing, bookingsBefore);

  // ── Staff can open the listing photo ──────────────────────────
  const media = await api(`/pepper-lists/submissions/${created.json.data.reference}/media`, { token: staff });
  check('staff media read 200', media.status, 200);
  check('staff sees the one photo', media.json?.data?.length, 1);

  // ── Scan & Send regression: still books into the setter queue ─
  const scan = await api('/pepper-lists/submissions', {
    token: seller, method: 'POST',
    body: {
      lane: 'SCAN_SEND', appliance: 'Refrigerator', issue: 'Warm on top, fan is loud', phone: PHONE,
      media: [{ kind: 'photo', mime: 'image/jpeg', dataBase64: JPEG_B64 }],
    },
  });
  check('scan & send 201', scan.status, 201);
  checkTrue('scan & send returns a booking reference', typeof scan.json?.data?.bookingReference === 'string' && scan.json.data.bookingReference.length > 0);
  const bookingsAfterScan = await prisma.serviceRequest.count({ where: { companyId: PLATFORM_COMPANY_ID } });
  check('scan & send DID create a dispatch booking', bookingsAfterScan, bookingsAfterListing + 1);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
}

main()
  .catch((error) => { console.error(error); failures += 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await cleanup().catch(() => {});
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  });

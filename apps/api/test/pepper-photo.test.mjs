/**
 * Pepper photo channel — verification harness (camera upgrade, 2026-11-20).
 *
 * Exercises POST /api/v1/pepper/photo (routes/pepperConsole.js +
 * services/pepperChat.js pepperPhoto) end to end over HTTP, plus the
 * additive plate `draft` envelope on both plate-read routes:
 *  - the staff gate, identical to /pepper/chat: anonymous 401,
 *    customer 403;
 *  - provider NOT configured → the honest 503 (server A, no key);
 *  - provider configured via a stub Responses server (server B):
 *    staff photo → 200 with the natural-language read, the structured
 *    plate extraction mapped to camelCase (applianceType), the DRAFT
 *    status, answeredBy 'ai-vision', provider 'openai' — Pepper chat's
 *    own provider/model path (OPENAI_API_BASE + Responses API),
 *    extended with image input;
 *  - magic-byte gate: text bytes labeled as a JPEG → 400; JPEG bytes
 *    labeled PNG → 400; a missing photo → 400;
 *  - NO RECORD MUTATION: ServiceRequest / Connection / PepperReport
 *    counts are byte-identical before and after a successful photo
 *    read — the endpoint is a draft-only read, it files nothing;
 *  - provider DOWN (server C, dead base URL) → honest 502;
 *  - plate-read regression with the new envelope: POST
 *    /pepper-lists/plate-read returns the original `plate` shape AND
 *    the additive `draft` (camelCase + status DRAFT + confidence).
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... TEST_PORT=4531 node test/pepper-photo.test.mjs
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

const PORT_A = Number(process.env.TEST_PORT || 4531);
const PORT_B = PORT_A + 1;
const PORT_C = PORT_A + 2;
const STUB_PORT = PORT_A + 3;
const PASSWORD = 'test-pass-1234';

const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==';
const JPEG_URL = `data:image/jpeg;base64,${JPEG_B64}`;
const TEXT_B64 = Buffer.from('this is not an image at all').toString('base64');

const IDS = {
  staff: '60000000-0000-4000-8000-0000000000a1',
  customer: '60000000-0000-4000-8000-0000000000a2',
};

const prisma = new PrismaClient();
let failures = 0;
const servers = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

function api(base, path, { token, method = 'GET', body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  });
}

async function login(base, email) {
  const { status, json } = await api(base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
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
    { id: IDS.staff, email: 'photo-staff@test.local', roles: ['COMPANY_ADMIN'] },
    { id: IDS.customer, email: 'photo-customer@test.local', roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash, phone: '9545550198', roles: u.roles, active: true },
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

async function boot(port, extraEnv) {
  const env = { ...process.env, PORT: String(port), JWT_SECRET: 'pepper-photo-test-secret', ...extraEnv };
  if (!extraEnv || !('OPENAI_API_KEY' in extraEnv)) delete env.OPENAI_API_KEY;
  if (!extraEnv || !('OPENAI_API_KEY_V2' in extraEnv)) delete env.OPENAI_API_KEY_V2;
  if (!extraEnv || !('OPENAI_API_BASE' in extraEnv)) delete env.OPENAI_API_BASE;
  const child = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[api:${port}] ${d}`));
  servers.push(child);
  const base = `http://127.0.0.1:${port}/api/v1`;
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return base;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server on ${port} did not come up`);
}

/* Stub Responses server: answers the structured formats by name and
 * everything else with a plain read — the same trick the pepper-chat
 * drills use, so the suite never touches the real provider. */
function startStub() {
  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* keep empty */ }
      const formatName = body?.text?.format?.name || '';
      let payload;
      if (formatName === 'pepper_photo_read') {
        payload = {
          read: 'The photo shows a refrigerator rating plate inside the door frame, plus the door gasket in the foreground.',
          plate_detected: true,
          brand: 'Frigidaire',
          model: 'FFTR1835VS',
          serial: 'BA12345678',
          appliance_type: 'Refrigerator',
          confidence: 0.93,
        };
      } else if (formatName === 'speedy_model_plate') {
        payload = {
          brand: 'Frigidaire', model: 'FFTR1835VS', serial: 'BA12345678',
          appliance_type: 'Refrigerator', fuel: 'Electric', confidence: 0.93,
        };
      } else {
        payload = null;
      }
      const out = payload
        ? { output_text: JSON.stringify(payload), model: 'gpt-4o-mini-stub' }
        : { output_text: 'Plain stub read of the photo.', model: 'gpt-4o-mini-stub' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', () => resolve(stub)));
}

async function recordCounts() {
  const [bookings, connections, reports] = await Promise.all([
    prisma.serviceRequest.count(),
    prisma.connection.count(),
    prisma.pepperReport.count(),
  ]);
  return { bookings, connections, reports };
}

async function main() {
  await cleanup();
  await seed();
  const stub = await startStub();

  /* ── Server A: provider NOT configured ─────────────────────── */
  const baseA = await boot(PORT_A, {});
  check('photo unauthenticated', (await api(baseA, '/pepper/photo', { method: 'POST', body: { imageDataUrl: JPEG_URL } })).status, 401);
  const customerA = await login(baseA, 'photo-customer@test.local');
  check('photo as customer is 403', (await api(baseA, '/pepper/photo', { token: customerA, method: 'POST', body: { imageDataUrl: JPEG_URL } })).status, 403);
  const staffA = await login(baseA, 'photo-staff@test.local');
  const unconfigured = await api(baseA, '/pepper/photo', { token: staffA, method: 'POST', body: { imageDataUrl: JPEG_URL } });
  check('photo without provider key is honest 503', unconfigured.status, 503);
  checkTrue('503 copy is honest about configuration', String(unconfigured.json?.error || '').includes('not configured'));

  /* ── Server B: stub provider ───────────────────────────────── */
  const baseB = await boot(PORT_B, { OPENAI_API_KEY: 'stub-key', OPENAI_API_BASE: `http://127.0.0.1:${STUB_PORT}` });
  const staffB = await login(baseB, 'photo-staff@test.local');
  const customerB = await login(baseB, 'photo-customer@test.local');

  const before = await recordCounts();
  const photo = await api(baseB, '/pepper/photo', {
    token: staffB, method: 'POST',
    body: { imageDataUrl: JPEG_URL, question: 'Read the plate on this fridge', context: '/tech' },
  });
  check('staff photo read 200', photo.status, 200);
  checkTrue('reply carries the natural-language read', String(photo.json?.data?.reply || '').includes('rating plate'));
  check('answeredBy labels the vision path', photo.json?.data?.answeredBy, 'ai-vision');
  check('provider is Pepper chat’s own (openai)', photo.json?.data?.provider, 'openai');
  check('model comes from the provider response', photo.json?.data?.model, 'gpt-4o-mini-stub');
  const plate = photo.json?.data?.plate || {};
  check('plate brand extracted', plate.brand, 'Frigidaire');
  check('plate model extracted', plate.model, 'FFTR1835VS');
  check('plate serial extracted', plate.serial, 'BA12345678');
  check('plate type is camelCase applianceType', plate.applianceType, 'Refrigerator');
  check('plate confidence carried', plate.confidence, 0.93);
  check('plate is marked DRAFT', plate.status, 'DRAFT');

  const after = await recordCounts();
  check('photo read created NO booking', after.bookings, before.bookings);
  check('photo read created NO connection record', after.connections, before.connections);
  check('photo read filed NO pepper report', after.reports, before.reports);

  check('photo as customer is 403 (configured server)', (await api(baseB, '/pepper/photo', { token: customerB, method: 'POST', body: { imageDataUrl: JPEG_URL } })).status, 403);
  check('missing photo is 400', (await api(baseB, '/pepper/photo', { token: staffB, method: 'POST', body: { question: 'no photo' } })).status, 400);
  const textBytes = await api(baseB, '/pepper/photo', { token: staffB, method: 'POST', body: { imageDataUrl: `data:image/jpeg;base64,${TEXT_B64}` } });
  check('text bytes labeled jpeg refused 400', textBytes.status, 400);
  const mislabeled = await api(baseB, '/pepper/photo', { token: staffB, method: 'POST', body: { imageDataUrl: `data:image/png;base64,${JPEG_B64}` } });
  check('jpeg bytes labeled png refused 400', mislabeled.status, 400);

  /* ── Plate-read draft envelope (additive regression) ───────── */
  const plateRead = await api(baseB, '/pepper-lists/plate-read', { token: customerB, method: 'POST', body: { imageDataUrl: JPEG_URL } });
  check('plate-read still 200', plateRead.status, 200);
  check('plate-read original plate shape intact', plateRead.json?.data?.plate?.appliance_type, 'Refrigerator');
  const draft = plateRead.json?.data?.draft || {};
  check('draft envelope brand', draft.brand, 'Frigidaire');
  check('draft envelope applianceType camelCase', draft.applianceType, 'Refrigerator');
  check('draft envelope fuel carried', draft.fuel, 'Electric');
  check('draft envelope confidence carried', draft.confidence, 0.93);
  check('draft envelope status', draft.status, 'DRAFT');
  check('draft envelope source', draft.source, 'speedy-plate-read');

  /* ── Server C: provider DOWN ───────────────────────────────── */
  const baseC = await boot(PORT_C, { OPENAI_API_KEY: 'stub-key', OPENAI_API_BASE: 'http://127.0.0.1:9' });
  const staffC = await login(baseC, 'photo-staff@test.local');
  const down = await api(baseC, '/pepper/photo', { token: staffC, method: 'POST', body: { imageDataUrl: JPEG_URL } });
  check('provider down is honest 502', down.status, 502);
  checkTrue('502 copy points at the chat fallback', String(down.json?.error || '').includes('describe it in the chat'));

  stub.close();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
}

main()
  .catch((error) => { console.error(error); failures += 1; })
  .finally(async () => {
    for (const s of servers) { try { s.kill('SIGTERM'); } catch { /* already down */ } }
    await cleanup().catch(() => {});
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  });

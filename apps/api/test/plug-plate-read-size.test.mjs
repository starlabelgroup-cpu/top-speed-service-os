/**
 * Appliance Plug plate read — REAL-SIZE photo drill (2026-11-20).
 *
 * Incident: Ramone's first real plate read on the tablet (Field Pro
 * plate screen -> POST /provider/assignments/:id/plate-read) failed
 * with a bare red "Internal server error". Root cause: the photo
 * routes' zod schemas accept imageDataUrl up to 12,000,000 chars, but
 * server.js only registered enlarged JSON body parsers for
 * /speedy/diagnose, /pepper-lists and /ad-studio/my-creatives — the
 * /provider plate-read + job-photo routes and /pepper/photo fell
 * through to the global 100kb parser, so EVERY real camera photo
 * (a 0.6-quality tablet JPEG is 1-4 MB) died in body-parser with
 * entity.too.large and the global error handler flattened it to
 * 500 {error:'Internal server error'}. Every earlier drill used a
 * ~200-byte 1x1 JPEG, so the limit was never exercised.
 *
 * This drill sends a REAL-SIZE photo (a valid JPEG padded with COM
 * segments to ~600 KB decoded / ~800 KB base64 — the size class of
 * an actual device capture) through the exact Field Pro sequence:
 *   A. No AI key: tiny plate-read 503 (handler reached); LARGE
 *      plate-read 503 (never 500); LARGE job photo attach 201;
 *      LARGE /pepper/photo 503; anon LARGE plate-read 401 (auth gate
 *      reached, not the parser); wrong password still 401.
 *   B. Stub provider: LARGE plate-read 200 with the plate + draft.
 *   C. Dead provider: LARGE plate-read 502 with the honest message,
 *      never "Internal server error".
 *   D. Beyond even the enlarged parser (>14 MB JSON): an honest 413
 *      "too large", never a bare 500.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... TEST_PORT=4471 node test/plug-plate-read-size.test.mjs
 * Exit code 0 = every check passed.
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
process.env.JWT_SECRET ||= 'plug-plate-size-test-secret';

const PORT_A = Number(process.env.TEST_PORT || 4471);
const PORT_B = PORT_A + 1;
const PORT_C = PORT_A + 2;
const STUB_PORT = PORT_A + 3;
const PASSWORD = 'test-pass-1234';

const CREW_CO = '81000000-0000-4000-8000-0000000000b1';
const CREW_PROV = '81000000-0000-4000-8000-0000000000b3';
const IDS = {
  tech: '81000000-0000-4000-8000-0000000000c1',
  staff: '81000000-0000-4000-8000-0000000000c2',
};
const EMAILS = { tech: 'plug-tech@test.local', staff: 'plug-staff@test.local' };

const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==';
const TINY_JPEG = `data:image/jpeg;base64,${TINY_JPEG_B64}`;

/* A REAL-SIZE valid JPEG: the tiny JPEG's bytes with COM (0xFFFE)
 * segments inserted before the EOI marker until the decoded size
 * reaches ~600 KB — the size class of a real tablet/phone capture.
 * Magic bytes and structure stay genuinely JPEG. */
function makeLargeJpeg(targetBytes = 600_000) {
  const raw = Buffer.from(TINY_JPEG_B64, 'base64');
  const eoi = raw.lastIndexOf(Buffer.from([0xff, 0xd9]));
  const head = raw.subarray(0, eoi);
  const tail = raw.subarray(eoi);
  const chunks = [head];
  let size = raw.length;
  while (size < targetBytes) {
    const segLen = Math.min(65_535, targetBytes - size + 4);
    const seg = Buffer.alloc(segLen);
    seg[0] = 0xff; seg[1] = 0xfe;
    seg.writeUInt16BE(segLen - 2, 2);
    seg.fill(0x41, 4);
    chunks.push(seg);
    size += segLen;
  }
  chunks.push(tail);
  return `data:image/jpeg;base64,${Buffer.concat(chunks).toString('base64')}`;
}
const LARGE_JPEG = makeLargeJpeg();
/* Beyond the enlarged parser AND the route schema: ~16 MB of base64. */
const HUGE_JPEG = `data:image/jpeg;base64,${'A'.repeat(16_000_000)}`;

const prisma = new PrismaClient();
const servers = [];
let failures = 0;

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

async function login(base, email, password = PASSWORD) {
  const { status, json } = await api(base, '/auth/login', { method: 'POST', body: { email, password } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'plug-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: CREW_CO },
    update: {},
    create: { id: CREW_CO, name: 'Plug Crew Co', slug: 'plug-crew-co', type: 'INDEPENDENT_PROVIDER' },
  });
  await prisma.provider.upsert({
    where: { id: CREW_PROV },
    update: { companyCrew: true },
    create: {
      id: CREW_PROV, companyId: CREW_CO, businessName: 'Plug Field Team', type: 'INDEPENDENT_PROVIDER',
      specialties: ['Refrigerator'], serviceCities: ['Fort Lauderdale'], companyCrew: true,
    },
  });
  await prisma.user.upsert({
    where: { id: IDS.tech },
    update: { passwordHash, verifyRequired: false, layer2Required: false },
    create: {
      id: IDS.tech, companyId: CREW_CO, email: EMAILS.tech, passwordHash,
      phone: '9545550110', roles: ['PROVIDER_TECH'], active: true,
    },
  });
  await prisma.user.upsert({
    where: { id: IDS.staff },
    update: { passwordHash },
    create: {
      id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: EMAILS.staff, passwordHash,
      phone: '9545550198', roles: ['COMPANY_ADMIN'], active: true,
    },
  });
}

async function cleanup() {
  try {
    await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } });
    await prisma.provider.deleteMany({ where: { id: CREW_PROV } });
    await prisma.company.deleteMany({ where: { id: CREW_CO } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function boot(port, extraEnv) {
  const env = { ...process.env, PORT: String(port), JWT_SECRET: 'plug-plate-size-test-secret', ...extraEnv };
  if (!('OPENAI_API_KEY' in extraEnv)) delete env.OPENAI_API_KEY;
  if (!('OPENAI_API_KEY_V2' in extraEnv)) delete env.OPENAI_API_KEY_V2;
  if (!('OPENAI_API_BASE' in extraEnv)) delete env.OPENAI_API_BASE;
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

function startStub() {
  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* keep empty */ }
      const formatName = body?.text?.format?.name || '';
      const payload = formatName === 'speedy_model_plate'
        ? { brand: 'Frigidaire', model: 'FFTR1835VS', serial: 'BA12345678', appliance_type: 'Refrigerator', fuel: 'Electric', confidence: 0.93 }
        : null;
      const out = payload
        ? { output_text: JSON.stringify(payload), model: 'gpt-4o-mini-stub' }
        : { output_text: 'Plain stub read.', model: 'gpt-4o-mini-stub' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', () => resolve(stub)));
}

async function main() {
  console.log(`payload sizes: tiny=${TINY_JPEG.length} chars, large=${LARGE_JPEG.length} chars, huge=${HUGE_JPEG.length} chars`);
  checkTrue('large payload exceeds the old 100kb global parser', LARGE_JPEG.length > 102_400);
  await cleanup();
  await seed();
  const stub = await startStub();

  /* ── A: no AI key — the handler must be REACHED, never a 500 ── */
  const baseA = await boot(PORT_A, {});
  check('A wrong password still 401', (await api(baseA, '/auth/login', { method: 'POST', body: { email: EMAILS.tech, password: 'wrong-password-1' } })).status, 401);
  const tech = await login(baseA, EMAILS.tech);
  const staff = await login(baseA, EMAILS.staff);
  const created = await api(baseA, '/provider/work-orders', {
    token: tech, method: 'POST',
    body: {
      customer: { name: 'Plug Drill Customer', phone: '9545550199', address: '100 Drill Way' },
      city: 'Fort Lauderdale', zip: '33301', segment: 'RESIDENTIAL',
      appliance: 'Refrigerator', issue: 'Not cooling', assign: 'SELF',
    },
  });
  check('A work order created ACCEPTED', created.status, 201);
  const jobId = created.json.data.assignment.id;

  const tinyRead = await api(baseA, `/provider/assignments/${jobId}/plate-read`, { token: tech, method: 'POST', body: { imageDataUrl: TINY_JPEG } });
  check('A tiny plate-read reaches the handler (503 unconfigured)', tinyRead.status, 503);

  const largeRead = await api(baseA, `/provider/assignments/${jobId}/plate-read`, { token: tech, method: 'POST', body: { imageDataUrl: LARGE_JPEG } });
  check('A LARGE plate-read reaches the handler (503, never 500)', largeRead.status, 503);
  checkTrue('A LARGE plate-read error is the honest unconfigured message', String(largeRead.json?.error || '').includes('not configured'));

  const anonLarge = await api(baseA, `/provider/assignments/${jobId}/plate-read`, { method: 'POST', body: { imageDataUrl: LARGE_JPEG } });
  check('A anon LARGE plate-read hits the auth gate (401, never 500)', anonLarge.status, 401);

  const photo = await api(baseA, `/provider/assignments/${jobId}/photos`, { token: tech, method: 'POST', body: { category: 'BEFORE', dataUrl: LARGE_JPEG, caption: 'Rating plate — Appliance Plug' } });
  check('A LARGE job photo attach succeeds (201)', photo.status, 201);

  /* Field Pro job-screen photos: quality 0.7 with NO dimension cap,
   * so a tablet capture is ~3 MB decoded / ~4 MB base64. Same drill
   * at that size, plus the read-back the app does after uploading. */
  const FIELDPRO_JPEG = makeLargeJpeg(3_000_000);
  const fpPhoto = await api(baseA, `/provider/assignments/${jobId}/photos`, { token: tech, method: 'POST', body: { category: 'DURING', dataUrl: FIELDPRO_JPEG } });
  check('A Field-Pro-size job photo attach succeeds (201)', fpPhoto.status, 201);
  const full = await api(baseA, `/provider/assignments/${jobId}/full`, { token: tech });
  check('A /full loads after photo uploads', full.status, 200);
  const photosOnRecord = full.json?.data?.photos || full.json?.data?.booking?.photos || [];
  checkTrue('A uploaded photos are on the job record', photosOnRecord.length >= 2 || (fpPhoto.json?.data?.photos || []).length >= 2);

  const pepperPhoto = await api(baseA, '/pepper/photo', { token: staff, method: 'POST', body: { imageDataUrl: LARGE_JPEG } });
  check('A LARGE /pepper/photo reaches the handler (503, never 500)', pepperPhoto.status, 503);

  const plRead = await api(baseA, '/pepper-lists/plate-read', { token: staff, method: 'POST', body: { imageDataUrl: LARGE_JPEG } });
  check('A LARGE /pepper-lists/plate-read still reaches the handler (503)', plRead.status, 503);

  /* ── B: stub provider — the full read succeeds at real size ── */
  const baseB = await boot(PORT_B, { OPENAI_API_KEY: 'stub-key', OPENAI_API_BASE: `http://127.0.0.1:${STUB_PORT}` });
  const techB = await login(baseB, EMAILS.tech);
  const read = await api(baseB, `/provider/assignments/${jobId}/plate-read`, { token: techB, method: 'POST', body: { imageDataUrl: LARGE_JPEG } });
  check('B LARGE plate-read succeeds (200)', read.status, 200);
  check('B plate brand read', read.json?.data?.plate?.brand, 'Frigidaire');
  check('B plate model read', read.json?.data?.plate?.model, 'FFTR1835VS');
  check('B draft envelope present', read.json?.data?.draft?.model, 'FFTR1835VS');

  /* ── C: dead provider — honest 502, never a bare 500 ── */
  const baseC = await boot(PORT_C, { OPENAI_API_KEY: 'stub-key', OPENAI_API_BASE: 'http://127.0.0.1:9' });
  const techC = await login(baseC, EMAILS.tech);
  const dead = await api(baseC, `/provider/assignments/${jobId}/plate-read`, { token: techC, method: 'POST', body: { imageDataUrl: LARGE_JPEG } });
  check('C LARGE plate-read with dead provider is 502', dead.status, 502);
  checkTrue('C 502 message is the honest retake message', String(dead.json?.error || '').includes('could not read that plate'));
  checkTrue('C never says Internal server error', !String(dead.json?.error || '').includes('Internal server error'));

  /* ── D: beyond every limit — honest 413, never a bare 500 ── */
  const huge = await api(baseA, `/provider/assignments/${jobId}/plate-read`, { token: tech, method: 'POST', body: { imageDataUrl: HUGE_JPEG } });
  check('D HUGE plate-read is an honest 413', huge.status, 413);
  checkTrue('D 413 message says the upload is too large', /too large/i.test(String(huge.json?.error || '')));

  stub.close();
  for (const s of servers) s.kill('SIGTERM');
  await cleanup();
  await prisma.$disconnect();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  for (const s of servers) s.kill('SIGTERM');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

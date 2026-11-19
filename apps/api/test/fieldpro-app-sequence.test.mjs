/**
 * Field Pro mobile app — API-contract drill (2026-11-19).
 *
 * Exercises the EXACT request sequence the Expo app makes
 * (src/lib/api.ts in top-speed-field-pro), in the app's order:
 *
 *  A. Unflagged COMPANY tech: login -> /auth/me -> /provider/me
 *     (COMPANY) -> POST /provider/work-orders (assign SELF) ->
 *     GET /provider/overview?limit=200 -> GET assignments/:id/full ->
 *     checklist PUT -> job-status -> notes -> diagnosis -> estimate
 *     (server money) -> estimate/decision -> invoice -> receipts
 *     (incl. the 409 overpay with balanceDueCents) -> warranty +
 *     warranty-claim -> parts-finder + parts order + status ->
 *     knowledge -> company -> profile GET/PATCH -> complete.
 *  B. Flagged NETWORK tech with Layer 2 on: login 403
 *     SPEEDY_VERIFY_NO_CODE -> Master issues a code (row insert,
 *     the ApplianceMan action) -> login challenge -> wrong code 401
 *     -> verify -> LAYER2_REQUIRED -> layer2/send -> layer2/verify
 *     -> token sv:true -> /provider/me NETWORK -> work order ->
 *     complete-before-gate 409 with the missing list.
 *  C. Honest-unavailable paths with no AI key locally: plate-read
 *     and ai-diagnosis/preview answer 503, never a fake result.
 *  D. CORS: the Field Pro web origin is allowed; a foreign origin
 *     is not. Anon calls to gated provider routes answer 401.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/fieldpro-app-sequence.test.mjs
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
process.env.JWT_SECRET = 'fieldpro-' + 'drill-secret';

const PORT = Number(process.env.TEST_PORT || 4439);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const CODE = '13572468';
const LAYER2_CODE = '445566';
const FIELD_PRO_ORIGIN = 'https://top-speed-field-pro.vercel.app';

const CREW_CO = '80000000-0000-4000-8000-0000000000b1';
const NET_CO = '80000000-0000-4000-8000-0000000000b2';
const CREW_PROV = '80000000-0000-4000-8000-0000000000b3';
const NET_PROV = '80000000-0000-4000-8000-0000000000b4';
const IDS = {
  crewTech: '80000000-0000-4000-8000-0000000000c1',
  netTech: '80000000-0000-4000-8000-0000000000c2',
};
const EMAILS = {
  crewTech: 'fp-crew@test.local',
  netTech: 'fp-net@test.local',
};
// 1x1 JPEG (valid magic bytes) for the photo + plate-read payloads.
const TINY_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==';

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

async function api(path, { token, method = 'GET', body, headers } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json, headers: res.headers };
}
function decode(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'fp-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: CREW_CO },
    update: {},
    create: { id: CREW_CO, name: 'FieldPro Crew Co', slug: 'fp-crew-co', type: 'INDEPENDENT_PROVIDER' },
  });
  await prisma.company.upsert({
    where: { id: NET_CO },
    update: {},
    create: { id: NET_CO, name: 'FieldPro Network Co', slug: 'fp-net-co', type: 'INDEPENDENT_PROVIDER' },
  });
  await prisma.provider.upsert({
    where: { id: CREW_PROV },
    update: { companyCrew: true },
    create: {
      id: CREW_PROV, companyId: CREW_CO, businessName: 'FieldPro Field Team', type: 'INDEPENDENT_PROVIDER',
      specialties: ['Refrigerator'], serviceCities: ['Fort Lauderdale'], companyCrew: true,
    },
  });
  await prisma.provider.upsert({
    where: { id: NET_PROV },
    update: { companyCrew: false },
    create: {
      id: NET_PROV, companyId: NET_CO, businessName: 'FieldPro Network Provider', type: 'NETWORK_BUSINESS',
      specialties: ['Refrigerator'], serviceCities: ['Fort Lauderdale'], companyCrew: false,
    },
  });
  await prisma.user.upsert({
    where: { id: IDS.crewTech },
    update: { passwordHash, verifyRequired: false, layer2Required: false },
    create: {
      id: IDS.crewTech, companyId: CREW_CO, email: EMAILS.crewTech, passwordHash,
      phone: '9545550110', roles: ['PROVIDER_TECH'], active: true,
    },
  });
  await prisma.user.upsert({
    where: { id: IDS.netTech },
    update: { passwordHash, verifyRequired: true, layer2Required: true },
    create: {
      id: IDS.netTech, companyId: NET_CO, email: EMAILS.netTech, passwordHash,
      phone: '9545550111', roles: ['PROVIDER_TECH'], active: true, verifyRequired: true, layer2Required: true,
    },
  });
  await prisma.speedyVerifyCode.deleteMany({ where: { userId: IDS.netTech } });
}

async function cleanup() {
  try {
    const ids = Object.values(IDS);
    await prisma.loginChallenge.deleteMany({ where: { userId: { in: ids } } });
    await prisma.speedyVerifyCode.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.provider.deleteMany({ where: { id: { in: [CREW_PROV, NET_PROV] } } });
    await prisma.company.deleteMany({ where: { id: { in: [CREW_CO, NET_CO] } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not come up');
}

async function startServer() {
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: process.env.JWT_SECRET,
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_V2: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();
}

async function main() {
  await seed();
  await startServer();

  // ---------------- A. Company tech — the full field day ----------------
  const crewLogin = await api('/auth/login', { method: 'POST', body: { email: EMAILS.crewTech, password: PASSWORD } });
  check('A company: unflagged login issues a session directly', crewLogin.status, 200);
  const crew = crewLogin.json.token;
  checkTrue('A company: token present', crew);

  const crewMe = await api('/auth/me', { token: crew });
  check('A company: /auth/me validates the session', crewMe.status, 200);

  const crewProvider = await api('/provider/me', { token: crew });
  check('A company: /provider/me system', crewProvider.json.data.system, 'COMPANY');

  const created = await api('/provider/work-orders', {
    token: crew,
    method: 'POST',
    body: {
      customer: { name: 'Drill Customer', phone: '9545550199', address: '100 Drill Way' },
      city: 'Fort Lauderdale',
      zip: '33301',
      segment: 'RESIDENTIAL',
      appliance: 'Refrigerator',
      issue: 'Not cooling',
      assign: 'SELF',
    },
  });
  check('A company: create work order (assign SELF)', created.status, 201);
  const jobId = created.json.data.assignment.id;
  check('A company: self-assigned job lands ACCEPTED', created.json.data.assignment.status, 'ACCEPTED');

  const overview = await api('/provider/overview?limit=200', { token: crew });
  check('A company: overview loads', overview.status, 200);
  checkTrue('A company: job is on the accepted board', overview.json.data.accepted.some((r) => r.id === jobId));

  const full = await api(`/provider/assignments/${jobId}/full`, { token: crew });
  check('A job: /full loads the consolidated record', full.status, 200);
  check('A job: /full booking ref matches', full.json.data.booking.referenceCode, created.json.data.booking.referenceCode);
  checkTrue('A job: checklist carries the server template', full.json.data.checklist.length >= 5);
  const checklistIds = full.json.data.checklist.map((c) => c.id);

  const cl = await api(`/provider/assignments/${jobId}/checklist`, { token: crew, method: 'PUT', body: { doneIds: checklistIds } });
  check('A job: checklist PUT', cl.status, 200);

  const enRoute = await api(`/provider/assignments/${jobId}/job-status`, { token: crew, method: 'POST', body: { action: 'EN_ROUTE' } });
  check('A job: job-status EN_ROUTE', enRoute.status, 201);

  const note = await api(`/provider/assignments/${jobId}/notes`, { token: crew, method: 'POST', body: { text: 'Arrived, unit is a French-door fridge.' } });
  check('A job: note POST', note.status, 201);

  const photo = await api(`/provider/assignments/${jobId}/photos`, { token: crew, method: 'POST', body: { category: 'BEFORE', dataUrl: TINY_JPEG } });
  check('A job: photo POST (data URI)', photo.status, 201);

  const diag = await api(`/provider/assignments/${jobId}/diagnosis`, {
    token: crew,
    method: 'POST',
    body: {
      symptoms: 'Warm fridge, cold freezer',
      confirmedFault: 'Failed evaporator fan motor',
      recommendedRepair: 'Replace evaporator fan motor',
      applianceBrand: 'DrillBrand',
      model: 'DB-100',
      serial: 'SN123',
      safetyConfirmed: true,
    },
  });
  check('A job: diagnosis POST', diag.status, 201);

  const est = await api(`/provider/assignments/${jobId}/estimate`, {
    token: crew,
    method: 'POST',
    body: { kind: 'REPAIR', laborCents: 21000, parts: [{ description: 'Evaporator fan motor', qty: 1, unitPriceCents: 4500 }] },
  });
  check('A money: estimate POST', est.status, 201);
  check('A money: server total = labor 21000 + parts 4500 - diagnostic credit 9900', est.json.data.estimate.totalCents, 15600);
  check('A money: diagnostic fee line present', est.json.data.estimate.diagnosticFeeCents, 9900);
  check('A money: diagnostic credit applied', est.json.data.estimate.diagnosticCreditCents, 9900);

  const decision = await api(`/provider/assignments/${jobId}/estimate/decision`, {
    token: crew,
    method: 'POST',
    body: { decision: 'APPROVED', method: 'IN_PERSON_VERBAL', authorizedByName: 'Drill Customer' },
  });
  check('A money: estimate decision APPROVED', decision.status, 201);

  const invoice = await api(`/provider/assignments/${jobId}/invoice`, { token: crew, method: 'POST', body: {} });
  check('A money: invoice POST', invoice.status, 201);

  const overpay = await api(`/provider/assignments/${jobId}/receipts`, {
    token: crew,
    method: 'POST',
    body: { method: 'CASH', amountCents: 15601 },
  });
  check('A money: overpayment refused', overpay.status, 409);
  check('A money: 409 carries the balance due', overpay.json.balanceDueCents, 15600);

  const receipt = await api(`/provider/assignments/${jobId}/receipts`, {
    token: crew,
    method: 'POST',
    body: { method: 'CASH', amountCents: 15600 },
  });
  check('A money: exact receipt accepted', receipt.status, 201);

  const warranty = await api(`/provider/assignments/${jobId}/warranty`, {
    token: crew,
    method: 'POST',
    body: { provider: 'Drill Warranty Co', applianceType: 'Refrigerator', brand: 'DrillBrand', model: 'DB-100', serial: 'SN123' },
  });
  check('A job: warranty record POST', warranty.status, 201);

  const claim = await api(`/provider/assignments/${jobId}/warranty-claims`, {
    token: crew,
    method: 'POST',
    body: { description: 'Fan motor failed under warranty', warrantyProvider: 'Drill Warranty Co' },
  });
  check('A job: warranty claim POST', claim.status, 201);

  const finder = await api(`/provider/assignments/${jobId}/parts-finder`, {
    token: crew,
    method: 'POST',
    body: { brand: 'DrillBrand', model: 'DB-100', applianceType: 'Refrigerator' },
  });
  // Parts finder is Speedy-backed: with no AI key in this local env it
  // must answer the honest 503 (production has the key — verified live
  // 2026-11-17). The wiring + honest degradation are what is drilled.
  check('A parts: parts-finder honest 503 without Speedy locally', finder.status, 503);

  const order = await api(`/provider/assignments/${jobId}/parts-orders`, {
    token: crew,
    method: 'POST',
    body: {
      vendor: 'APPLIANCE_PLUS_PARTS_SUPPLY',
      appliance: { brand: 'DrillBrand', model: 'DB-100', applianceType: 'Refrigerator' },
      lines: [{ category: 'PART', qty: 1, fitmentNotes: 'DrillBrand DB-100' }],
    },
  });
  check('A parts: parts order POST', order.status, 201);
  const orderId = order.json.data.order.id;
  const advanced = await api(`/provider/assignments/${jobId}/parts-orders/${orderId}/status`, {
    token: crew,
    method: 'POST',
    body: { status: 'SENT_TO_PARTS_SUPPLY_OS' },
  });
  check('A parts: order advances one step', advanced.status, 200);

  const knowledge = await api('/provider/knowledge?q=refrigerator%20not%20cooling', { token: crew });
  check('A info: knowledge lookup answers', knowledge.status, 200);
  checkTrue('A info: knowledge returns results', knowledge.json.data.results.length >= 1);

  const company = await api('/provider/company', { token: crew });
  check('A info: company pricing repair labor flat', company.json.data.pricing.repairLaborFlat, 210);

  const customers = await api('/provider/customers?q=Drill', { token: crew });
  check('A info: customer lookup finds the drilled customer', customers.status, 200);
  checkTrue('A info: customer search hit', customers.json.data.some((c) => c.name === 'Drill Customer'));

  const profile = await api('/provider/profile', { token: crew });
  check('A settings: profile GET', profile.status, 200);
  const patched = await api('/provider/profile', {
    token: crew,
    method: 'PATCH',
    body: { vehicle: { year: '2024', make: 'Ford', model: 'Transit', color: 'White', plate: 'DRILL1' }, myAreas: ['Fort Lauderdale'] },
  });
  check('A settings: profile PATCH', patched.status, 200);
  check('A settings: vehicle saved server-side', patched.json.data.vehicle.plate, 'DRILL1');

  const complete = await api(`/provider/assignments/${jobId}/complete`, { token: crew, method: 'POST', body: {} });
  check('A job: complete passes the quality gate', complete.status, 200);

  // -------- B. Flagged network tech through Phase 3 + Layer 2 --------
  const noCode = await api('/auth/login', { method: 'POST', body: { email: EMAILS.netTech, password: PASSWORD } });
  check('B network: no code issued yet -> denied', noCode.status, 403);
  check('B network: denial code', noCode.json.code, 'SPEEDY_VERIFY_NO_CODE');

  // The Master's issue action (ApplianceMan) — a live code row appears.
  await prisma.speedyVerifyCode.upsert({
    where: { userId: IDS.netTech },
    update: { codeHash: await hashPassword(CODE), status: 'ACTIVE', failedAttempts: 0, lockedUntil: null },
    create: { userId: IDS.netTech, codeHash: await hashPassword(CODE), status: 'ACTIVE', issuedAt: new Date(), failedAttempts: 0 },
  });

  const challenged = await api('/auth/login', { method: 'POST', body: { email: EMAILS.netTech, password: PASSWORD } });
  check('B network: login stops at the code step', challenged.json.code, 'SPEEDY_VERIFY_REQUIRED');
  checkTrue('B network: challenge issued', challenged.json.challenge);

  const wrong = await api('/speedy-verify/verify', { method: 'POST', body: { challenge: challenged.json.challenge, code: '99999999' } });
  check('B network: wrong code refused', wrong.status, 401);
  check('B network: attempts remaining reported', wrong.json.attemptsRemaining, 4);

  const verified = await api('/speedy-verify/verify', { method: 'POST', body: { challenge: challenged.json.challenge, code: CODE } });
  check('B network: correct code moves to Layer 2', verified.json.code, 'LAYER2_REQUIRED');

  const sent = await api('/auth/layer2/send', { method: 'POST', body: { challenge: verified.json.challenge, channel: 'EMAIL' } });
  // No Resend/Twilio in this local env: send must answer the honest
  // 503 (channel not configured) rather than faking a delivery.
  // Production has Resend configured (verified 2026-11-18).
  check('B network: layer2/send honest 503 without a channel locally', sent.status, 503);

  // Simulate delivery of the 6-digit code (same technique as the
  // phase-3 suite): set the challenge's code hash to a known code.
  const payload = decode(verified.json.challenge);
  await prisma.loginChallenge.update({
    where: { id: payload.cid },
    data: { codeHash: await hashPassword(LAYER2_CODE), channel: 'EMAIL' },
  });
  const l2 = await api('/auth/layer2/verify', { method: 'POST', body: { challenge: verified.json.challenge, code: LAYER2_CODE } });
  check('B network: Layer 2 completion issues the session', l2.status, 200);
  check('B network: final token carries sv:true', decode(l2.json.token).sv, true);
  const net = l2.json.token;

  const netMe = await api('/provider/me', { token: net });
  check('B network: /provider/me system', netMe.json.data.system, 'NETWORK');

  const netJob = await api('/provider/work-orders', {
    token: net,
    method: 'POST',
    body: {
      customer: { name: 'Net Drill Customer', phone: '9545550198' },
      city: 'Davie',
      zip: '33314',
      segment: 'RESIDENTIAL',
      appliance: 'Washer',
      issue: 'Not draining',
      assign: 'SELF',
    },
  });
  check('B network: create work order (assign SELF)', netJob.status, 201);
  const netJobId = netJob.json.data.assignment.id;

  const earlyComplete = await api(`/provider/assignments/${netJobId}/complete`, { token: net, method: 'POST', body: {} });
  check('B network: completion gate refuses an undiagnosed job', earlyComplete.status, 409);
  checkTrue('B network: gate names what is missing', Array.isArray(earlyComplete.json.missing) && earlyComplete.json.missing.length >= 1);

  // -------- C. Honest-unavailable AI paths (no key in this env) --------
  const plate = await api(`/provider/assignments/${netJobId}/plate-read`, { token: net, method: 'POST', body: { imageDataUrl: TINY_JPEG } });
  check('C ai: plate-read without Speedy configured is an honest 503', plate.status, 503);
  const aiDraft = await api(`/provider/assignments/${netJobId}/ai-diagnosis/preview`, { token: net, method: 'POST', body: { text: 'washer not draining, humming' } });
  check('C ai: ai-diagnosis preview without Speedy is an honest 503', aiDraft.status, 503);

  // ------------------------ D. CORS + anon gates ------------------------
  const corsOk = await api('/health', { headers: { Origin: FIELD_PRO_ORIGIN } });
  check('D cors: Field Pro origin allowed', corsOk.headers.get('access-control-allow-origin'), FIELD_PRO_ORIGIN);
  const corsBad = await api('/health', { headers: { Origin: 'https://evil.example.com' } });
  checkTrue('D cors: foreign origin NOT allowed', corsBad.headers.get('access-control-allow-origin') !== 'https://evil.example.com');
  const preflight = await fetch(`${BASE}/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: FIELD_PRO_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization',
    },
  });
  check('D cors: preflight from the Field Pro origin allowed', preflight.headers.get('access-control-allow-origin'), FIELD_PRO_ORIGIN);

  const anonMe = await api('/provider/me');
  check('D gates: anon /provider/me', anonMe.status, 401);
  const anonOverview = await api('/provider/overview');
  check('D gates: anon /provider/overview', anonOverview.status, 401);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  return failures;
}

main()
  .then(async (failures) => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error('DRILL ERROR:', error);
    if (server) server.kill('SIGTERM');
    await cleanup().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });

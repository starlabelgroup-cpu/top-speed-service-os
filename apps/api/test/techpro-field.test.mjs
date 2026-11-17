/**
 * Tech Pro field workflow — verification harness (2026-11-17).
 *
 * Exercises the Top Speed Tech Pro guide build in routes/provider.js
 * end to end over HTTP: job-status field states, the structured
 * diagnosis, the field estimate (real Launch Pack math) + its
 * authorization log, categorized repair photos, van stock + allocate
 * to job, external receipts + running balance, and the close-out
 * QUALITY GATE (confirmed diagnosis + recommended repair + recorded
 * estimate authorization required; payment never blocks).
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... DATABASE_URL_UNPOOLED=postgresql://...
 *   node test/techpro-field.test.mjs
 * The harness seeds its own company/provider/user/part/booking,
 * boots the real API on TEST_PORT (default 4421), and cleans up.
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID, store } from '../src/data/store.js';
import { persistAssignment, persistBooking, persistCustomer } from '../src/db/bookingsRepo.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4421);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  providerCompany: '20000000-0000-4000-8000-0000000000d1',
  provider: '20000000-0000-4000-8000-0000000000d2',
  tech: '20000000-0000-4000-8000-0000000000d5',
  customer: '20000000-0000-4000-8000-0000000000d6',
  booking: '20000000-0000-4000-8000-0000000000d7',
  assignment: '20000000-0000-4000-8000-0000000000d8',
  part: '20000000-0000-4000-8000-0000000000d9',
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
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
  await prisma.company.upsert({
    where: { id: IDS.providerCompany },
    update: {},
    create: { id: IDS.providerCompany, name: 'TechPro Test Provider Co', slug: 'techpro-test-provider', type: 'INDEPENDENT_PROVIDER' },
  });
  await prisma.provider.upsert({
    where: { id: IDS.provider },
    update: {},
    create: { id: IDS.provider, companyId: IDS.providerCompany, businessName: 'TechPro Test Provider Co', type: 'INDEPENDENT_PROVIDER', specialties: [], serviceCities: [] },
  });
  await prisma.user.upsert({
    where: { id: IDS.tech },
    update: { passwordHash },
    create: { id: IDS.tech, companyId: IDS.providerCompany, email: 'techpro@test.local', passwordHash, phone: '9545550110', roles: ['PROVIDER_TECH'], active: true },
  });
  await prisma.part.upsert({
    where: { id: IDS.part },
    update: {},
    create: { id: IDS.part, sku: 'TEST-DRAIN-PUMP', name: 'Drain Pump (test)', category: 'Pumps', brand: 'TestBrand', unitCostCents: 2200, sellPriceCents: 4500, stockOnHand: 10, reorderPoint: 1, active: true },
  });

  const now = new Date().toISOString();
  const customer = {
    id: IDS.customer, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'Field Test Customer', phone: '9545550178', email: 'field-customer@test.local',
    address: '742 Test Terrace', city: 'Fort Lauderdale', zip: '33311', createdAt: now,
  };
  const booking = {
    id: IDS.booking, companyId: PLATFORM_COMPANY_ID, customerId: customer.id,
    customer, referenceCode: 'TS-TECH01', source: 'TEST',
    city: 'Fort Lauderdale', zip: '33311', appliance: 'Washer', issue: 'Not draining',
    preferredWindow: null, diagnosticFee: 99, diagnosticFeeCreditedTowRepair: true,
    diagnosticFeeCreditedTowardRepair: true, feeStatus: 'COLLECTED_AT_BOOKING',
    status: 'CONFIRMED',
    dispatch: { mode: 'HYBRID', stage: 'ASSIGNED', candidateProviderIds: [], assignmentIds: [IDS.assignment] },
    history: [], createdAt: now, updatedAt: now,
  };
  const assignment = {
    id: IDS.assignment, companyId: PLATFORM_COMPANY_ID, bookingId: booking.id,
    providerId: IDS.provider, providerCompanyId: IDS.providerCompany,
    status: 'APPROVED', dispatchMode: 'HYBRID', approvalRequired: true,
    approvedBy: 'Service Setters', approvedAt: now,
  };
  store.customers.set(customer.id, customer);
  store.bookings.set(booking.id, booking);
  store.dispatchAssignments.set(assignment.id, assignment);
  await persistCustomer(customer);
  await persistBooking(booking);
  await persistAssignment(assignment);
}

async function cleanup() {
  try {
    await prisma.vanStock.deleteMany({ where: { providerId: IDS.provider } });
    await prisma.partUsage.deleteMany({ where: { partId: IDS.part } });
    await prisma.part.deleteMany({ where: { id: IDS.part } });
    await prisma.dispatchAssignment.deleteMany({ where: { id: IDS.assignment } });
    await prisma.serviceRequest.deleteMany({ where: { id: IDS.booking } });
    await prisma.customer.deleteMany({ where: { id: IDS.customer } });
    await prisma.user.deleteMany({ where: { id: IDS.tech } });
    await prisma.provider.deleteMany({ where: { id: IDS.provider } });
    await prisma.company.deleteMany({ where: { id: IDS.providerCompany } });
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

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function main() {
  await seed();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'techpro-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  const A = `/provider/assignments/${IDS.assignment}`;
  const tech = await login('techpro@test.local');

  // Auth gating: no token, no service.
  check('van-stock unauthenticated', (await api('/provider/van-stock')).status, 401);
  check('workspace unauthenticated', (await api(`${A}/workspace`)).status, 401);

  // Accept the setter-approved offer.
  const accept = await api(`${A}/accept`, { token: tech, method: 'POST', body: {} });
  check('accept offer', accept.status, 200);
  check('assignment accepted', accept.json.data.status, 'ACCEPTED');

  // Field states: work started, awaiting parts.
  check('job-status WORK_STARTED', (await api(`${A}/job-status`, { token: tech, method: 'POST', body: { action: 'WORK_STARTED' } })).status, 201);
  check('job-status AWAITING_PARTS', (await api(`${A}/job-status`, { token: tech, method: 'POST', body: { action: 'AWAITING_PARTS' } })).status, 201);
  let ws = await api(`${A}/workspace`, { token: tech });
  check('workspace 200', ws.status, 200);
  check('flag awaitingParts set', ws.json.data.assignment.jobFlags.awaitingParts, true);
  check('flag workStarted set', ws.json.data.assignment.jobFlags.workStarted, true);

  // Quality gate: completion refused before diagnosis + authorization.
  const early = await api(`${A}/complete`, { token: tech, method: 'POST', body: {} });
  check('gate blocks early completion', early.status, 409);
  check('gate lists both missing', JSON.stringify(early.json.missing), JSON.stringify(['CONFIRMED_DIAGNOSIS', 'ESTIMATE_AUTHORIZATION']));
  check('gate starts closed', ws.json.data.gate.canComplete, false);

  // Structured diagnosis.
  const diag = await api(`${A}/diagnosis`, {
    token: tech, method: 'POST',
    body: {
      applianceBrand: 'TestBrand', model: 'TB-100', serial: 'SN123',
      symptoms: 'Washer fills but will not drain; humming at drain cycle',
      confirmedFault: 'Drain pump impeller jammed with debris',
      recommendedRepair: 'Replace drain pump and flush drain hose',
      readings: [{ label: 'Pump resistance', value: '12.4 ohm' }],
      testChecklist: [{ id: 'power', label: 'Power supply verified', done: true }],
      safetyConfirmed: true,
    },
  });
  check('diagnosis saved', diag.status, 201);
  ws = await api(`${A}/workspace`, { token: tech });
  check('workspace diagnosis fault', ws.json.data.diagnosis.confirmedFault, 'Drain pump impeller jammed with debris');
  check('gate diagnosis complete', ws.json.data.gate.diagnosisComplete, true);

  // Estimate: real structure math — 210 labor + 45 part + 7% tax on
  // parts (3.15) − 99 diagnostic credit = 159.15 → 15915 cents.
  const est = await api(`${A}/estimate`, {
    token: tech, method: 'POST',
    body: { kind: 'REPAIR', parts: [{ description: 'Drain pump', qty: 1, unitPriceCents: 4500 }], taxRatePercent: 7, discountCents: 0 },
  });
  check('estimate saved', est.status, 201);
  check('estimate labor', est.json.data.estimate.laborCents, 21000);
  check('estimate diagnostic credit', est.json.data.estimate.diagnosticCreditCents, 9900);
  check('estimate tax on parts', est.json.data.estimate.taxCents, 315);
  check('estimate total', est.json.data.estimate.totalCents, 15915);

  // Authorization requires the estimate; method is logged.
  const authz = await api(`${A}/estimate/authorize`, {
    token: tech, method: 'POST',
    body: { method: 'IN_PERSON_VERBAL', authorizedByName: 'Field Test Customer' },
  });
  check('authorization recorded', authz.status, 201);
  check('authorization log method', authz.json.data.authorizationLog[0].method, 'IN_PERSON_VERBAL');
  ws = await api(`${A}/workspace`, { token: tech });
  check('gate opens after authorization', ws.json.data.gate.canComplete, true);
  check('workspace estimateApproved', ws.json.data.estimateApproved, true);

  // Photos: categorize, list, remove.
  const photo = await api(`${A}/photos`, { token: tech, method: 'POST', body: { category: 'BEFORE', dataUrl: PNG_1PX, caption: 'Before — pump housing' } });
  check('photo added', photo.status, 201);
  const photoId = photo.json.data.photos[0].id;
  check('photo in workspace', (await api(`${A}/workspace`, { token: tech })).json.data.photos.length, 1);
  check('photo bad mime refused', (await api(`${A}/photos`, { token: tech, method: 'POST', body: { category: 'BEFORE', dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' } })).status, 400);
  const rm = await api(`${A}/photos/${photoId}/remove`, { token: tech, method: 'POST', body: {} });
  check('photo removed', rm.json.data.photos.length, 0);
  await api(`${A}/photos`, { token: tech, method: 'POST', body: { category: 'AFTER', dataUrl: PNG_1PX } });

  // Van stock: set, allocate to job, refuse over-allocation.
  const vs = await api('/provider/van-stock', { token: tech, method: 'POST', body: { partId: IDS.part, qty: 3 } });
  check('van stock set', vs.json.data.items.find((i) => i.partId === IDS.part)?.qty, 3);
  const used = await api(`${A}/parts-used`, { token: tech, method: 'POST', body: { partId: IDS.part, qty: 2 } });
  check('parts used recorded', used.status, 201);
  check('van decremented', used.json.data.vanStock.find((i) => i.partId === IDS.part)?.qty, 1);
  check('over-allocation refused', (await api(`${A}/parts-used`, { token: tech, method: 'POST', body: { partId: IDS.part, qty: 5 } })).status, 409);

  // Receipts + running balance (never a completion gate).
  const rc = await api(`${A}/receipts`, { token: tech, method: 'POST', body: { method: 'CASH', amountCents: 10000, note: 'Cash on site' } });
  check('receipt recorded', rc.status, 201);
  check('balance due', rc.json.data.payments.balanceDueCents, 5915);

  // Completion passes the gate with a balance still outstanding.
  const done = await api(`${A}/complete`, { token: tech, method: 'POST', body: { notes: 'Pump replaced, two test cycles OK' } });
  check('completion passes gate', done.status, 200);
  check('completion flag', done.json.data.completed, true);
  ws = await api(`${A}/workspace`, { token: tech });
  check('booking completed in workspace', ws.json.data.assignment.booking.status, 'COMPLETED');
  check('second completion refused', (await api(`${A}/complete`, { token: tech, method: 'POST', body: {} })).status, 409);

  // Public-route sanity after all router changes (shared-prefix trap).
  check('payments/status public', (await api('/payments/status')).status, 200);
  check('activity trail recorded', ws.json.data.activity.some((e) => e.type === 'JOB_COMPLETED'), true);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
  });

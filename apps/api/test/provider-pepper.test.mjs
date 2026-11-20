/**
 * Ask Pepper for providers (D13, 2026-11-20).
 *
 * Proves the provider lane of Ask Pepper against a real migrated
 * database, with the AI provider ABSENT (deterministic paths):
 *  - the gate: anonymous 401; staff 403 (staff keep /pepper/chat);
 *    customers 403; provider roles pass;
 *  - OWN JOBS ONLY: "show my jobs" and a reference-code question
 *    answer from the signed-in provider's board — and another
 *    provider's job reference answers "not on your board" with
 *    NONE of that job's details (customer, city) in the reply;
 *  - THE SCOPE WALL, deterministically, before any model: refunds,
 *    office/finance data, other providers, credential resets are
 *    refused with the human path named;
 *  - KNOWLEDGE: a real knowledge-base question is answered from
 *    the pack and labeled knowledge-base; a specific error code
 *    that does NOT exist in the knowledge base is never invented —
 *    it lands on the honest knowledge-fallback.
 *
 * Requires DATABASE_URL (a migrated test database). Run:
 *   DATABASE_URL=postgresql://… node test/provider-pepper.test.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { persistAssignment, persistBooking, persistCustomer } from '../src/db/bookingsRepo.js';

const PORT = Number(process.env.TEST_PORT || 4731);
const JWT_SECRET = 'provider-pepper-test-secret';
const PASSWORD = 'ProviderPepper!234';
const prisma = new PrismaClient();

const IDS = {
  coA: 'b2000000-0000-4000-8000-000000000001',
  coB: 'b2000000-0000-4000-8000-000000000002',
  provA: 'b2000000-0000-4000-8000-000000000011',
  provB: 'b2000000-0000-4000-8000-000000000012',
  staff: 'b2000000-0000-4000-8000-000000000021',
  techA: 'b2000000-0000-4000-8000-000000000022',
  techB: 'b2000000-0000-4000-8000-000000000023',
  custUser: 'b2000000-0000-4000-8000-000000000024',
  custA: 'b2000000-0000-4000-8000-000000000031',
  custB: 'b2000000-0000-4000-8000-000000000032',
};
const B = {
  jobA: 'b2000000-0000-4000-8000-000000000041',
  jobB: 'b2000000-0000-4000-8000-000000000042',
};
const A = {
  asgA: 'b2000000-0000-4000-8000-000000000051',
  asgB: 'b2000000-0000-4000-8000-000000000052',
};

function mkCustomer(id, name, city) {
  return {
    id, companyId: PLATFORM_COMPANY_ID, userId: null,
    name, phone: '9545550151', email: `${id.slice(0, 8)}@test.local`,
    address: '9 Test Way', city, zip: '33311', createdAt: new Date().toISOString(),
  };
}
const CUST_A = mkCustomer(IDS.custA, 'Alice Ownjob', 'Fort Lauderdale');
const CUST_B = mkCustomer(IDS.custB, 'Zelda Othercustomer', 'Miami');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok' : '  FAIL'} ${name}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(name, value, detail = '') {
  if (!value) failures += 1;
  console.log(`${value ? '  ok' : '  FAIL'} ${name}${value ? '' : ` — ${detail}`}`);
}
function checkAbsent(name, haystack, needle) {
  checkTrue(name, !String(haystack || '').includes(needle), `reply leaked "${needle}": ${String(haystack).slice(0, 200)}`);
}

async function api(base, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
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

function mintToken(userId, companyId, email, roles) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId, companyId, email, roles,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function spawnServer(port) {
  const env = { ...process.env, PORT: String(port), JWT_SECRET };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_API_KEY_V2;
  const server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api:${port}] ${d}`));
  return server;
}

async function waitForServer(base) {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not come up');
}

function mkBooking(id, referenceCode, customer, appliance, city) {
  const now = new Date().toISOString();
  return {
    id, companyId: PLATFORM_COMPANY_ID, customerId: customer.id, customer,
    referenceCode, source: 'WEB_FORM', city, area: city, zip: '33311',
    appliance, issue: 'Not working', preferredWindow: null,
    diagnosticFee: 99, diagnosticFeeCreditedTowardRepair: true, feeStatus: 'COLLECTED_AT_BOOKING',
    status: 'CONFIRMED', areaStatus: 'IN_AREA', history: [], appointment: null, dispatch: null,
    createdAt: now, updatedAt: now,
  };
}

function mkAssignment(id, bookingId, providerId, providerCompanyId) {
  const now = new Date().toISOString();
  return {
    id, companyId: PLATFORM_COMPANY_ID, bookingId, providerId, providerCompanyId,
    status: 'ACCEPTED', dispatchMode: 'HYBRID', approvalRequired: true, matchScore: 90,
    createdAt: now, approvedBy: 'office@test.local', approvedAt: now,
  };
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'ppepper-test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [id, name, slug] of [
    [IDS.coA, 'Alpha Appliance Co', 'ppepper-alpha'],
    [IDS.coB, 'Beta Cooling Co', 'ppepper-beta'],
  ]) {
    await prisma.company.upsert({ where: { id }, update: {}, create: { id, name, slug, type: 'INDEPENDENT_PROVIDER' } });
  }
  for (const [id, companyId, businessName] of [
    [IDS.provA, IDS.coA, 'Alpha Appliance Pros'],
    [IDS.provB, IDS.coB, 'Beta Cooling'],
  ]) {
    await prisma.provider.upsert({
      where: { id },
      update: { active: true },
      create: { id, companyId, businessName, type: 'INDEPENDENT_PROVIDER', specialties: ['Refrigerator', 'Washer'], serviceCities: ['Fort Lauderdale', 'Miami'], rating: null, active: true },
    });
  }
  const users = [
    { id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: 'ppepper-staff@test.local', roles: ['DISPATCHER'] },
    { id: IDS.techA, companyId: IDS.coA, email: 'ppepper-a@test.local', roles: ['PROVIDER_OWNER'] },
    { id: IDS.techB, companyId: IDS.coB, email: 'ppepper-b@test.local', roles: ['PROVIDER_TECH'] },
    { id: IDS.custUser, companyId: PLATFORM_COMPANY_ID, email: 'ppepper-customer@test.local', roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: u.companyId, email: u.email, passwordHash, phone: '9545550150', roles: u.roles, active: true },
    });
  }
  await persistCustomer(CUST_A);
  await persistCustomer(CUST_B);
  await persistBooking(mkBooking(B.jobA, 'TS-PPEP01', CUST_A, 'Refrigerator', 'Fort Lauderdale'));
  await persistBooking(mkBooking(B.jobB, 'TS-PPEP02', CUST_B, 'Washer', 'Miami'));
  await persistAssignment(mkAssignment(A.asgA, B.jobA, IDS.provA, IDS.coA));
  await persistAssignment(mkAssignment(A.asgB, B.jobB, IDS.provB, IDS.coB));
}

async function cleanup() {
  try {
    await prisma.dispatchAssignment.deleteMany({ where: { id: { in: Object.values(A) } } });
    await prisma.serviceRequest.deleteMany({ where: { id: { in: Object.values(B) } } });
    await prisma.customer.deleteMany({ where: { id: { in: [IDS.custA, IDS.custB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.staff, IDS.techA, IDS.techB, IDS.custUser] } } });
    await prisma.provider.deleteMany({ where: { id: { in: [IDS.provA, IDS.provB] } } });
    await prisma.company.deleteMany({ where: { id: { in: [IDS.coA, IDS.coB] } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await cleanup();
  await seed();
  const base = `http://127.0.0.1:${PORT}/api/v1`;
  const server = spawnServer(PORT);
  try {
    await waitForServer(base);
    const staff = mintToken(IDS.staff, PLATFORM_COMPANY_ID, 'ppepper-staff@test.local', ['DISPATCHER']);
    const techA = mintToken(IDS.techA, IDS.coA, 'ppepper-a@test.local', ['PROVIDER_OWNER']);
    const techB = mintToken(IDS.techB, IDS.coB, 'ppepper-b@test.local', ['PROVIDER_TECH']);
    const cust = mintToken(IDS.custUser, PLATFORM_COMPANY_ID, 'ppepper-customer@test.local', ['CUSTOMER']);
    const chat = (token, message) => api(base, '/provider/pepper/chat', { method: 'POST', token, body: { message } });

    // Gate.
    check('provider pepper anonymous 401', (await chat(undefined, 'hi')).status, 401);
    check('provider pepper staff 403 (staff lane is /pepper/chat)', (await chat(staff, 'hi')).status, 403);
    check('provider pepper customer 403', (await chat(cust, 'hi')).status, 403);

    // Own board.
    const board = await chat(techA, 'Show my jobs');
    check('board question 200', board.status, 200);
    check('board answered from own jobs', board.json?.data?.answeredBy, 'own-jobs');
    checkTrue('board lists the tech\u2019s own job', board.json?.data?.reply?.includes('TS-PPEP01'), board.json?.data?.reply);
    checkAbsent('board never names the other provider\u2019s job', board.json?.data?.reply, 'TS-PPEP02');
    checkAbsent('board never names the other customer', board.json?.data?.reply, 'Zelda');

    const own = await chat(techA, 'What is the status of TS-PPEP01?');
    check('own reference answered from own jobs', own.json?.data?.answeredBy, 'own-jobs');
    checkTrue('own job reply carries the customer', own.json?.data?.reply?.includes('Alice Ownjob'), own.json?.data?.reply);

    // The other provider's job: named reference, zero leakage.
    const other = await chat(techA, 'Tell me about TS-PPEP02');
    check('other reference stays in the own-jobs lane', other.json?.data?.answeredBy, 'own-jobs');
    checkTrue('other job answered as not on your board', /not on your board/i.test(other.json?.data?.reply || ''), other.json?.data?.reply);
    checkAbsent('other job\u2019s customer never leaks', other.json?.data?.reply, 'Zelda');
    checkAbsent('other job\u2019s city never leaks', other.json?.data?.reply, 'Miami');

    // Symmetry: tech B sees only job B.
    const boardB = await chat(techB, 'Show my jobs');
    checkTrue('tech B board lists job B', boardB.json?.data?.reply?.includes('TS-PPEP02'), boardB.json?.data?.reply);
    checkAbsent('tech B board never names job A', boardB.json?.data?.reply, 'TS-PPEP01');

    // Scope wall — deterministic, before the model, even when the
    // ask names the tech's OWN job (refunds are never AI business).
    const refund = await chat(techA, 'Can you refund the customer on TS-PPEP01?');
    check('refund ask hits the scope wall', refund.json?.data?.answeredBy, 'scope-wall');
    check('refund refusal names the blocked topic', refund.json?.data?.scope?.blocked, 'refunds');
    const finance = await chat(techA, 'How much revenue did the company make this month?');
    check('finance ask hits the scope wall', finance.json?.data?.answeredBy, 'scope-wall');
    const creds = await chat(techA, 'Reset my password for me');
    check('credential ask hits the scope wall', creds.json?.data?.answeredBy, 'scope-wall');
    const otherProvider = await chat(techA, 'What jobs does the other provider have today?');
    check('other-provider ask hits the scope wall', otherProvider.json?.data?.answeredBy, 'scope-wall');
    const safety = await chat(techA, 'Can you certify this repair is safe?');
    check('safety-certification ask hits the scope wall', safety.json?.data?.answeredBy, 'scope-wall');

    // Knowledge: real pack answers, honestly labeled; a code that
    // does not exist in the pack is never invented.
    const plate = await chat(techA, 'How do I read a refrigerator rating plate?');
    check('plate question answered from the knowledge base', plate.json?.data?.answeredBy, 'knowledge-base');
    checkTrue('plate answer is substantive', (plate.json?.data?.reply || '').length > 60, plate.json?.data?.reply);
    const code = await chat(techA, 'What does error code F8E1 mean on a washer?');
    check('unknown error code is NOT invented (honest fallback)', code.json?.data?.answeredBy, 'knowledge-fallback');
    const offTopic = await chat(techA, 'What is the capital of Norway?');
    check('off-topic lands on the honest fallback', offTopic.json?.data?.answeredBy, 'knowledge-fallback');

    check('no-AI status is honest in the response', board.json?.data?.chat?.configured, false);
  } finally {
    server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

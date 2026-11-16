/**
 * GET /bookings/:id access restriction — verification harness.
 *
 * Ramone's decision (2026-11-16): the full booking record (contact
 * details included) is readable ONLY by staff (STAFF_ROLES) and the
 * booking's own customer — where "own" uses the platform's existing
 * linkage (customer record userId, or the account email/phone matching
 * the contact details on the booking; commercial bookings embed the
 * business account's contact record, so a PM/business account matches
 * its own portfolio's jobs the same way). Everyone else signed-in gets
 * 403; signed-out stays 401.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://.../topspeed_service_os_test \
 *   DATABASE_URL_UNPOOLED=<same> \
 *   node test/bookings-access.test.mjs
 * The harness seeds its own companies/users/provider, boots the real
 * API on TEST_PORT (default 4417), exercises the matrix over HTTP, and
 * cleans up after itself. Exit code 0 = every check passed.
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

const PORT = Number(process.env.TEST_PORT || 4417);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  providerCompany: '20000000-0000-4000-8000-0000000000b1',
  provider: '20000000-0000-4000-8000-0000000000b2',
  staff: '20000000-0000-4000-8000-0000000000a1',
  ownerA: '20000000-0000-4000-8000-0000000000a2',
  otherB: '20000000-0000-4000-8000-0000000000a3',
  pm: '20000000-0000-4000-8000-0000000000a4',
  tech: '20000000-0000-4000-8000-0000000000a5',
  linkedCustomer: '20000000-0000-4000-8000-0000000000c1',
  linkedBooking: '20000000-0000-4000-8000-0000000000c2',
  linkedAssignment: '20000000-0000-4000-8000-0000000000c3',
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${actual}, want ${expected})`);
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
  const user = (id, companyId, email, phone, roles) => ({
    id, companyId, email, passwordHash, phone, roles, active: true,
  });
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: IDS.providerCompany },
    update: {},
    create: { id: IDS.providerCompany, name: 'Test Provider Co', slug: 'test-provider-co', type: 'INDEPENDENT_PROVIDER' },
  });
  await prisma.provider.upsert({
    where: { id: IDS.provider },
    update: {},
    create: { id: IDS.provider, companyId: IDS.providerCompany, businessName: 'Test Provider Co', type: 'INDEPENDENT_PROVIDER', specialties: [], serviceCities: [] },
  });
  const users = [
    user(IDS.staff, PLATFORM_COMPANY_ID, 'staff@test.local', '9545550100', ['DISPATCHER']),
    user(IDS.ownerA, PLATFORM_COMPANY_ID, 'owner-a@test.local', '9545550101', ['CUSTOMER']),
    user(IDS.otherB, PLATFORM_COMPANY_ID, 'other-b@test.local', '9545550102', ['CUSTOMER']),
    user(IDS.pm, PLATFORM_COMPANY_ID, 'pm@test.local', '9545550103', ['CUSTOMER']),
    user(IDS.tech, IDS.providerCompany, 'tech@test.local', '9545550104', ['PROVIDER_TECH']),
  ];
  for (const u of users) {
    await prisma.user.upsert({ where: { id: u.id }, update: { passwordHash, phone: u.phone, roles: u.roles }, create: u });
  }

  // A booking whose customer record is linked to owner A's account by
  // userId, while the contact email/phone on the booking are someone
  // else's (e.g. a household member who placed the call). Owner A must
  // still read it; nobody else may. The test provider is ASSIGNED to
  // this job — providers use their own workspace route, so the tech
  // must still be refused here.
  const now = new Date().toISOString();
  const linkedCustomer = {
    id: IDS.linkedCustomer, companyId: PLATFORM_COMPANY_ID, userId: IDS.ownerA,
    name: 'Household Contact', phone: '9545550177', email: 'linked-contact@test.local',
    city: 'Fort Lauderdale', zip: '33311', createdAt: now,
  };
  const linkedBooking = {
    id: IDS.linkedBooking, companyId: PLATFORM_COMPANY_ID, customerId: linkedCustomer.id,
    customer: linkedCustomer, referenceCode: 'TS-LINK01', source: 'API',
    city: 'Fort Lauderdale', zip: '33311', appliance: 'Washer', issue: 'Leaking underneath',
    preferredWindow: null, diagnosticFee: 99, diagnosticFeeCurrency: 'USD',
    diagnosticFeeCreditedTowardRepair: true, feeStatus: 'collected_at_booking',
    status: 'CONFIRMED',
    dispatch: { mode: 'HYBRID', stage: 'ASSIGNED', candidateProviderIds: [], assignmentIds: [IDS.linkedAssignment] },
    history: [], createdAt: now, updatedAt: now,
  };
  const linkedAssignment = {
    id: IDS.linkedAssignment, companyId: PLATFORM_COMPANY_ID, bookingId: linkedBooking.id,
    providerId: IDS.provider, providerCompanyId: IDS.providerCompany,
    status: 'ACCEPTED', dispatchMode: 'HYBRID', approvalRequired: true,
    approvedBy: 'Service Setters', approvedAt: now,
  };
  store.customers.set(linkedCustomer.id, linkedCustomer);
  store.bookings.set(linkedBooking.id, linkedBooking);
  store.dispatchAssignments.set(linkedAssignment.id, linkedAssignment);
  await persistCustomer(linkedCustomer);
  await persistBooking(linkedBooking);
  await persistAssignment(linkedAssignment);
}

async function cleanup() {
  try {
    await prisma.commercialWorkOrder?.deleteMany?.({}).catch(() => {});
    await prisma.commercialEquipment?.deleteMany?.({}).catch(() => {});
    await prisma.commercialFacility?.deleteMany?.({}).catch(() => {});
    await prisma.commercialAccount?.deleteMany?.({}).catch(() => {});
    await prisma.dispatchAssignment.deleteMany({ where: { id: IDS.linkedAssignment } });
    await prisma.serviceRequest.deleteMany({ where: { companyId: { in: [PLATFORM_COMPANY_ID, IDS.providerCompany] } } });
    await prisma.customer.deleteMany({ where: { companyId: { in: [PLATFORM_COMPANY_ID, IDS.providerCompany] } } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.staff, IDS.ownerA, IDS.otherB, IDS.pm, IDS.tech] } } });
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

async function main() {
  await seed();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'bookings-access-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  const staff = await login('staff@test.local');
  const ownerA = await login('owner-a@test.local');
  const otherB = await login('other-b@test.local');
  const pm = await login('pm@test.local');
  const tech = await login('tech@test.local');

  // Residential booking created through the real intake route; its
  // contact details match owner A's account email + phone.
  const created = await api('/bookings', {
    token: staff, method: 'POST',
    body: {
      customer: { name: 'Owner A', phone: '9545550101', email: 'owner-a@test.local', address: '123 Test Ave' },
      city: 'Fort Lauderdale', zip: '33311', appliance: 'Refrigerator', issue: 'Not cooling at all',
    },
  });
  check('setup: staff creates residential booking', created.status, 201);
  const bookingA = created.json.data.id;
  const refA = created.json.data.referenceCode;

  // Commercial booking through the real work-order flow; the booking's
  // customer record is the commercial account's contact (pm@test.local).
  const account = await api('/commercial/accounts', {
    token: staff, method: 'POST',
    body: { companyName: 'Test Bistro LLC', accountType: 'RESTAURANT', contactName: 'Pm Person', phone: '9545550199', email: 'pm@test.local', slaTier: 'ESSENTIAL' },
  });
  check('setup: staff creates commercial account', account.status, 201);
  const facility = await api(`/commercial/accounts/${account.json.data.id}/facilities`, {
    token: staff, method: 'POST',
    body: { name: 'Main Kitchen', address: '500 Test Blvd', zip: '33311' },
  });
  check('setup: staff creates facility', facility.status, 201);
  const workOrder = await api('/commercial/work-orders', {
    token: staff, method: 'POST',
    body: { accountId: account.json.data.id, facilityId: facility.json.data.id, issue: 'Walk-in cooler running warm' },
  });
  check('setup: staff creates work order (spawns booking)', workOrder.status, 201);
  const bookingC = workOrder.json.data.booking.id;

  const bogus = '99999999-9999-4999-8999-999999999999';

  // --- The restriction matrix: GET /bookings/:id ---
  check('signed-out -> 401', (await api(`/bookings/${bookingA}`)).status, 401);
  check('staff -> 200 (residential)', (await api(`/bookings/${bookingA}`, { token: staff })).status, 200);
  check('owning customer -> 200 (email+phone match)', (await api(`/bookings/${bookingA}`, { token: ownerA })).status, 200);
  const denied = await api(`/bookings/${bookingA}`, { token: otherB });
  check('unrelated customer -> 403', denied.status, 403);
  check('403 carries the neutral message', denied.json?.error, 'You do not have access to this booking');
  check('staff -> 200 (userId-linked booking)', (await api(`/bookings/${IDS.linkedBooking}`, { token: staff })).status, 200);
  check('owner via customer.userId link -> 200 (contact email/phone differ)', (await api(`/bookings/${IDS.linkedBooking}`, { token: ownerA })).status, 200);
  check('unrelated customer -> 403 (userId-linked booking)', (await api(`/bookings/${IDS.linkedBooking}`, { token: otherB })).status, 403);
  check('assigned provider tech -> 403 (tech app uses its workspace route, not this one)', (await api(`/bookings/${IDS.linkedBooking}`, { token: tech })).status, 403);
  check('PM/business account -> 200 (own commercial booking)', (await api(`/bookings/${bookingC}`, { token: pm })).status, 200);
  check('PM -> 403 (someone else\'s residential booking)', (await api(`/bookings/${bookingA}`, { token: pm })).status, 403);
  check('residential customer -> 403 (commercial booking)', (await api(`/bookings/${bookingC}`, { token: otherB })).status, 403);
  check('staff -> 404 (unknown id, unchanged)', (await api(`/bookings/${bogus}`, { token: staff })).status, 404);
  check('signed-out -> 401 (unknown id, unchanged)', (await api(`/bookings/${bogus}`)).status, 401);

  // --- Regressions: neighbouring flows unchanged ---
  check('public tracking ref+phone -> 200', (await api(`/bookings/track/${refA}?phone=9545550101`)).status, 200);
  check('public tracking wrong phone -> 403', (await api(`/bookings/track/${refA}?phone=9545559999`)).status, 403);
  check('setter queue (staff) -> 200', (await api('/bookos/setter-queue', { token: staff })).status, 200);
  check('tracking console (staff) -> 200', (await api('/tracking/console', { token: staff })).status, 200);
  const mine = await api('/tracking/mine', { token: ownerA });
  check('tracking/mine (owner) -> 200', mine.status, 200);
  check('tracking/mine includes the owner\'s booking', JSON.stringify(mine.json).includes(refA), true);
  check('connect summary (owner) -> 200', (await api('/connect/summary', { token: ownerA })).status, 200);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
}

main()
  .catch((error) => { console.error(error); failures += 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
